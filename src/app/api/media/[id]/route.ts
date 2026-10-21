import { db } from "@/lib/db";
import { jsonError, serverError } from "@/lib/api-helpers";
import { MENU_PHOTO_KIND } from "@/lib/media";

/**
 * GET /api/media/[id] — serve a stored menu photo.
 *
 * Photos on a QR menu are public by design (any diner who scans the code sees
 * them), so this endpoint is anonymous and therefore safe for <img>/next-image
 * to fetch. The id is a random UUID and the row is tenant-scoped by
 * construction; nothing about the owning restaurant is exposed beyond the
 * pixels, and a non-existent id is a plain 404.
 *
 * Responses are immutable: the bytes behind an id never change (a replacement
 * creates a NEW asset id), so the CDN/browser can cache for a year. An ETag
 * derived from the checksum makes conditional requests cheap.
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) return jsonError("Not found.", 404, "NOT_FOUND");

    const asset = await db.mediaAsset.findFirst({
      where: { id: id.toLowerCase(), kind: MENU_PHOTO_KIND },
      select: { id: true, mimeType: true, byteSize: true, checksum: true, data: true },
    });
    if (!asset) return jsonError("Not found.", 404, "NOT_FOUND");

    const etag = `"${asset.checksum}"`;
    const ifNoneMatch = req.headers.get("if-none-match");
    if (ifNoneMatch && ifNoneMatch.split(",").some((v) => v.trim() === etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "public, max-age=31536000, immutable" },
      });
    }

    const bytes = new Uint8Array(asset.data);

    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": asset.mimeType,
        "Content-Length": String(bytes.byteLength),
        // Immutable id → the payload for this URL can never change.
        // s-maxage lets the Vercel edge cache the function response (max-age
        // alone only governs the browser), so a photo is decoded from the
        // database once per edge, not once per diner.
        "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
        ETag: etag,
        // Never let a browser re-interpret an upload as HTML/JS, and keep it
        // inline (a photo must render, not download).
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `inline; filename="menu-photo-${asset.id}.webp"`,
        "Cross-Origin-Resource-Policy": "same-site",
      },
    });
  } catch (err) {
    return serverError(err, "The photo could not be loaded.");
  }
}
