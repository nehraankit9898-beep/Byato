import {
  DEFAULT_TIMEZONE,
  isValidTimeZone,
  recentZonedDays,
  zonedDayKey,
} from "@/lib/timezone-core";

export interface DashboardCustomerConsentInput {
  status: "ACTIVE" | "INACTIVE";
  marketingConsent: boolean;
  optOut: boolean;
}

export interface DashboardConsentStats {
  totalCustomers: number;
  marketingOptIn: number;
  optedOut: number;
  noConsent: number;
}

/** Build the consent metrics after the database has already counted each set. */
export function dashboardConsentStatsFromCounts(
  totalCustomers: number,
  marketingOptIn: number,
  optedOut: number,
): DashboardConsentStats {
  return {
    totalCustomers,
    marketingOptIn,
    optedOut,
    noConsent: totalCustomers - marketingOptIn - optedOut,
  };
}

/**
 * Dashboard consent metrics share one denominator: active customers.
 *
 * Inactive customer records are retained for audit/history, but they are not
 * part of the current CRM population or campaign reach. `optOut` is counted
 * independently from `marketingConsent` because a STOP/opt-out must remain
 * visible even when the consent flag was already false.
 */
export function computeDashboardConsentStats(
  customers: readonly DashboardCustomerConsentInput[],
): DashboardConsentStats {
  const active = customers.filter((customer) => customer.status === "ACTIVE");
  const marketingOptIn = active.filter(
    (customer) => customer.marketingConsent && !customer.optOut,
  ).length;
  const optedOut = active.filter((customer) => customer.optOut).length;

  return dashboardConsentStatsFromCounts(active.length, marketingOptIn, optedOut);
}

export interface VisitTrendRow {
  date: string;
  count: number;
}

/**
 * Build a fixed-length trend for the hotel's local calendar days.
 *
 * The database stores instants in UTC. Day membership must therefore be
 * evaluated in the hotel's IANA timezone, not in the server timezone and not
 * by parsing a date-only string in the browser.
 */
export function buildVisitTrend(
  visits: readonly { checkin: Date }[],
  now: Date,
  timezone: string | null | undefined,
  dayCount = 14,
): VisitTrendRow[] {
  const tz = isValidTimeZone(timezone) ? timezone : DEFAULT_TIMEZONE;
  const days = recentZonedDays(now, tz, dayCount);
  const byDate = new Map(days.map((day) => [day.date, 0]));

  for (const visit of visits) {
    const timestamp = visit.checkin.getTime();
    const first = days[0]?.start.getTime();
    const last = days[days.length - 1]?.end.getTime();
    if (first === undefined || last === undefined || timestamp < first || timestamp >= last) {
      continue;
    }
    const date = zonedDayKey(visit.checkin, tz);
    if (byDate.has(date)) byDate.set(date, (byDate.get(date) ?? 0) + 1);
  }

  return days.map((day) => ({ date: day.date, count: byDate.get(day.date) ?? 0 }));
}

/** Safely decode the persisted report-recipient JSON for dashboard rendering. */
export function parseReportRecipients(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((recipient): recipient is string => typeof recipient === "string")
      : [];
  } catch {
    return [];
  }
}
