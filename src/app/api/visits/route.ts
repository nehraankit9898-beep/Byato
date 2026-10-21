import { db } from "@/lib/db";
import { requireAuth, jsonError, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";

/**
 * GET /api/visits — all visits for the hotel (newest first), with customer info.
 * Query: q (customer name/phone), from, to (dates), page, pageSize
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "VISIT_READ");
    if (denied) return denied;
    const { hotelId } = auth.user;

    const url = new URL(req.url);
    const q = (url.searchParams.get("q") || "").trim();
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(
      50,
      Math.max(5, parseInt(url.searchParams.get("pageSize") || "10", 10) || 10),
    );

    const where: Record<string, unknown> = { hotelId };
    if (q) {
      where.OR = [
        { customer: { name: { contains: q } } },
        { customer: { phone: { contains: q.replace(/[\s\-()+]/g, "") } } },
      ];
    }
    // BUG FIX (2026-10-21, BUG_REPORT_NEW L-4): an unparseable `from`/`to` was
    // silently DROPPED (the filter simply disappeared and the caller got the
    // unfiltered list with a 200). Malformed date filters are now rejected.
    if (from || to) {
      const parseBound = (raw: string, edge: "start" | "end"): Date | null => {
        const value = raw.trim();
        const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
        const date = new Date(dateOnly ? `${value}T${edge === "end" ? "23:59:59.999" : "00:00:00.000"}Z` : value);
        if (Number.isNaN(date.getTime())) return null;
        if (dateOnly && date.toISOString().slice(0, 10) !== value) return null;
        return date;
      };
      const gte = from ? parseBound(from, "start") : null;
      const lte = to ? parseBound(to, "end") : null;
      if ((from && !gte) || (to && !lte) || (gte && lte && gte > lte)) {
        return jsonError("from/to must be valid dates (YYYY-MM-DD) and from must not be after to.", 400, "INVALID_DATE_RANGE");
      }
      where.checkin = { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) };
    }

    const total = await db.visit.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const visits = await db.visit.findMany({
      where,
      orderBy: { checkin: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        customer: { select: { id: true, name: true, phone: true } },
      },
    });

    return Response.json({
      visits: visits.map((v) => ({
        id: v.id,
        customerId: v.customerId,
        customerName: v.customer.name,
        customerPhone: v.customer.phone,
        checkin: v.checkin,
        checkout: v.checkout,
        source: v.source,
        notes: v.notes,
        createdAt: v.createdAt,
      })),
      total,
      page,
      pageSize,
      totalPages,
    });
  } catch (err) {
    return serverError(err, "Could not load visits. Please try again.");
  }
}
