import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { buildPromotionPatch } from "@/lib/promotions";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH  /api/promotions/[id] — edit (bumps version; issued bills keep their
 * snapshot) or toggle active. Body: partial fields or { active: boolean }.
 * DELETE /api/promotions/[id] — archive (deactivate). Bills that reference
 * the promotion keep their frozen snapshot rows.
 *
 * BUG FIX (2026-10-21): `type`, `daysOfWeek`, `itemIds`, `categoryIds`,
 * `startDate` and `endDate` were accepted by the API contract but SILENTLY
 * DROPPED by this handler — the response was 200 with an incremented version
 * while the requested edit was never saved. Validation/payload building now
 * lives in `buildPromotionPatch` (shared, unit-tested rules).
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "PROMOTION_MANAGE");
    if (denied) return denied;

    const { id } = await ctx.params;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");

    const existing = await db.promotion.findFirst({ where: { id, hotelId: auth.user.hotelId } });
    if (!existing) return jsonError("Promotion not found.", 404, "NOT_FOUND");

    const patch = buildPromotionPatch(existing, body);
    if (!patch.ok) return jsonError(patch.message, 422, patch.code);

    const promo = await db.promotion.update({
      where: { id },
      data: { ...patch.data, version: { increment: 1 } },
    });
    await logAudit({
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: "PROMOTION_UPDATED",
      entityType: "Promotion",
      entityId: id,
      metadata: { name: promo.name, version: promo.version, fields: Object.keys(patch.data) },
      req,
    });
    return Response.json({ promotion: promo });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "PROMOTION_MANAGE");
    if (denied) return denied;

    const { id } = await ctx.params;
    const existing = await db.promotion.findFirst({ where: { id, hotelId: auth.user.hotelId } });
    if (!existing) return jsonError("Promotion not found.", 404, "NOT_FOUND");

    // Archive, never hard-delete: bills reference promotion snapshots.
    const promo = await db.promotion.update({ where: { id }, data: { active: false, version: { increment: 1 } } });
    await logAudit({
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: "PROMOTION_ARCHIVED",
      entityType: "Promotion",
      entityId: id,
      metadata: { name: promo.name },
      req,
    });
    return Response.json({ promotion: promo });
  } catch (err) {
    return serverError(err);
  }
}
