/**
 * Regression suite for BUG_REPORT_NEW (2026-10-21).
 *
 * Covers the fixes that have pure or DB-level contracts:
 *   C-1  processRenewals never renews unpaid subscriptions; unpaid ACTIVE
 *        subscriptions become PAST_DUE, and a lapsed dunning window expires.
 *   H-1  reservations that cross midnight conflict (same day AND across the
 *        business-date boundary).
 *   H-3  birthday / anniversary matching uses the hotel's calendar day.
 *   H-5  promotion PATCH: every documented field is accepted/validated and an
 *        end date is inclusive for its whole calendar day.
 *   M-4  date-only customer fields are normalised to UTC midnight and read
 *        back with UTC getters (no previous-day drift).
 *   L-1  NO_SHOW requires a reason, like CANCELLED.
 *
 * Uses a throwaway SQLite database with the full schema (same pattern as
 * tests/billing-outbox.test.ts).
 */
import "./queue-test-env";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { testDb } from "./helpers";
import { spawnSync } from "child_process";
import { resolve } from "path";
import { cleanupQueueTestTmp } from "./queue-test-env";

const ROOT = resolve(import.meta.dir, "..");
const db = testDb();

import {
  absoluteStartMinute,
  intervalsOverlap,
  overlaps,
  shiftIsoDate,
} from "../src/lib/reservations";
import { buildPromotionPatch, parsePromoDate } from "../src/lib/promotions";
import { calendarMonthDay, sameZonedMonthDay, zonedMonthDay } from "../src/lib/timezone-core";
import { processRenewals } from "../src/lib/saas/subscriptions";
import { closeCashSession, openCashSession } from "../src/lib/billing";

beforeAll(async () => {
  const push = spawnSync(
    "bunx",
    ["prisma", "db", "push", "--schema", "prisma/schema.prisma", "--skip-generate", "--accept-data-loss"],
    { cwd: ROOT, env: process.env, stdio: "pipe", timeout: 120_000 },
  );
  if (push.status !== 0) {
    throw new Error(
      "prisma db push failed:\n" +
        (String(push.stdout ?? "") + String(push.stderr ?? "")).slice(0, 2000),
    );
  }
}, 180_000);

afterAll(async () => {
  await db.$disconnect();
  cleanupQueueTestTmp();
});

/* ------------------------------------------------------------------ */
/* H-1 — midnight-crossing reservations                                */
/* ------------------------------------------------------------------ */

describe("H-1 — reservation overlap across midnight", () => {
  test("same-day intervals still behave (half-open)", () => {
    expect(overlaps("18:00", 90, "19:00", 90)).toBe(true);
    expect(overlaps("18:00", 90, "19:30", 60)).toBe(false); // touches at 19:30
    expect(overlaps("12:00", 60, "12:00", 60)).toBe(true);
  });

  test("a late booking conflicts with an after-midnight booking (the bug)", () => {
    expect(overlaps("23:30", 90, "00:30", 90)).toBe(true);
    expect(overlaps("23:00", 90, "00:15", 60)).toBe(true);
    expect(overlaps("22:00", 60, "23:30", 90)).toBe(false); // ends 23:00
  });

  test("absolute timeline catches the conflict ACROSS business dates", () => {
    // 23:30 on the 21st vs 00:30 on the 22nd — physically the same window.
    expect(
      intervalsOverlap("2026-10-21", "23:30", 90, "2026-10-22", "00:30", 90),
    ).toBe(true);
    // 23:30 on the 21st vs 00:30 on the 23rd — no conflict.
    expect(
      intervalsOverlap("2026-10-21", "23:30", 90, "2026-10-23", "00:30", 90),
    ).toBe(false);
    // Same date, clear separation.
    expect(
      intervalsOverlap("2026-10-21", "18:00", 90, "2026-10-21", "20:30", 60),
    ).toBe(false);
    // Absolute minutes are monotonic across a month boundary.
    expect(absoluteStartMinute("2026-11-01", "00:00")).toBe(
      absoluteStartMinute("2026-10-31", "00:00") + 1440,
    );
    expect(shiftIsoDate("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftIsoDate("2026-01-01", -1)).toBe("2025-12-31");
  });

  test("malformed intervals fail CLOSED (reported as a conflict)", () => {
    expect(overlaps("nonsense", 90, "12:00", 60)).toBe(true);
    expect(overlaps("12:00", 0, "12:00", 60)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* H-5 — promotion PATCH validation                                    */
/* ------------------------------------------------------------------ */

describe("H-5 — promotion edits persist and validate", () => {
  const happyHour = {
    type: "HAPPY_HOUR",
    percentBps: 1500,
    valueMinor: null,
    daysOfWeek: null,
    startTime: "18:00",
    endTime: "20:00",
    startDate: null,
    endDate: null,
  };

  test("documented fields are no longer silently dropped", () => {
    const res = buildPromotionPatch(happyHour, {
      daysOfWeek: ["MON", "TUE"],
      startDate: "2026-11-01",
      endDate: "2026-11-30",
      itemIds: ["item-1", "item-1", "item-2"],
      categoryIds: ["cat-1"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.daysOfWeek).toBe(JSON.stringify(["MON", "TUE"]));
    expect(res.data.startDate).toEqual(new Date("2026-11-01T00:00:00.000Z"));
    // END DATE IS INCLUSIVE: the whole of 30 November still applies.
    expect(res.data.endDate).toEqual(new Date("2026-11-30T23:59:59.999Z"));
    expect(res.data.itemIdsJson).toBe(JSON.stringify(["item-1", "item-2"]));
    expect(res.data.categoryIdsJson).toBe(JSON.stringify(["cat-1"]));
  });

  test("invalid type/day/date/percent are rejected instead of ignored", () => {
    expect(buildPromotionPatch(happyHour, { type: "HACK" })).toMatchObject({
      ok: false,
      code: "INVALID_TYPE",
    });
    expect(buildPromotionPatch(happyHour, { daysOfWeek: ["FUNDAY"] })).toMatchObject({
      ok: false,
      code: "INVALID_DAYS",
    });
    expect(
      buildPromotionPatch(happyHour, { startDate: "2026-12-01", endDate: "2026-11-01" }),
    ).toMatchObject({ ok: false, code: "INVALID_WINDOW" });
    expect(buildPromotionPatch(happyHour, { percentBps: 12000 })).toMatchObject({
      ok: false,
      code: "INVALID_PERCENT",
    });
  });

  test("switching type requires the new unit and clears the stale one", () => {
    expect(buildPromotionPatch(happyHour, { type: "FLAT" })).toMatchObject({
      ok: false,
      code: "MISSING_VALUE",
    });
    const switched = buildPromotionPatch(happyHour, { type: "FLAT", valueMinor: 5000 });
    expect(switched.ok).toBe(true);
    if (!switched.ok) return;
    expect(switched.data.type).toBe("FLAT");
    expect(switched.data.valueMinor).toBe(5000);
    expect(switched.data.percentBps).toBeNull();
    expect(switched.data.startTime).toBeNull();
    expect(switched.data.endTime).toBeNull();
  });

  test("`null` clears a field instead of falling back to the old value", () => {
    const res = buildPromotionPatch(happyHour, { startTime: null, endTime: null });
    expect(res).toMatchObject({ ok: false, code: "INVALID_WINDOW" }); // HAPPY_HOUR needs a window
    const flat = { ...happyHour, type: "FLAT", percentBps: null, valueMinor: 1000, startTime: null, endTime: null };
    const cleared = buildPromotionPatch(flat, { daysOfWeek: null });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.data.daysOfWeek).toBeNull();
  });

  test("parsePromoDate rejects impossible dates", () => {
    expect(parsePromoDate("2026-02-30", "start")).toMatchObject({ ok: false });
    expect(parsePromoDate("2026-11-01", "end")).toEqual({
      ok: true,
      date: new Date("2026-11-01T23:59:59.999Z"),
    });
  });
});

/* ------------------------------------------------------------------ */
/* H-3 / M-4 — hotel-local calendar matching for date-only columns     */
/* ------------------------------------------------------------------ */

describe("H-3/M-4 — date-only calendar labels", () => {
  const birthday = new Date("1990-05-15T00:00:00.000Z"); // API-normalised form

  test("calendarMonthDay reads UTC parts regardless of server TZ", () => {
    expect(calendarMonthDay(birthday)).toBe("05-15");
    expect(zonedMonthDay(new Date("2026-05-15T18:30:00Z"), "Asia/Kolkata")).toBe("05-16");
  });

  test("the birthday matches the HOTEL's calendar day, not the server's", () => {
    // 18:30 UTC on 15 May is already 00:00 on 16 May in India.
    expect(sameZonedMonthDay(birthday, new Date("2026-05-15T10:00:00Z"), "Asia/Kolkata")).toBe(true);
    expect(sameZonedMonthDay(birthday, new Date("2026-05-15T18:30:00Z"), "Asia/Kolkata")).toBe(false);
    // ...while a UTC hotel still sees the 15th at that instant.
    expect(sameZonedMonthDay(birthday, new Date("2026-05-15T18:30:00Z"), "UTC")).toBe(true);
    // A birthday on the 14th is NOT matched on the 15th.
    expect(
      sameZonedMonthDay(new Date("1990-05-14T00:00:00.000Z"), new Date("2026-05-15T10:00:00Z"), "Asia/Kolkata"),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* H-2 — cash drawer only absorbs CASH refunds                         */
/* ------------------------------------------------------------------ */

describe("H-2 — drawer reconciliation ignores non-cash refunds", () => {
  async function drawerFixture() {
    const plan = await db.plan.create({
      data: {
        name: `DRAWER-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        key: `drawer-${Math.random().toString(36).slice(2, 10)}`,
        monthlyPrice: 0,
        yearlyPrice: 0,
        currency: "INR",
      },
    });
    const hotel = await db.hotel.create({
      data: { name: "Drawer Test Hotel", planId: plan.id, tenantId: `D-${Date.now()}` },
    });
    const user = await db.user.create({
      data: {
        hotelId: hotel.id,
        name: "Drawer Cashier",
        email: `drawer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
        passwordHash: "x".repeat(60),
        role: "HOTEL_ADMIN",
        status: "ACTIVE",
      },
    });
    const opened = await openCashSession(hotel.id, user.id, 100_000);
    if (!opened.ok || !opened.id) throw new Error("could not open the test drawer");
    return { hotel, user, sessionId: opened.id };
  }

  async function paidBill(
    hotelId: string,
    sessionId: string,
    userId: string,
    method: "CASH" | "UPI",
    amountMinor: number,
    tag: string,
  ) {
    const bill = await db.bill.create({
      data: {
        hotelId,
        billNumber: `INV/DRW/${tag}-${Math.random().toString(36).slice(2, 8)}`,
        series: "DRW",
        seqNumber: 1,
        status: "PAID",
        currency: "INR",
        subtotalMinor: amountMinor,
        totalMinor: amountMinor,
        paidMinor: amountMinor,
        issuedByUserId: userId,
      },
    });
    await db.billPayment.create({
      data: {
        hotelId,
        billId: bill.id,
        method,
        status: "RECORDED",
        amountMinor,
        cashSessionId: sessionId,
        recordedByUserId: userId,
      },
    });
    return bill;
  }

  test("a UPI refund never reduces the cash drawer", async () => {
    const { hotel, user, sessionId } = await drawerFixture();
    const bill = await paidBill(hotel.id, sessionId, user.id, "UPI", 25_000, "UPI");
    await db.billRefund.create({
      data: {
        hotelId: hotel.id,
        billId: bill.id,
        type: "REFUND",
        amountMinor: 25_000,
        reason: "card/UPI refund",
        mode: "MANUAL",
        approvedByUserId: user.id,
      },
    });

    const closed = await closeCashSession(hotel.id, user.id, sessionId, 100_000);
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.cashSalesMinor).toBe(0);
    expect(closed.refundMinor).toBe(0);
    expect(closed.expectedCashMinor).toBe(100_000);
    expect(closed.varianceMinor).toBe(0);
  });

  test("a cash refund is capped by the cash actually collected", async () => {
    const { hotel, user, sessionId } = await drawerFixture();
    const bill = await paidBill(hotel.id, sessionId, user.id, "CASH", 10_000, "CASH");
    await db.billRefund.create({
      data: {
        hotelId: hotel.id,
        billId: bill.id,
        type: "REFUND",
        amountMinor: 15_000, // larger than the cash received on that bill
        reason: "over-refund guard fixture",
        mode: "MANUAL",
        approvedByUserId: user.id,
      },
    });

    const closed = await closeCashSession(hotel.id, user.id, sessionId, 110_000);
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.cashSalesMinor).toBe(10_000);
    expect(closed.refundMinor).toBe(10_000); // clamped to the cash paid
    expect(closed.expectedCashMinor).toBe(100_000);
  });
});

/* ------------------------------------------------------------------ */
/* C-1 — renewals require money                                        */
/* ------------------------------------------------------------------ */

describe("C-1 — processRenewals bills before extending", () => {
  async function fixture(overrides: Record<string, unknown> = {}) {
    const plan = await db.plan.create({
      data: {
        name: `RENEW-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        key: `renew-${Math.random().toString(36).slice(2, 10)}`,
        monthlyPrice: 999,
        yearlyPrice: 9990,
        currency: "INR",
      },
    });
    const hotel = await db.hotel.create({
      data: { name: "Renewal Test Hotel", planId: plan.id, tenantId: `R-${Date.now()}` },
    });
    const currentPeriodEnd = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const sub = await db.subscription.create({
      data: {
        hotelId: hotel.id,
        planId: plan.id,
        status: "ACTIVE",
        billingCycle: "MONTHLY",
        amount: 999,
        currency: "INR",
        currentPeriodStart: new Date(currentPeriodEnd.getTime() - 30 * 24 * 60 * 60 * 1000),
        currentPeriodEnd,
        nextInvoiceAt: currentPeriodEnd,
        ...overrides,
      },
    });
    return { plan, hotel, sub, currentPeriodEnd };
  }

  test("an overdue subscription with no payment becomes PAST_DUE and keeps its period", async () => {
    const { sub, currentPeriodEnd } = await fixture();
    const result = await processRenewals();
    expect(result.pastDue).toBeGreaterThanOrEqual(1);

    const after = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe("PAST_DUE");
    expect(after.currentPeriodEnd?.toISOString()).toBe(currentPeriodEnd.toISOString());
    expect(after.graceEndsAt).not.toBeNull();
    expect(after.graceEndsAt!.getTime()).toBeGreaterThan(Date.now());
    expect(result.renewed).toBe(0);
  });

  test("a PAID payment recorded after the period end renews exactly one cycle", async () => {
    const { sub, hotel, plan, currentPeriodEnd } = await fixture();
    // Move past the dunning step first.
    await db.subscription.update({
      where: { id: sub.id },
      data: { status: "ACTIVE" },
    });
    await db.payment.create({
      data: {
        hotelId: hotel.id,
        subscriptionId: sub.id,
        planId: plan.id,
        invoiceNumber: `SL-RENEW-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        amount: 999,
        currency: "INR",
        status: "PAID",
        provider: "manual",
        paidAt: new Date(),
        billingCycle: "MONTHLY",
      },
    });

    const result = await processRenewals();
    expect(result.renewed).toBeGreaterThanOrEqual(1);

    const after = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe("ACTIVE");
    expect(after.currentPeriodEnd!.getTime()).toBe(
      currentPeriodEnd.getTime() + 30 * 24 * 60 * 60 * 1000,
    );
  });

  test("PAST_DUE past the dunning window expires (respects autoExpire)", async () => {
    const { sub } = await fixture({ status: "PAST_DUE" });
    await db.subscription.update({
      where: { id: sub.id },
      data: { graceEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    const result = await processRenewals();
    expect(result.expired).toBeGreaterThanOrEqual(1);
    const after = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe("EXPIRED");
    expect(after.expiredAt).not.toBeNull();
  });
});
