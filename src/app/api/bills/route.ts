import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { createBillFromSession, BillValidationError } from "@/lib/billing";

const INVALID_DATE = Symbol("invalid-date");

/**
 * Parse a date-range query value.
 *  - date-only "YYYY-MM-DD": start → 00:00:00.000Z, end → 23:59:59.999Z
 *    (so `to=2026-10-21` includes the whole day instead of excluding it)
 *  - anything else must be a parseable ISO timestamp.
 * Returns null when absent and INVALID_DATE when malformed.
 */
function parseDateRangeBound(
  raw: string | null,
  edge: "start" | "end",
): Date | null | typeof INVALID_DATE {
  if (raw === null || raw.trim() === "") return null;
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const suffix = edge === "end" ? "T23:59:59.999Z" : "T00:00:00.000Z";
    const date = new Date(`${value}${suffix}`);
    // Reject impossible calendar dates like 2026-02-30 (JS rolls them over).
    const roundTrip = date.toISOString().slice(0, 10);
    return roundTrip === value ? date : INVALID_DATE;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? INVALID_DATE : date;
}

/**
 * Phase 14 — bills (POS invoices).
 *
 * GET  /api/bills?status=&from=&to=&limit= — tenant-scoped bill list
 * POST /api/bills — create a bill from a table session's orders.
 *   Body: { tableSessionId?, orderIds?, couponCode?, customerId?,
 *           customerName?, customerPhone?, notes?, manualDiscountMinor?,
 *           manualDiscountReason?, idempotencyKey? }
 *   Manual discounts are audited against the acting user; coupons require a
 *   customer attachment (redemption history).
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "BILL_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const statuses = url.searchParams.getAll("status").filter((s) =>
      ["ISSUED", "PARTIALLY_PAID", "PAID", "PARTIALLY_REFUNDED", "REFUNDED", "VOID"].includes(s),
    );
    const sessionId = url.searchParams.get("sessionId");
    const fromRaw = url.searchParams.get("from");
    const toRaw = url.searchParams.get("to");

    // BUG FIX (2026-10-21, BUG_REPORT_NEW M-2): `from`/`to` were passed
    // straight to `new Date()` → Prisma. A malformed value produced an
    // Invalid Date, Prisma threw, and the endpoint answered 500 instead of
    // telling the client its filter was wrong. Dates are now validated and an
    // inverted range is rejected; a date-only `to` is inclusive for its day.
    const from = parseDateRangeBound(fromRaw, "start");
    const to = parseDateRangeBound(toRaw, "end");
    if (from === INVALID_DATE || to === INVALID_DATE) {
      return jsonError("from/to must be valid ISO dates (YYYY-MM-DD).", 400, "INVALID_DATE_RANGE");
    }
    if (from && to && from > to) {
      return jsonError("from must be before or equal to to.", 400, "INVALID_DATE_RANGE");
    }
    const limitRaw = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 50;

    const bills = await db.bill.findMany({
      where: {
        hotelId: auth.user.hotelId,
        ...(statuses.length > 0 ? { status: { in: statuses as never[] } } : {}),
        ...(sessionId ? { tableSessionId: sessionId } : {}),
        ...(from || to
          ? {
              issuedAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      orderBy: { issuedAt: "desc" },
      take: limit,
      select: {
        id: true,
        billNumber: true,
        series: true,
        status: true,
        tableSessionId: true,
        table: { select: { id: true, number: true, zone: true } },
        currency: true,
        subtotalMinor: true,
        discountMinor: true,
        taxMinor: true,
        totalMinor: true,
        paidMinor: true,
        refundMinor: true,
        couponCode: true,
        customerName: true,
        customerPhone: true,
        issuedAt: true,
        paidAt: true,
        issuedByUserId: true,
      },
    });
    return Response.json({ bills });
  } catch (err) {
    return serverError(err);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "BILL_CREATE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");

    const tableSessionId = typeof body.tableSessionId === "string" ? body.tableSessionId : null;
    const orderIds = Array.isArray(body.orderIds)
      ? (body.orderIds as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 100)
      : undefined;
    const manualDiscountMinor =
      typeof body.manualDiscountMinor === "number" && Number.isFinite(body.manualDiscountMinor)
        ? Math.max(0, Math.floor(body.manualDiscountMinor))
        : undefined;
    // Manual discount > 0 needs elevated rights: managers/owners hold
    // RESTAURANT_WRITE; the CASHIER role does not.
    if (manualDiscountMinor && manualDiscountMinor > 0) {
      const elevated = requirePermission(auth.user, "RESTAURANT_WRITE");
      if (elevated) {
        return jsonError(
          "Manual discounts beyond coupons require manager approval.",
          403,
          "FORBIDDEN",
        );
      }
    }

    try {
      const bill = await createBillFromSession({
        hotelId: auth.user.hotelId,
        issuedByUserId: auth.user.userId,
        tableSessionId,
        orderIds: orderIds && orderIds.length > 0 ? orderIds : undefined,
        couponCode: typeof body.couponCode === "string" ? body.couponCode : undefined,
        customerId: typeof body.customerId === "string" ? body.customerId : null,
        customerName: typeof body.customerName === "string" ? body.customerName : null,
        customerPhone: typeof body.customerPhone === "string" ? body.customerPhone : null,
        notes: typeof body.notes === "string" ? body.notes : null,
        manualDiscountMinor,
        manualDiscountReason:
          typeof body.manualDiscountReason === "string" ? body.manualDiscountReason : undefined,
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : null,
      });
      return Response.json({ bill }, { status: 201 });
    } catch (err) {
      if (err instanceof BillValidationError) {
        return jsonError(err.message, 422, err.code);
      }
      throw err;
    }
  } catch (err) {
    return serverError(err);
  }
}
