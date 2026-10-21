import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { parsePromoDate, PROMO_DAYS, PROMO_TIME_RE, PROMO_TYPES } from "@/lib/promotions";

/**
 * Phase 15 — promotions (percent/flat/happy-hour/combo).
 *
 * GET  /api/promotions — list (PROMOTION_MANAGE or BILL_READ for POS)
 * POST /api/promotions — create { name, type, percentBps?|valueMinor?,
 *   itemIdsJson?/categoryIdsJson?, daysOfWeek?, startTime?, endTime?,
 *   startDate?, endDate?, priority?, stackable? }
 *
 * Server-side application only: bills freeze (promotionId, version, label).
 * Editing a promotion bumps `version` — issued invoices are NEVER rewritten.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "BILL_READ");
    if (denied) return denied;

    const promos = await db.promotion.findMany({
      where: { hotelId: auth.user.hotelId },
      orderBy: [{ active: "desc" }, { priority: "desc" }, { createdAt: "desc" }],
    });
    return Response.json({ promotions: promos });
  } catch (err) {
    return serverError(err);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "PROMOTION_MANAGE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 3) return jsonError("Promotion name is required (min 3 chars).", 422, "INVALID_NAME");
    const type = body.type;
    if (typeof type !== "string" || !PROMO_TYPES.includes(type as never)) {
      return jsonError(`type must be one of ${PROMO_TYPES.join(", ")}.`, 422, "INVALID_TYPE");
    }
    let percentBps: number | null = null;
    let valueMinor: number | null = null;
    if (type === "PERCENT" || type === "HAPPY_HOUR") {
      percentBps = Number(body.percentBps);
      if (!Number.isFinite(percentBps) || Math.floor(percentBps) !== percentBps || percentBps <= 0 || percentBps > 10_000) {
        return jsonError("percentBps must be 1..10000 (0.01%..100%).", 422, "INVALID_VALUE");
      }
    } else {
      valueMinor = Number(body.valueMinor);
      if (!Number.isFinite(valueMinor) || Math.floor(valueMinor) !== valueMinor || valueMinor <= 0) {
        return jsonError("valueMinor must be a positive integer (minor units).", 422, "INVALID_VALUE");
      }
    }
    let daysOfWeek: string | null = null;
    if (Array.isArray(body.daysOfWeek)) {
      const days = (body.daysOfWeek as unknown[]).filter((d): d is string => typeof d === "string" && PROMO_DAYS.includes(d as never));
      if (days.length > 0) daysOfWeek = JSON.stringify([...new Set(days)]);
    }
    let startTime: string | null = null;
    let endTime: string | null = null;
    if (type === "HAPPY_HOUR") {
      if (typeof body.startTime !== "string" || !PROMO_TIME_RE.test(body.startTime) || typeof body.endTime !== "string" || !PROMO_TIME_RE.test(body.endTime)) {
        return jsonError("Happy-hour promotions need startTime/endTime as HH:MM (hotel-local).", 422, "INVALID_WINDOW");
      }
      startTime = body.startTime;
      endTime = body.endTime;
    }
    // BUG FIX (2026-10-21): a date-only endDate used to be stored at 00:00Z,
    // so an offer "until 31 Dec" stopped applying at the START of the 31st.
    // End dates are now inclusive for the whole calendar day.
    const startParsed = parsePromoDate(body.startDate ?? null, "start");
    const endParsed = parsePromoDate(body.endDate ?? null, "end");
    if (!startParsed.ok || !endParsed.ok) {
      return jsonError("startDate/endDate must be valid dates.", 422, "INVALID_WINDOW");
    }
    const startDate = startParsed.date;
    const endDate = endParsed.date;
    if (startDate && endDate && endDate < startDate) {
      return jsonError("endDate must be after startDate.", 422, "INVALID_WINDOW");
    }

    const promo = await db.promotion.create({
      data: {
        hotelId: auth.user.hotelId!,
        name,
        type,
        percentBps,
        valueMinor,
        itemIdsJson: Array.isArray(body.itemIds) && body.itemIds.length > 0 ? JSON.stringify(body.itemIds) : null,
        categoryIdsJson: Array.isArray(body.categoryIds) && body.categoryIds.length > 0 ? JSON.stringify(body.categoryIds) : null,
        daysOfWeek,
        startTime,
        endTime,
        startDate,
        endDate,
        priority: typeof body.priority === "number" ? Math.floor(body.priority) : 0,
        stackable: body.stackable === true,
        createdByUserId: auth.user.userId,
      },
    });
    await logAudit({
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: "PROMOTION_CREATED",
      entityType: "Promotion",
      entityId: promo.id,
      metadata: { name, type },
      req,
    });
    return Response.json({ promotion: promo }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}
