import { db } from "@/lib/db";
import { requireAuth, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { buildVisitTrend, dashboardConsentStatsFromCounts } from "@/lib/dashboard";
import { DEFAULT_TIMEZONE, isValidTimeZone, recentZonedDays } from "@/lib/timezone";

/**
 * GET /api/dashboard/stats — ALL numbers computed live from the database.
 * No hardcoded statistics.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "ANALYTICS_READ");
    if (denied) return denied;
    const { hotelId } = auth.user;

    const hotel = await db.hotel.findUnique({
      where: { id: hotelId },
      select: { timezone: true },
    });
    const timezone = isValidTimeZone(hotel?.timezone) ? hotel.timezone : DEFAULT_TIMEZONE;
    const now = new Date();
    const trendDays = recentZonedDays(now, timezone, 14);

    const [totalCustomers, marketingOptIn, optedOut, totalVisits, visitGroups] = await Promise.all([
      db.customer.count({ where: { hotelId, status: "ACTIVE" } }),
      db.customer.count({
        where: { hotelId, marketingConsent: true, optOut: false, status: "ACTIVE" },
      }),
      db.customer.count({ where: { hotelId, optOut: true, status: "ACTIVE" } }),
      db.visit.count({ where: { hotelId } }),
      db.visit.groupBy({ by: ["customerId"], where: { hotelId }, _count: { _all: true } }),
    ]);

    const consent = dashboardConsentStatsFromCounts(totalCustomers, marketingOptIn, optedOut);
    const uniqueVisitors = visitGroups.length;
    const repeatCustomers = visitGroups.filter((g) => g._count._all >= 2).length;

    // Visits over the last 14 hotel-local calendar days (for trend chart).
    const recentVisits = await db.visit.findMany({
      where: {
        hotelId,
        checkin: {
          gte: trendDays[0].start,
          lt: trendDays[trendDays.length - 1].end,
        },
      },
      select: { checkin: true },
      orderBy: { checkin: "asc" },
    });
    const visitsTrend = buildVisitTrend(recentVisits, now, timezone, 14);

    // Recent activity
    const [recentCustomers, recentVisitRows] = await Promise.all([
      db.customer.findMany({
        where: { hotelId, status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
        take: 5,
        // The dashboard only renders id/name/time; do not send phone or
        // consent fields to the browser when they are not needed.
        select: { id: true, name: true, createdAt: true },
      }),
      db.visit.findMany({
        where: { hotelId },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          createdAt: true,
          checkin: true,
          customer: { select: { id: true, name: true } },
        },
      }),
    ]);

    return Response.json({
      stats: {
        ...consent,
        totalVisits,
        uniqueVisitors,
        repeatCustomers,
        repeatRate: uniqueVisitors > 0 ? Math.round((repeatCustomers / uniqueVisitors) * 100) : 0,
      },
      visitsTrend,
      recentCustomers,
      recentVisits: recentVisitRows,
    });
  } catch (err) {
    return serverError(err, "Could not load dashboard statistics. Please refresh the page.");
  }
}
