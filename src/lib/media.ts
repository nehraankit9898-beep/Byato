/**
 * Menu photo storage — upload validation, processing and persistence.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `MenuItem.imageUrl` has existed since Phase 12, and `validateMenuItem()`
 * accepts `/api/media/...` references — but nothing ever served that path and
 * there was no upload endpoint at all. Owners could only paste an external
 * `https://` URL, which the production CSP (`img-src 'self' data: blob:`) then
 * refused to render. This module closes that gap.
 *
 * STORAGE CHOICE (requirement: persistent, production-compatible)
 * ---------------------------------------------------------------
 * Bytes are stored in PostgreSQL (Neon in production) via the `MediaAsset`
 * table, keyed by tenant, and served from the app at `/api/media/<id>`.
 * Nothing is written to the server's local filesystem, so the feature works
 * on Vercel's read-only/ephemeral serverless filesystem. Menu photos are
 * capped at 5 MB per upload and re-encoded to WebP at <=1600 px, so a full
 * 500-item catalog stays in the single-digit-hundreds-of-MB range.
 *
 * SECURITY
 * --------
 *  - The MIME type is derived from MAGIC BYTES, never from the request header
 *    or the client-declared file name.
 *  - Only JPEG / PNG / WebP are accepted. SVG (scriptable), GIF (animation
 *    abuse) and arbitrary binaries are rejected before decoding.
 *  - Decoding runs in sharp with `limitInputPixels`, so a decompression bomb
 *    is rejected instead of exhausting memory.
 *  - Re-encoding strips EXIF/GPS metadata (privacy) and produces a predictable
 *    WebP payload that can never be interpreted as HTML/JS.
 *  - Every read/write is scoped to the caller's `hotelId`; a media id that
 *    belongs to another tenant is indistinguishable from a missing one.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";

import { db } from "@/lib/db";

/** Maximum accepted upload size (bytes). */
export const MAX_MENU_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB
/** Refuse images above this pixel count before decoding them. */
export const MAX_MENU_PHOTO_PIXELS = 24_000_000; // 24 MP
/** Longest edge of the stored image. */
export const MAX_MENU_PHOTO_EDGE = 1600;
/** The only `MediaAsset.kind` value used for menu photos. */
export const MENU_PHOTO_KIND = "MENU_PHOTO";
/** Content type of every stored menu photo after re-encoding. */
export const STORED_PHOTO_MIME = "image/webp";

export const ACCEPTED_UPLOAD_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export type AcceptedUploadMime = (typeof ACCEPTED_UPLOAD_MIME)[number];

/**
 * Detect the image type from the first bytes of the payload.
 * Returns null for anything that is not a JPEG, PNG or WebP file — including
 * SVG, PDF, GIF, HTML, and executables.
 */
export function sniffImageMime(bytes: Uint8Array): AcceptedUploadMime | null {
  if (bytes.length < 12) return null;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => bytes[i] === b)) return "image/png";

  // WebP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

/** `/api/media/<uuid>` — the canonical URL stored on `MenuItem.imageUrl`. */
export function mediaUrlFor(id: string): string {
  return `/api/media/${id}`;
}

const MEDIA_URL_RE =
  /^\/api\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Extract the asset id from a managed media URL, or null for any other URL. */
export function parseMediaId(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const match = MEDIA_URL_RE.exec(url.trim());
  return match ? match[1].toLowerCase() : null;
}

/** True when the URL points at this app's managed media store. */
export function isManagedMediaUrl(url: string | null | undefined): boolean {
  return parseMediaId(url) !== null;
}

export type BinaryReadResult =
  { ok: true; bytes: Uint8Array } | { ok: false; reason: "empty" | "too_large" };

/**
 * Read a request body as bytes, enforcing the cap on bytes actually received.
 *
 * The Content-Length header is only a fast path — a chunked body with no
 * length is still counted and aborted as soon as it crosses the cap (the same
 * contract as `readBodyCapped`, but binary-safe; `readBodyCapped` UTF-8
 * decodes the payload and would corrupt image data).
 */
export async function readBinaryCapped(req: Request, maxBytes: number): Promise<BinaryReadResult> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "too_large" };
  if (!req.body) return { ok: false, reason: "empty" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }
  if (total === 0) return { ok: false, reason: "empty" };

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: merged };
}

export type MediaFailureCode = "EMPTY" | "TOO_LARGE" | "UNSUPPORTED_TYPE" | "INVALID_IMAGE";

export class MediaRejectedError extends Error {
  readonly code: MediaFailureCode;
  constructor(code: MediaFailureCode, message: string) {
    super(message);
    this.name = "MediaRejectedError";
    this.code = code;
  }
}

export interface ProcessedPhoto {
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
  checksum: string;
}

/**
 * Validate, re-encode and measure an uploaded image.
 *
 * `sharp` is given `limitInputPixels` so a malicious header cannot request a
 * multi-gigabyte decode. `rotate()` applies the EXIF orientation and metadata
 * is dropped by default, so GPS data never reaches the public menu.
 */
export async function processMenuPhoto(bytes: Uint8Array): Promise<ProcessedPhoto> {
  if (bytes.byteLength === 0) {
    throw new MediaRejectedError("EMPTY", "The uploaded file was empty.");
  }
  if (bytes.byteLength > MAX_MENU_PHOTO_BYTES) {
    throw new MediaRejectedError("TOO_LARGE", "Photos must be 5 MB or smaller.");
  }

  const sniffed = sniffImageMime(bytes);
  if (!sniffed) {
    throw new MediaRejectedError(
      "UNSUPPORTED_TYPE",
      "Upload a JPEG, PNG or WebP image. Other file types are not accepted.",
    );
  }

  try {
    const input = Buffer.from(bytes);
    const pipeline = sharp(input, {
      limitInputPixels: MAX_MENU_PHOTO_PIXELS,
      failOn: "error",
    });

    const metadata = await pipeline.metadata();
    if (!metadata.width || !metadata.height) {
      throw new MediaRejectedError("INVALID_IMAGE", "The image could not be read.");
    }
    if (metadata.width * metadata.height > MAX_MENU_PHOTO_PIXELS) {
      throw new MediaRejectedError("INVALID_IMAGE", "The image resolution is too large.");
    }

    const { data, info } = await pipeline
      .rotate()
      .resize({
        width: MAX_MENU_PHOTO_EDGE,
        height: MAX_MENU_PHOTO_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 82, effort: 4 })
      .toBuffer({ resolveWithObject: true });

    return {
      data,
      mimeType: STORED_PHOTO_MIME,
      width: info.width,
      height: info.height,
      byteSize: data.byteLength,
      checksum: createHash("sha256").update(data).digest("hex"),
    };
  } catch (err) {
    if (err instanceof MediaRejectedError) throw err;
    throw new MediaRejectedError("INVALID_IMAGE", "The image could not be processed.");
  }
}

export interface StoredPhoto {
  id: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
}

/**
 * Persist a processed photo for a tenant.
 *
 * Identical bytes uploaded for the same tenant are de-duplicated (unique
 * `(hotelId, checksum, kind)`), so re-saving an item without changing its
 * photo never grows the database.
 */
export async function storeMenuPhoto(params: {
  hotelId: string;
  processed: ProcessedPhoto;
  createdBy?: string | null;
}): Promise<StoredPhoto> {
  const { hotelId, processed } = params;

  const existing = await db.mediaAsset.findFirst({
    where: { hotelId, checksum: processed.checksum, kind: MENU_PHOTO_KIND },
    select: { id: true, mimeType: true, width: true, height: true, byteSize: true },
  });
  if (existing) return { ...existing, url: mediaUrlFor(existing.id) };

  const created = await db.mediaAsset
    .create({
      data: {
        hotelId,
        kind: MENU_PHOTO_KIND,
        mimeType: processed.mimeType,
        byteSize: processed.byteSize,
        width: processed.width,
        height: processed.height,
        checksum: processed.checksum,
        // Prisma types `Bytes` as Uint8Array<ArrayBuffer>; a Node Buffer is
        // backed by ArrayBufferLike, so copy into a plain view.
        data: new Uint8Array(processed.data),
        createdBy: params.createdBy ?? null,
      },
      select: { id: true, mimeType: true, width: true, height: true, byteSize: true },
    })
    .catch(async (err: unknown) => {
      // Concurrent identical upload: the unique fence won — reuse that row.
      if ((err as { code?: string }).code === "P2002") {
        const winner = await db.mediaAsset.findFirst({
          where: { hotelId, checksum: processed.checksum, kind: MENU_PHOTO_KIND },
          select: { id: true, mimeType: true, width: true, height: true, byteSize: true },
        });
        if (winner) return winner;
      }
      throw err;
    });

  return { ...created, url: mediaUrlFor(created.id) };
}

/**
 * Delete a managed asset once no menu item in the tenant references it.
 *
 * A photo can legitimately be shared by two items (the API allows patching an
 * item to an already-owned media URL), so reference counting — not "delete on
 * replace" — decides when the bytes can go.
 */
export async function deleteMediaIfUnreferenced(
  hotelId: string,
  imageUrl: string | null | undefined,
): Promise<boolean> {
  const id = parseMediaId(imageUrl);
  if (!id) return false;

  const references = await db.menuItem.count({ where: { hotelId, imageUrl: mediaUrlFor(id) } });
  if (references > 0) return false;

  const removed = await db.mediaAsset.deleteMany({
    where: { id, hotelId, kind: MENU_PHOTO_KIND },
  });
  return removed.count > 0;
}

/**
 * Ownership check for an image reference supplied by a client.
 *
 * Non-managed URLs (external https links, legacy rows) are governed by
 * `validateMenuItem` and return true here. A managed `/api/media/<id>` URL is
 * accepted ONLY when the asset belongs to the caller's tenant — otherwise one
 * restaurant could display (or probe for) another restaurant's upload.
 */
export async function mediaReferenceBelongsToHotel(
  hotelId: string,
  imageUrl: string | null | undefined,
): Promise<boolean> {
  const id = parseMediaId(imageUrl);
  if (!id) return true;
  const asset = await db.mediaAsset.findFirst({
    where: { id, hotelId, kind: MENU_PHOTO_KIND },
    select: { id: true },
  });
  return Boolean(asset);
}
