/** Dashboard regression tests: deterministic metric and calendar contracts plus UI/API guard rails. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildVisitTrend,
  computeDashboardConsentStats,
  dashboardConsentStatsFromCounts,
  parseReportRecipients,
} from "../src/lib/dashboard";
import { formatDateKey } from "../src/lib/format";
import { isValidDateKey, recentZonedDays, zonedDayBounds } from "../src/lib/timezone";

const ROOT = join(import.meta.dir, "..");

function source(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

describe("dashboard consent metrics", () => {
  test("use active customers as one consistent denominator", () => {
    const stats = computeDashboardConsentStats([
      { status: "ACTIVE", marketingConsent: true, optOut: false },
      { status: "ACTIVE", marketingConsent: false, optOut: false },
      { status: "ACTIVE", marketingConsent: false, optOut: true },
      // Historical/inactive opt-out must not change current CRM reach.
      { status: "INACTIVE", marketingConsent: false, optOut: true },
    ]);

    expect(stats).toEqual({
      totalCustomers: 3,
      marketingOptIn: 1,
      optedOut: 1,
      noConsent: 1,
    });
  });

  test("count-based response preserves the count relationship", () => {
    expect(dashboardConsentStatsFromCounts(5, 3, 2)).toEqual({
      totalCustomers: 5,
      marketingOptIn: 3,
      optedOut: 2,
      noConsent: 0,
    });
    // Do not hide an impossible database/counting invariant by forcing it to
    // zero; an inconsistency should remain observable for diagnosis.
    expect(dashboardConsentStatsFromCounts(5, 4, 4).noConsent).toBe(-3);
  });

  test("the dashboard route scopes opted-out count to active customers", () => {
    const route = source("src/app/api/dashboard/stats/route.ts");
    expect(route).toContain('where: { hotelId, optOut: true, status: "ACTIVE" }');
  });

  test("recent activity does not send unused customer contact data to the browser", () => {
    const route = source("src/app/api/dashboard/stats/route.ts");
    expect(route).toContain('where: { hotelId, status: "ACTIVE" }');
    expect(route).toContain("select: { id: true, name: true, createdAt: true }");
    expect(route).not.toContain("select: { id: true, name: true, phone: true");
  });

  test("analytics overview uses the same active population", () => {
    const route = source("src/app/api/analytics/overview/route.ts");
    expect(route).toContain('loadCustomerIntelligence(hotelId, "ACTIVE")');
    expect(route).toContain(
      'const activeIntel = intel.filter((customer) => customer.status === "ACTIVE")',
    );
    expect(route).toContain("const totalCustomers = activeIntel.length;");
  });
});

describe("dashboard visit trend calendar", () => {
  const now = new Date("2026-10-18T18:00:00.000Z"); // 23:30 on Oct 18 in India

  test("assigns visits to the hotel-local day around a UTC midnight boundary", () => {
    const trend = buildVisitTrend(
      [
        { checkin: new Date("2026-10-04T18:45:00.000Z") }, // Oct 5 00:15 IST
        { checkin: new Date("2026-10-05T18:29:00.000Z") }, // Oct 5 23:59 IST
        { checkin: new Date("2026-10-05T18:30:00.000Z") }, // Oct 6 00:00 IST
        { checkin: new Date("2026-10-04T18:29:59.000Z") }, // before Oct 5 local window
      ],
      now,
      "Asia/Kolkata",
    );

    expect(trend[0]).toEqual({ date: "2026-10-05", count: 2 });
    expect(trend[1]).toEqual({ date: "2026-10-06", count: 1 });
    expect(trend).toHaveLength(14);
  });

  test("keeps date labels stable when the viewer timezone differs", () => {
    expect(formatDateKey("2026-10-05")).toBe("5 Oct");
    expect(formatDateKey("2026-02-30")).toBe("2026-02-30");
  });

  test("recent local days preserve DST boundaries", () => {
    const days = recentZonedDays(new Date("2026-03-08T16:00:00.000Z"), "America/New_York", 2);
    expect(days.map((day) => day.date)).toEqual(["2026-03-07", "2026-03-08"]);
    const springDay = zonedDayBounds("2026-03-08", "America/New_York");
    expect(springDay.end.getTime() - springDay.start.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  test("rejects impossible report dates instead of normalizing them", () => {
    expect(isValidDateKey("2026-02-28")).toBe(true);
    expect(isValidDateKey("2026-02-29")).toBe(false);
    expect(isValidDateKey("2026-13-01")).toBe(false);
  });

  test("stats route uses tenant-local trend bounds and date classification", () => {
    const route = source("src/app/api/dashboard/stats/route.ts");
    expect(route).toContain("const trendDays = recentZonedDays(now, timezone, 14)");
    expect(route).toContain("buildVisitTrend(recentVisits, now, timezone, 14)");
  });

  test("client dashboard helpers do not pull the server-only Prisma module", () => {
    const helper = source("src/lib/dashboard.ts");
    expect(helper).toContain('from "@/lib/timezone-core"');
    expect(helper).not.toContain('from "@/lib/timezone"');
  });
});

describe("owner report dashboard resilience", () => {
  test("malformed persisted recipient JSON cannot crash the view", () => {
    expect(parseReportRecipients("not-json")).toEqual([]);
    expect(parseReportRecipients('{"email":"owner@example.com"}')).toEqual([]);
    expect(parseReportRecipients('["owner@example.com", 42, null]')).toEqual(["owner@example.com"]);
  });

  test("reports view has explicit loading/error/retry paths and no direct JSON.parse", () => {
    const view = source("src/components/app/reports-view.tsx");
    expect(view).toContain("reportQ.isLoading");
    expect(view).toContain("reportQ.isError");
    expect(view).toContain("reportQ.refetch()");
    expect(view).toContain("scheduleQ.isError");
    expect(view).toContain("scheduleQ.refetch()");
    expect(view).not.toContain("JSON.parse(schedule.recipients");
  });

  test("invalid sales inputs use the structured API error contract", () => {
    const route = source("src/app/api/reports/sales/route.ts");
    expect(route).toContain("isValidDateKey(dateStr)");
    expect(route).toContain('jsonError("date must be a real YYYY-MM-DD calendar date"');
    expect(route).toContain('jsonError("tz must be a valid IANA timezone"');
  });
});

describe("owner dashboard usability", () => {
  test("owner navigation keeps five everyday tasks visible and groups specialist tools", () => {
    const shell = source("src/components/app/app-shell.tsx");
    expect(shell).toContain('["dashboard", "customers", "visits", "campaigns", "analytics"]');
    expect(shell).toContain("More tools");
    // The More section also stays open while a view INSIDE it is active
    // (hasActiveMoreView → moreExpanded), so the toggle reflects reality.
    expect(shell).toContain('aria-expanded={moreExpanded}');
    expect(shell).toContain('aria-controls="owner-more-tools"');
    expect(shell).toContain("const moreExpanded = moreOpen || hasActiveMoreView;");
    expect(shell).toContain("const hasActiveMoreView = !NAV_PRIMARY.some((item) => item.id === view);");
    expect(shell).toContain("onClick={() => setMoreOpen((open) => (hasActiveMoreView ? true : !open))");
  });

  test("dashboard exposes customer and visit actions with four plain-language KPIs", () => {
    const view = source("src/components/app/dashboard-view.tsx");
    const shared = source("src/components/app/shared-ui.tsx");
    expect(view).toContain('onClick={() => setView("customers")}');
    expect(view).toContain("Add customer");
    expect(view).toContain('onClick={() => setView("visits")}');
    expect(view).toContain("Record a visit");

    // 2026-10-21: the luxury redesign (bf8b571) moved the KPI row out of this
    // file into the shared <KpiStrip> primitive — the accessible
    // "Restaurant summary" region moved WITH it, and the four figures are now
    // passed as `label` props instead of `title` attributes. Keep asserting
    // the same guarantees, just at their new home: the labelled summary
    // landmark, the four plain-language KPIs, and the absence of the legacy
    // "Unique Guests" / "Opted Out" wording.
    expect(view).toContain("<KpiStrip");
    expect(shared).toContain('aria-label="Restaurant summary"');
    expect(view).toContain('label: "Customers"');
    expect(view).toContain('label: "Repeat customers"');
    expect(view).toContain('label: "Visits recorded"');
    expect(view).toContain('label: "Can receive offers"');
    expect(view).not.toContain("Unique Guests");
    expect(view).not.toContain("Opted Out");
  });
});
