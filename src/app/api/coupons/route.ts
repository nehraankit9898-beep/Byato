import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { normalizeCouponCode, generateCouponCode } from "@/lib/coupons";

/** GET /api/coupons — list coupons for the hotel */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "COUPON_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const activeOnly = url.searchParams.get("active") === "true";

    const coupons = await db.coupon.findMany({
      where: activeOnly
        ? { hotelId: auth.user.hotelId, active: true }
        : { hotelId: auth.user.hotelId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { redemptions: true } } },
    });

    return Response.json({
      coupons: coupons.map((c) => ({
        id: c.id,
        code: c.code,
        description: c.description,
        discountType: c.discountType,
        discountValue: c.discountValue,
        minimumOrder: c.minimumOrder,
        maximumDiscount: c.maximumDiscount,
        validFrom: c.validFrom?.toISOString() ?? null,
        validUntil: c.validUntil?.toISOString() ?? null,
        usageLimit: c.usageLimit,
        customerLimit: c.customerLimit,
        active: c.active,
        totalRedemptions: c.totalRedemptions,
        totalDiscount: c.totalDiscount,
        redemptionsCount: c._count.redemptions,
        createdAt: c.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return serverError(err, "Coupons could not be loaded. Please try again.");
  }
}

/** POST /api/coupons — create a coupon */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "COUPON_CREATE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const code = normalizeCouponCode(typeof body.code === "string" ? body.code : "");
    if (!code) return jsonError("Please enter a valid coupon code (letters and numbers only).");
    if (code.length < 4) return jsonError("Coupon code must be at least 4 characters long.");

    const existing = await db.coupon.findUnique({ where: { hotelId_code: { hotelId, code } } });
    if (existing) return jsonError("A coupon with this code already exists in your hotel.");

    const discountType = ["PERCENTAGE", "FIXED_AMOUNT", "CUSTOMER_SPECIFIC", "ONE_TIME"].includes(
      body.discountType as string,
    )
      ? (body.discountType as "PERCENTAGE" | "FIXED_AMOUNT" | "CUSTOMER_SPECIFIC" | "ONE_TIME")
      : "PERCENTAGE";
    // BUG FIX (2026-10-21, BUG_REPORT_NEW M-3): every numeric field went
    // through a bare `Number()`:
    //   · "abc" → NaN → Prisma threw → 500 (and NaN silently disabled limits);
    //   · a negative / NaN usageLimit made `usageLimit > 0` false, i.e. the cap
    //     was silently dropped → effectively unlimited redemptions;
    //   · an inverted validFrom > validUntil created an unusable coupon;
    //   · a maximumDiscount below a fixed discount silently truncated it.
    // Each field is now validated explicitly (422 with a precise message).
    const discountValue = Number(body.discountValue ?? 0);
    if (!Number.isFinite(discountValue) || discountValue < 0) {
      return jsonError("Discount value must be a non-negative number.", 422, "INVALID_DISCOUNT");
    }
    if (discountType === "PERCENTAGE" && discountValue > 100) {
      return jsonError("Percentage discount cannot exceed 100%.", 422, "INVALID_DISCOUNT");
    }

    /** Optional non-negative amount; undefined/null/"" → null. */
    const optionalAmount = (value: unknown): number | null | "INVALID" => {
      if (value === undefined || value === null || value === "") return null;
      const n = typeof value === "string" ? Number(value) : (value as number);
      return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : "INVALID";
    };
    /** Optional positive integer limit (0 = unlimited); null → default. */
    const optionalLimit = (value: unknown, fallback: number): number | "INVALID" => {
      if (value === undefined || value === null || value === "") return fallback;
      const n = Number(value);
      return Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? n : "INVALID";
    };
    const optionalDate = (value: unknown): Date | null | "INVALID" => {
      if (value === undefined || value === null || value === "") return null;
      if (typeof value !== "string") return "INVALID";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "INVALID" : date;
    };

    const minimumOrder = optionalAmount(body.minimumOrder);
    const maximumDiscount = optionalAmount(body.maximumDiscount);
    const usageLimit = optionalLimit(body.usageLimit, 0);
    const customerLimit = optionalLimit(body.customerLimit, 1);
    const validFrom = optionalDate(body.validFrom);
    const validUntil = optionalDate(body.validUntil);
    if (
      minimumOrder === "INVALID" ||
      maximumDiscount === "INVALID"
    ) {
      return jsonError(
        "minimumOrder/maximumDiscount must be non-negative amounts.",
        422,
        "INVALID_AMOUNT",
      );
    }
    if (usageLimit === "INVALID" || customerLimit === "INVALID") {
      return jsonError(
        "usageLimit/customerLimit must be whole numbers between 0 and 1000000 (0 = unlimited).",
        422,
        "INVALID_LIMIT",
      );
    }
    if (validFrom === "INVALID" || validUntil === "INVALID") {
      return jsonError("validFrom/validUntil must be valid dates.", 422, "INVALID_DATE");
    }
    if (validFrom && validUntil && validUntil <= validFrom) {
      return jsonError("validUntil must be after validFrom.", 422, "INVALID_DATE_RANGE");
    }
    if (
      maximumDiscount !== null &&
      (discountType === "FIXED_AMOUNT" || discountType === "CUSTOMER_SPECIFIC" || discountType === "ONE_TIME") &&
      maximumDiscount > 0 &&
      maximumDiscount < discountValue
    ) {
      return jsonError(
        "maximumDiscount is lower than the fixed discount value — redemptions would be truncated.",
        422,
        "INVALID_DISCOUNT",
      );
    }

    const coupon = await db.coupon.create({
      data: {
        hotelId,
        code,
        description:
          typeof body.description === "string" ? body.description.slice(0, 300) || null : null,
        discountType,
        discountValue,
        minimumOrder,
        maximumDiscount,
        validFrom,
        validUntil,
        usageLimit,
        customerLimit,
        active: body.active !== false,
      },
    });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.COUPON_ISSUED,
      entityType: "coupon",
      entityId: coupon.id,
      metadata: { code, discountType, discountValue },
    });

    return Response.json({ coupon }, { status: 201 });
  } catch (err) {
    return serverError(err, "Coupon could not be created. Please try again.");
  }
}

export { generateCouponCode };
