import { db } from "@/lib/db";
import { requireAuth, jsonError, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  MAX_MENU_PHOTO_BYTES,
  MediaRejectedError,
  deleteMediaIfUnreferenced,
  processMenuPhoto,
  readBinaryCapped,
  storeMenuPhoto,
} from "@/lib/media";

/**
 * POST   /api/menu/items/[id]/photo — upload / replace a food photo
 * DELETE /api/menu/items/[id]/photo — remove the photo (falls back to the
 *                                     neutral placeholder)
 *
 * Uploads are sent as a RAW image body (Content-Type: image/jpeg|png|webp),
 * not multipart: there is no filename or form field to parse, the byte cap is
 * enforced on the bytes actually received, and the type is re-derived from the
 * magic bytes server-side. An item photo is therefore replaced atomically —
 * one request, one new asset, one updated row.
 *
 * Authorization: MENU_MANAGE (owner / admin / manager — the same permission
 * that governs item configuration; KITCHEN_STAFF and WAITER cannot change
 * photos). Every lookup is tenant-scoped, so another restaurant's item id is
 * a 404, indistinguishable from a missing item.
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const DECLARED_TYPE_REJECT = "Upload a JPEG, PNG or WebP image.";

export async function POST(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "MENU_MANAGE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;

    const { id } = await ctx.params;
    const item = await db.menuItem.findFirst({
      where: { id, hotelId },
      select: { id: true, imageUrl: true },
    });
    if (!item) return jsonError("Menu item not found.", 404, "NOT_FOUND");

    // Cheap abuse damping per tenant before any decoding work happens.
    const burst = await checkRateLimit(`menu-photo:${hotelId}`, 40, 60 * 1000);
    if (!burst.allowed) {
      return jsonError(
        "Too many photo uploads. Please wait a minute and try again.",
        429,
        "RATE_LIMITED",
      );
    }

    // The declared type is only a fast reject; the real decision is made from
    // the payload's magic bytes inside processMenuPhoto().
    const declared = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (declared && !["image/jpeg", "image/png", "image/webp"].includes(declared)) {
      return jsonError(DECLARED_TYPE_REJECT, 415, "UNSUPPORTED_MEDIA_TYPE");
    }

    const read = await readBinaryCapped(req, MAX_MENU_PHOTO_BYTES);
    if (!read.ok) {
      if (read.reason === "too_large") {
        return jsonError("Photos must be 5 MB or smaller.", 413, "PAYLOAD_TOO_LARGE");
      }
      return jsonError("Choose an image file to upload.", 400, "VALIDATION_ERROR");
    }

    let processed;
    try {
      processed = await processMenuPhoto(read.bytes);
    } catch (err) {
      if (err instanceof MediaRejectedError) {
        const status = err.code === "TOO_LARGE" ? 413 : err.code === "UNSUPPORTED_TYPE" ? 415 : 400;
        return jsonError(err.message, status, err.code);
      }
      throw err;
    }

    const stored = await storeMenuPhoto({ hotelId, processed, createdBy: userId });

    // Tenant-scoped update; the count guards against the item being archived
    // or moved between the lookup and the write.
    const updated = await db.menuItem.updateMany({
      where: { id: item.id, hotelId },
      data: { imageUrl: stored.url },
    });
    if (updated.count !== 1) return jsonError("Menu item not found.", 404, "NOT_FOUND");

    // The previous photo (if it was ours) is released once nothing else in the
    // tenant still points at it.
    const previous = item.imageUrl;
    if (previous && previous !== stored.url) {
      await deleteMediaIfUnreferenced(hotelId, previous).catch(() => false);
    }

    return Response.json(
      {
        media: {
          id: stored.id,
          url: stored.url,
          width: stored.width,
          height: stored.height,
          byteSize: stored.byteSize,
          mimeType: stored.mimeType,
        },
        item: {
          id: item.id,
          imageUrl: stored.url,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return serverError(err, "The photo could not be uploaded.");
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "MENU_MANAGE");
    if (denied) return denied;
    const { hotelId } = auth.user;

    const { id } = await ctx.params;
    const item = await db.menuItem.findFirst({
      where: { id, hotelId },
      select: { id: true, imageUrl: true },
    });
    if (!item) return jsonError("Menu item not found.", 404, "NOT_FOUND");

    if (item.imageUrl) {
      await db.menuItem.updateMany({ where: { id: item.id, hotelId }, data: { imageUrl: null } });
      await deleteMediaIfUnreferenced(hotelId, item.imageUrl).catch(() => false);
    }

    return Response.json({ ok: true, item: { id: item.id, imageUrl: null } });
  } catch (err) {
    return serverError(err, "The photo could not be removed.");
  }
}
