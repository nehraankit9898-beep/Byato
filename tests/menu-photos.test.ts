/**
 * Food-photo management — end-to-end regression suite.
 *
 * Covers the full lifecycle of a menu photo:
 *   upload -> preview-ready URL -> replace -> remove -> placeholder
 * plus the security boundaries that make it safe to expose:
 *   - MENU_MANAGE is required (HOTEL_STAFF and anonymous users are refused)
 *   - every route is tenant-scoped (another restaurant's item is a 404)
 *   - a managed media URL from ANOTHER tenant cannot be attached to an item
 *   - only JPEG / PNG / WebP bytes are accepted (magic-byte sniffing, so a
 *     renamed .svg / .gif / PDF is still rejected)
 *   - the 5 MB cap is enforced on received bytes
 *   - stored photos are re-encoded (WebP, <=1600 px) and served with immutable
 *     caching + nosniff, which is what makes the QR menu fast and safe
 *
 * The images used here are SYNTHETIC solid-colour frames generated in-memory
 * with sharp. No real food photograph is invented or committed, and the UI
 * shows a neutral placeholder (never a stock photo) when an item has none.
 */
import { describe, test, expect } from "bun:test";
import sharp from "sharp";

import {
  ADMIN_PASSWORD,
  HOTEL_A_ADMIN,
  HOTEL_B_ADMIN,
  HOTEL_A_STAFF,
  STAFF_PASSWORD,
  apiCall,
  login,
  testDb,
} from "./helpers";
import {
  MAX_MENU_PHOTO_BYTES,
  isManagedMediaUrl,
  mediaUrlFor,
  parseMediaId,
  sniffImageMime,
} from "../src/lib/media";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3100";
const db = testDb();

type Jar = { cookie: string; csrf: string };

let xff = Math.floor(Math.random() * 150) + 40;

/** Register a dedicated tenant so plan/usage mutations in other suites cannot interfere. */
async function registerFreshHotel(suffix: string) {
  xff += 1;
  const email = `owner-photo-${suffix}@fresh-restroloop.test`;
  const res = await fetch(`${BASE}/api/hotels`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: BASE,
      "x-forwarded-for": `10.93.0.${xff}`,
    },
    body: JSON.stringify({
      hotelName: `Fresh Photo ${suffix}`,
      adminName: "Photo Owner",
      email,
      password: "FreshOwner123!",
    }),
  });
  if (res.status !== 201) throw new Error(`fresh hotel registration failed: ${res.status}`);
  return login(email, "FreshOwner123!");
}

const owner = await registerFreshHotel(String(Date.now()));
// HOTEL_A_* / HOTEL_B_* users come from the seeded harness database.
const staffJar = (await login(HOTEL_A_STAFF, STAFF_PASSWORD)).jar;
const adminAJar = (await login(HOTEL_A_ADMIN, ADMIN_PASSWORD)).jar;
const adminBJar = (await login(HOTEL_B_ADMIN, ADMIN_PASSWORD)).jar;

/**
 * undici accepts a Buffer body; the DOM `BodyInit` type does not model it.
 * One explicit cast here keeps every call site honest about what is sent.
 */
function rawBody(buffer: Buffer | Uint8Array): BodyInit {
  return buffer as unknown as BodyInit;
}

/** Raw-body photo upload (mirrors the browser client). */
async function uploadPhoto(
  jar: Jar,
  itemId: string,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/api/menu/items/${itemId}/photo`, {
    method: "POST",
    headers: {
      cookie: jar.cookie,
      "x-csrf-token": jar.csrf,
      "content-type": contentType,
    },
    body: rawBody(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function syntheticImage(
  format: "png" | "jpeg",
  width = 320,
  height = 200,
  colour: { r: number; g: number; b: number } = { r: 190, g: 110, b: 70 },
): Promise<Buffer> {
  const pipeline = sharp({
    create: { width, height, channels: 3, background: colour },
  });
  return format === "png" ? pipeline.png().toBuffer() : pipeline.jpeg({ quality: 90 }).toBuffer();
}

async function createItem(jar: Jar, categoryId: string, name: string) {
  const res = await apiCall("POST", "/api/menu/items", {
    jar,
    body: { categoryId, name, priceMinor: 24900, description: "Photo test dish" },
  });
  if (res.status !== 201)
    throw new Error(`item create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.item.id as string;
}

async function createCategory(jar: Jar, name: string) {
  const res = await apiCall("POST", "/api/menu/categories", { jar, body: { name } });
  if (res.status !== 201) throw new Error(`category create failed: ${res.status}`);
  return res.body.category.id as string;
}

const categoryId = await createCategory(owner.jar, "Photo Deck");
let itemId = await createItem(owner.jar, categoryId, "Synthetic Frame One");

describe("menu photo — format sniffing (DB-free)", () => {
  test("recognises JPEG, PNG and WebP magic bytes", async () => {
    expect(sniffImageMime(await syntheticImage("png"))).toBe("image/png");
    expect(sniffImageMime(await syntheticImage("jpeg"))).toBe("image/jpeg");
    const webp = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .webp()
      .toBuffer();
    expect(sniffImageMime(webp)).toBe("image/webp");
  });

  test("rejects SVG, GIF, PDF and plain text regardless of file name", () => {
    expect(
      sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
    ).toBeNull();
    expect(sniffImageMime(Buffer.from("GIF89a----"))).toBeNull();
    expect(sniffImageMime(Buffer.from("%PDF-1.7 ----"))).toBeNull();
    expect(sniffImageMime(Buffer.from("hello, not an image"))).toBeNull();
  });

  test("managed media URLs are parsed strictly", () => {
    const id = "3f1c9a54-6c67-4a53-9d38-5f1f2b0a7c11";
    expect(mediaUrlFor(id)).toBe(`/api/media/${id}`);
    expect(parseMediaId(mediaUrlFor(id))).toBe(id);
    expect(isManagedMediaUrl(mediaUrlFor(id))).toBe(true);
    expect(parseMediaId("/api/media/../etc/passwd")).toBeNull();
    expect(parseMediaId("https://cdn.example.com/food.jpg")).toBeNull();
    expect(isManagedMediaUrl(null)).toBe(false);
  });
});

describe("menu photo — upload, serve, replace, remove", () => {
  let firstUrl = "";
  let firstAssetId = "";

  test("owner uploads a PNG; it is stored as WebP and attached to the item", async () => {
    const png = await syntheticImage("png", 800, 600);
    const res = await uploadPhoto(owner.jar, itemId, png, "image/png");

    expect(res.status).toBe(201);
    expect(res.body.media.mimeType).toBe("image/webp");
    expect(res.body.media.width).toBe(800);
    expect(res.body.media.height).toBe(600);
    expect(res.body.media.byteSize).toBeGreaterThan(0);
    expect(isManagedMediaUrl(res.body.media.url)).toBe(true);

    firstUrl = res.body.media.url;
    firstAssetId = res.body.media.id;
    expect(res.body.item.imageUrl).toBe(firstUrl);

    const item = await db.menuItem.findUnique({ where: { id: itemId } });
    expect(item?.imageUrl).toBe(firstUrl);

    const asset = await db.mediaAsset.findUnique({ where: { id: firstAssetId } });
    expect(asset?.hotelId).toBe(item?.hotelId);
    expect(asset?.mimeType).toBe("image/webp");
    expect(asset?.byteSize).toBeGreaterThan(0);
    expect(asset?.kind).toBe("MENU_PHOTO");
  });

  test("the stored photo is publicly served with immutable caching and nosniff", async () => {
    const res = await fetch(`${BASE}${firstUrl}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(sniffImageMime(bytes)).toBe("image/webp");

    // Conditional request: the bytes behind an id never change, so 304 is safe.
    const conditional = await fetch(`${BASE}${firstUrl}`, { headers: { "if-none-match": etag! } });
    expect(conditional.status).toBe(304);
  });

  test("unknown and malformed media ids are 404 (no tenant probing)", async () => {
    expect((await fetch(`${BASE}/api/media/00000000-0000-4000-8000-000000000000`)).status).toBe(
      404,
    );
    expect((await fetch(`${BASE}/api/media/not-a-uuid`)).status).toBe(404);
  });

  test("an oversized upload is rejected with 413 before any decode", async () => {
    const oversized = Buffer.alloc(MAX_MENU_PHOTO_BYTES + 1024, 1);
    oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const res = await uploadPhoto(owner.jar, itemId, oversized, "image/png");
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("non-image payloads are rejected even when the declared type lies", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const asPng = await uploadPhoto(owner.jar, itemId, svg, "image/png");
    expect(asPng.status).toBe(415);
    expect(asPng.body.error.code).toBe("UNSUPPORTED_TYPE");

    const gif = Buffer.from("GIF89a" + "0".repeat(64));
    expect((await uploadPhoto(owner.jar, itemId, gif, "image/gif")).status).toBe(415);

    const text = await uploadPhoto(owner.jar, itemId, Buffer.from("plain text"), "text/plain");
    expect(text.status).toBe(415);

    const empty = await uploadPhoto(owner.jar, itemId, Buffer.alloc(0), "image/png");
    expect(empty.status).toBe(400);
  });

  test("a corrupt JPEG (valid magic, undecodable body) is rejected with 400", async () => {
    const corrupt = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(2048, 0x41),
    ]);
    const res = await uploadPhoto(owner.jar, itemId, corrupt, "image/jpeg");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_IMAGE");
  });

  test("a large photo is downscaled to 1600 px on the long edge and re-encoded", async () => {
    const big = await syntheticImage("jpeg", 2400, 1200, { r: 40, g: 90, b: 160 });
    const res = await uploadPhoto(owner.jar, itemId, big, "image/jpeg");
    expect(res.status).toBe(201);
    expect(res.body.media.width).toBe(1600);
    expect(res.body.media.height).toBe(800);
    expect(res.body.media.mimeType).toBe("image/webp");
    expect(res.body.media.byteSize).toBeLessThan(big.byteLength);

    // Replacing the photo releases the previous asset (nothing else uses it).
    expect(res.body.media.url).not.toBe(firstUrl);
    expect(await db.mediaAsset.findUnique({ where: { id: firstAssetId } })).toBeNull();
    expect((await fetch(`${BASE}${firstUrl}`)).status).toBe(404);

    firstUrl = res.body.media.url;
    firstAssetId = res.body.media.id;
  });

  test("re-uploading identical bytes de-duplicates instead of growing the table", async () => {
    const bytes = await syntheticImage("png", 400, 400, { r: 10, g: 10, b: 10 });
    const one = await uploadPhoto(owner.jar, itemId, bytes, "image/png");
    expect(one.status).toBe(201);
    const two = await uploadPhoto(owner.jar, itemId, bytes, "image/png");
    expect(two.status).toBe(201);
    expect(two.body.media.id).toBe(one.body.media.id);

    const rows = await db.mediaAsset.count({
      where: { id: one.body.media.id },
    });
    expect(rows).toBe(1);
    firstUrl = one.body.media.url;
    firstAssetId = one.body.media.id;
  });

  test("an item can be created with a photo in the same owner flow (create → upload)", async () => {
    const newItemId = await createItem(owner.jar, categoryId, "Synthetic Frame Two");
    const before = await db.menuItem.findUnique({ where: { id: newItemId } });
    expect(before?.imageUrl).toBeNull(); // placeholder until the photo lands

    const res = await uploadPhoto(
      owner.jar,
      newItemId,
      await syntheticImage("png", 200, 200, { r: 0, g: 120, b: 40 }),
      "image/png",
    );
    expect(res.status).toBe(201);
    const after = await db.menuItem.findUnique({ where: { id: newItemId } });
    expect(after?.imageUrl).toBe(res.body.media.url);
  });

  test("removing the photo clears the item and deletes the asset", async () => {
    const removed = await apiCall("DELETE", `/api/menu/items/${itemId}/photo`, { jar: owner.jar });
    expect(removed.status).toBe(200);
    expect(removed.body.item.imageUrl).toBeNull();

    const item = await db.menuItem.findUnique({ where: { id: itemId } });
    expect(item?.imageUrl).toBeNull();
    expect(await db.mediaAsset.findUnique({ where: { id: firstAssetId } })).toBeNull();
    expect((await fetch(`${BASE}${firstUrl}`)).status).toBe(404);
  });
});

describe("menu photo — authorization and tenant isolation", () => {
  let isolatedItemId = "";
  let sharedAssetUrl = "";

  test("seed a photo on the isolated tenant", async () => {
    isolatedItemId = await createItem(owner.jar, categoryId, "Synthetic Frame Three");
    const res = await uploadPhoto(
      owner.jar,
      isolatedItemId,
      await syntheticImage("png", 120, 120, { r: 90, g: 20, b: 90 }),
      "image/png",
    );
    expect(res.status).toBe(201);
    sharedAssetUrl = res.body.media.url;
  });

  test("anonymous visitors cannot upload or delete", async () => {
    const anon = await fetch(`${BASE}/api/menu/items/${isolatedItemId}/photo`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: rawBody(await syntheticImage("png")),
    });
    expect(anon.status).toBe(401);

    const anonDelete = await fetch(`${BASE}/api/menu/items/${isolatedItemId}/photo`, {
      method: "DELETE",
    });
    expect(anonDelete.status).toBe(401);
  });

  test("HOTEL_STAFF (MENU_READ only) is refused with 403", async () => {
    // Hotel A staff + a Hotel A item, so the refusal is about the PERMISSION,
    // not about tenant scoping.
    const catA = await createCategory(adminAJar, `Photo A ${Date.now()}`);
    const itemA = await createItem(adminAJar, catA, "Hotel A Frame");

    const res = await uploadPhoto(staffJar, itemA, await syntheticImage("png"), "image/png");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");

    const del = await apiCall("DELETE", `/api/menu/items/${itemA}/photo`, { jar: staffJar });
    expect(del.status).toBe(403);
  });

  test("another restaurant cannot upload to, replace or clear this item (404)", async () => {
    const upload = await uploadPhoto(
      adminBJar,
      isolatedItemId,
      await syntheticImage("png", 64, 64, { r: 1, g: 2, b: 3 }),
      "image/png",
    );
    expect(upload.status).toBe(404);

    const del = await apiCall("DELETE", `/api/menu/items/${isolatedItemId}/photo`, {
      jar: adminBJar,
    });
    expect(del.status).toBe(404);

    // Hotel B's attempt changed nothing.
    const item = await db.menuItem.findUnique({ where: { id: isolatedItemId } });
    expect(item?.imageUrl).toBe(sharedAssetUrl);
  });

  test("a foreign media URL cannot be attached through PATCH or create (400)", async () => {
    const catB = await createCategory(adminBJar, `Photo B ${Date.now()}`);
    const itemB = await createItem(adminBJar, catB, "Hotel B Frame");

    const patch = await apiCall("PATCH", `/api/menu/items/${itemB}`, {
      jar: adminBJar,
      body: { imageUrl: sharedAssetUrl },
    });
    expect(patch.status).toBe(400);
    expect(patch.body.error.message).toMatch(/does not belong/i);

    const create = await apiCall("POST", "/api/menu/items", {
      jar: adminBJar,
      body: {
        categoryId: catB,
        name: "Hotel B Copied Frame",
        priceMinor: 10000,
        imageUrl: sharedAssetUrl,
      },
    });
    expect(create.status).toBe(400);

    // The foreign asset is untouched and still belongs to the other tenant.
    const asset = await db.mediaAsset.findFirst({ where: { id: parseMediaId(sharedAssetUrl)! } });
    expect(asset).toBeTruthy();
  });

  test("a photo shared by two items in the SAME tenant survives the first removal", async () => {
    const secondItem = await createItem(owner.jar, categoryId, "Synthetic Frame Four");
    const link = await apiCall("PATCH", `/api/menu/items/${secondItem}`, {
      jar: owner.jar,
      body: { imageUrl: sharedAssetUrl },
    });
    expect(link.status).toBe(200);

    const assetId = parseMediaId(sharedAssetUrl)!;
    expect(await db.mediaAsset.findUnique({ where: { id: assetId } })).toBeTruthy();

    // Removing it from the FIRST item must keep the bytes: item two still uses them.
    const firstRemoval = await apiCall("DELETE", `/api/menu/items/${isolatedItemId}/photo`, {
      jar: owner.jar,
    });
    expect(firstRemoval.status).toBe(200);
    expect(await db.mediaAsset.findUnique({ where: { id: assetId } })).toBeTruthy();
    expect((await fetch(`${BASE}${sharedAssetUrl}`)).status).toBe(200);

    // Removing it from the last referencing item releases the bytes.
    const secondRemoval = await apiCall("DELETE", `/api/menu/items/${secondItem}/photo`, {
      jar: owner.jar,
    });
    expect(secondRemoval.status).toBe(200);
    expect(await db.mediaAsset.findUnique({ where: { id: assetId } })).toBeNull();
    expect((await fetch(`${BASE}${sharedAssetUrl}`)).status).toBe(404);
  });
});

describe("menu photo — public QR menu and responsive presentation", () => {
  test("the public menu exposes the uploaded photo URL and null for items without one", async () => {
    const withPhoto = await createItem(owner.jar, categoryId, "Synthetic Public Frame");
    const noPhoto = await createItem(owner.jar, categoryId, "Synthetic Public No Photo");

    const uploaded = await uploadPhoto(
      owner.jar,
      withPhoto,
      await syntheticImage("png", 300, 200, { r: 120, g: 80, b: 20 }),
      "image/png",
    );
    expect(uploaded.status).toBe(201);

    const qr = await apiCall("POST", "/api/qr-codes", {
      jar: owner.jar,
      body: { type: "MENU", label: "Photo menu" },
    });
    expect(qr.status).toBe(201);
    const code = qr.body.qrCode.code as string;

    const menu = await fetch(`${BASE}/api/public/menu/${code}`);
    expect(menu.status).toBe(200);
    const payload = await menu.json();
    const items = (payload.categories ?? []).flatMap((c: any) => c.items ?? []);
    const shown = items.find((i: any) => i.id === withPhoto);
    const blank = items.find((i: any) => i.id === noPhoto);

    expect(shown?.imageUrl).toBe(uploaded.body.media.url);
    expect(shown?.name).toBe("Synthetic Public Frame");
    expect(shown?.available).toBe(true);
    expect(typeof shown?.priceMinor).toBe("number");
    expect(blank?.imageUrl).toBeNull();
  });

  test("public cards use responsive next/image and an honest placeholder (source contract)", async () => {
    const src = await Bun.file("src/components/public/menu-client.tsx").text();
    // Responsive delivery: next/image with fill + sizes gives a srcset.
    expect(src).toContain('from "next/image"');
    expect(src).toContain("<Image");
    expect(src).toContain("sizes=");
    // No invented food: the empty state is a neutral label, not a stock photo.
    expect(src).toContain("No photo yet");
    expect(src).toContain("Photo unavailable");
    // The card still carries the required commerce fields and action.
    expect(src).toContain("Add to cart");
    expect(src).toContain("Choose options");
    expect(src).toContain("Sold out");
  });

  test("owner UI exposes upload, replace, remove and the placeholder", async () => {
    const src = await Bun.file("src/components/app/menu-view.tsx").text();
    expect(src).toContain("Upload photo");
    expect(src).toContain("Replace photo");
    expect(src).toContain("Remove");
    expect(src).toContain("No photo");
    expect(src).toContain("api.upload");
    expect(src).toContain('accept={PHOTO_ACCEPT.join(",")}');
    // A legacy/external URL that CSP blocks degrades to the placeholder
    // instead of a broken-image icon.
    expect(src).toContain("onError={() => setFailed(true)}");
    expect(src).toContain("<Thumb");
  });
});
