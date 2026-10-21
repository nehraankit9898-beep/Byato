# StayLoop — Bug Audit & Fix Report (2026-10-21)

**Repository:** `/home/user/Byato` @ `9cb69a7` + fixes on branch `arena/37b88a78-byato`
**Stack:** Next.js 16.4.2 · React 19 · Prisma 6.19.3 · SQLite (dev) / PostgreSQL (prod)
**Method:** full static review of `src/lib/**` + ~250 route handlers, targeted live HTTP probing against a seeded instance, isolated re-implementation tests of pure helpers (Bun), and a fresh regression suite (`tests/audit-2026-10-21-fixes.test.ts`).
**Baseline checks:** `npx tsc --noEmit` → **0 errors**; `npx eslint .` → **0 problems**.
**Status:** every finding below is **FIXED** and covered by the regression suite or an existing suite. Final verification: **`bun run test` → ALL TEST SUITES PASSED (0 failures)**.

> Already-documented bugs from earlier audits (`audit/BUG_SWEEP_2026-10.md`, `BUGS_FOUND.md`, `REMAINING_ISSUES.md`, `docs/BUG_REPORT.md`) are deliberately **not** re-listed.

---

## Summary table

| ID | Severity | Area | Bug | Status |
|----|----------|------|-----|--------|
| C-1 | Critical | SaaS billing | Renewals extended every ACTIVE subscription with no payment lookup; `pastDue` always 0 | ✅ Fixed |
| H-1 | High | Reservations | Midnight-crossing bookings never conflict (same day **and** across dates) | ✅ Fixed |
| H-2 | High | Cash drawer | Every manual refund subtracted from cash, including card/UPI and previous-session refunds | ✅ Fixed |
| H-3 | High | Automations | Birthday/anniversary matched on the **server's** calendar, not the hotel's | ✅ Fixed |
| H-4 | High | Auth / privacy | Registration response leaked account existence (`hotel.id`, `devUrl`) | ✅ Fixed |
| H-5 | High | Promotions | PATCH silently dropped `type/daysOfWeek/startDate/endDate/itemIds/categoryIds`; UI could not create happy hours | ✅ Fixed |
| M-1 | Medium | Memory | In-process lock maps never pruned (comparison with fresh `Promise.resolve()`) | ✅ Fixed |
| M-2 | Medium | Bills API | `?from=abc` → Prisma `Invalid Date` → 500; no from≤to check | ✅ Fixed |
| M-3 | Medium | Coupons API | NaN/negative limits silently disabled caps; inverted validity window; bad 500s | ✅ Fixed |
| M-4 | Medium | Customer dates | Date-only fields drifted a day across timezones (store, display, segments) | ✅ Fixed |
| M-5 | Medium | Dashboard API | `?days=` accepted and ignored | ✅ Fixed |
| M-6 | Medium | Payment links | Revoke `updateMany` was not tenant-scoped (defence in depth) | ✅ Fixed |
| M-7 | Medium | SaaS coupons | Redemption skipped expiry / per-tenant re-validation at capture time | ✅ Fixed |
| L-1 | Low | Reservations | Dead NO_SHOW branch in the cancel guard | ✅ Fixed |
| L-2 | Low | Coupons | Hard-coded `₹` for tenants with other currencies | ✅ Fixed |
| L-3 | Low | Promotions | Switching type left a stale unit field on the row | ✅ Fixed |
| L-4 | Low | GET params | Invalid dates/limits silently ignored (`visits`, `reservations`, `inventory/ledger`, `bills`) | ✅ Fixed |
| T-1 | Test infra | phase10-saas | Fixture used `segmentId: ""` → FK violation on a fresh database | ✅ Fixed |

---

## C-1 · SaaS subscriptions renewed forever without being billed
**File:** `src/lib/saas/subscriptions.ts` (`processRenewals`, worker: `scripts/worker.ts:343`)

**Before**
```ts
const due = await db.subscription.findMany({
  where: { status: "ACTIVE", currentPeriodEnd: { lt: now } },
  include: { plan: true },
});
for (const sub of due) {
  const periodDays = sub.billingCycle === "YEARLY" ? 365 : 30;
  await db.subscription.update({
    where: { id: sub.id },
    data: {
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + periodDays * 86400000),
      nextInvoiceAt:        new Date(now.getTime() + periodDays * 86400000),
    },
  });
  renewed += 1;
}
return { renewed, pastDue }; // pastDue never incremented
```

**Root cause:** “period elapsed” was treated as “renewal paid”. No payment lookup, no invoice, no dunning, no `PAST_DUE`, no expiry.

**Impact:** a tenant that paid once received paid service forever — unbounded platform revenue loss; `renewed` metrics counted unpaid renewals as successes.

**Fix**
- A renewal now requires **money**: a `PAID` `Payment` for this subscription (or a plan-level payment) recorded at/after the period end.
- With payment → period extended by exactly one cycle, `graceEndsAt` cleared, audited with `paymentId`; the update is a **CAS** (`currentPeriodEnd` must still match), so a racing webhook/worker cannot double-extend.
- Without payment → `PAST_DUE`, `graceEndsAt = now + trial.defaults.graceDays`, `nextInvoiceAt = now`; the period is **not** extended.
- `PAST_DUE` past the dunning window → `EXPIRED` (honours `autoExpire`), audited.
- `getSubscriptionView`: `PAST_DUE` now yields `grace` during the dunning window and `readonly_billing` afterwards when `blockOnExpiry` is on (previously it granted `full` access forever).

**Regression tests:** `tests/audit-2026-10-21-fixes.test.ts` → C-1 group (3 tests: unpaid → PAST_DUE, paid → +30d, lapsed grace → EXPIRED).

---

## H-1 · Reservations crossing midnight never conflict
**File:** `src/lib/reservations.ts`

**Before**
```ts
const a0 = timeToMinutes(aStart); const a1 = a0 + aDur;   // 23:30+90 = 1500
const b0 = timeToMinutes(bStart); const b1 = b0 + bDur;   // 00:30+90 = 120
return a0 < b1 && b0 < a1;                                 // 1410 < 120 → false
```
…and the conflict query only loaded reservations with `date: input.date`, so a 23:30 booking and a 00:30 next-day booking were never compared at all.

**Impact:** the same physical table could be double-booked on late-night seatings — silent, guest-facing, and not covered by any DB constraint.

**Fix**
- `overlaps()` now splits an interval at midnight (23:30+90 → 23:30–24:00 + 00:00–01:00) and compares half-open segments; malformed input **fails closed**.
- New `absoluteStartMinute()`, `shiftIsoDate()` and `intervalsOverlap()` compare intervals on an absolute minute timeline across business dates.
- `createReservation` loads the previous, current and next business date and compares using `intervalsOverlap` — inside the same transaction as before.

**Regression tests:** 4 tests covering 23:30/00:30, 23:00/00:15, non-conflicts, month/year boundaries and fail-closed behaviour.

---

## H-2 · Cash drawer reconciliation subtracted the wrong refunds
**File:** `src/lib/billing.ts` (`closeCashSession`)

**Before**
```ts
const refunds = await db.billRefund.findMany({
  where: { hotelId, createdAt: { gte: session.openedAt, lte: new Date() }, mode: "MANUAL" },
});
const refundMinor = refunds.reduce((s, r) => s + r.amountMinor, 0);
const expected = session.openingFloatMinor + cashSales - refundMinor;
```
`BillRefund` records neither the payment method nor the drawer, so a UPI/card refund — or a cash refund for a bill paid in an earlier shift — reduced this drawer's expected cash.

**Impact:** phantom shortfalls (cashier accused) or hidden surpluses, plus wrong cash-sales/refund reporting.

**Fix:** refunds are grouped per bill; each bill's refund is capped by the **CASH actually collected for that bill** (`BillPayment.method = "CASH"`), gateway refunds are excluded entirely, and the deduction can never exceed the cash that entered the drawer.

> Residual limitation (documented): without a `BillRefund.cashSessionId` column, a cash refund issued in a later session for an earlier bill is attributed to the currently-open drawer — which matches the physical cash model. A future migration can store the drawer id for exact multi-shift attribution.

**Regression tests:** `tests/audit-2026-10-21-fixes.test.ts` H-2 group — a UPI refund leaves the drawer untouched (`refundMinor = 0`), and a cash refund larger than the cash collected is clamped. The existing `tests/phase14-billing.test.ts` cash-session test (open → cash payment → close with variance `-50`) also passes.

---

## H-3 · Birthday / anniversary automations used the server's calendar
**Files:** `src/lib/automations.ts`, `src/lib/timezone-core.ts`

**Before**
```ts
if (c.birthday.getMonth() === today.getMonth() &&
    c.birthday.getDate() === today.getDate()) { ... }
```
Two defects: (1) `today` is the server's date, not the hotel's; (2) `birthday` is a date-only column stored at UTC midnight, so local getters shift it a day west of UTC.

**Impact:** wishes fired on the wrong day (or were missed) — e.g. 18:30–24:00 UTC is already the next day in India, the primary market.

**Fix:** new `calendarMonthDay()` / `zonedMonthDay()` / `sameZonedMonthDay()` in `timezone-core.ts`; BIRTHDAY and ANNIVERSARY now compare the column's UTC month/day with the hotel-local month/day of `now` (`tz` already loaded per scan).

**Regression tests:** H-3 group (UTC vs Asia/Kolkata at 18:30Z, positive/negative cases). Existing `tests/audit-fixes.test.ts` F12 dedupe test also passes.

---

## H-4 · Hotel registration leaked whether an email exists
**File:** `src/app/api/hotels/route.ts`

**Before (live evidence)**

| email | status | body |
|---|---|---|
| existing `admin@grandpalace.com` | 201 | `{ok, message, emailVerification:{sent:false}}` |
| new address | 201 | `{ok, message, hotel:{id,name}, emailVerification:{sent:true,devUrl}}` |

The generic message did not matter: `hotel`/`devUrl` presence was an existence oracle.

**Impact:** targeted phishing, credential-stuffing list building, competitor scraping.

**Fix:** one shared `registerResponse()` — `{ ok: true, message }`, status 201 — for **both** branches. The verification token travels only in the email; in dev the link is written to the server log (`register.verification_dev_url`).

**Knock-on updates:** `tests/phase7.test.ts` now extracts the token from the mock email outbox; the six phase suites that used `body.hotel.id` resolve the id from `GET /api/auth/me` via a new `currentUser()` test helper.

---

## H-5 · Promotions PATCH silently discarded documented fields (and happy hour was uncreatable in the UI)
**Files:** `src/app/api/promotions/route.ts`, `src/app/api/promotions/[id]/route.ts`, `src/lib/promotions.ts` (new), `src/components/app/promotions-view.tsx`

**Before (live evidence)**
- `PATCH {daysOfWeek, startDate, endDate}` → **200**, `version` incremented, all three persisted `null`.
- `PATCH {type:"HACK"}` → **200**, type unchanged (silent no-op).
- The form sent `percentBps` only for `PERCENT`, but the API requires it for `HAPPY_HOUR` too → every happy-hour create failed with 422; the list rendered happy hours as “flat ₹0 off”.

**Fix**
- New pure module `src/lib/promotions.ts`: `PROMO_TYPES`, `PROMO_DAYS`, `parsePromoDate`, `buildPromotionPatch`.
- PATCH now persists and validates `type`, `daysOfWeek`, `itemIds`, `categoryIds`, `startDate`, `endDate`; invalid values → **422** (`INVALID_TYPE/INVALID_DAYS/INVALID_WINDOW/INVALID_PERCENT/…`) instead of a fake 200.
- `startDate ≤ endDate`, `HH:MM` windows, MON..SUN enum, deduped scope ids.
- **Inclusive end date:** a date-only `endDate` is stored at `23:59:59.999Z`, so “until 31 Dec” covers the 31st (was midnight → final day lost). Impossible calendar dates (`2026-02-30`) are rejected instead of silently rolling over.
- Switching type requires the new unit and clears the stale one (`PERCENT → FLAT` nulls `percentBps`, `FLAT → PERCENT` nulls `valueMinor`, non-happy-hour clears the window).
- POST shares the constants/date parsing; UI sends the correct payload per type and renders happy hours as “20.00% off · 18:00–20:00”.

**Regression tests:** H-5 group (5 tests) + existing `tests/phase15-retention.test.ts` promotion tests.

---

## M-1 · Lock maps never pruned
**Files:** `src/lib/loyalty.ts`, `src/lib/coupons.ts`

`v === Promise.resolve()` compares against a **new** promise on every call → never true, and entries accumulated for every account/coupon ever touched.

**Fix:** each lock entry deletes itself when its own chain settles, guarded by identity:
```ts
const tracked = next.catch(() => undefined).finally(() => {
  if (map.get(id) === tracked) map.delete(id);
});
```
No unbounded growth; a newer waiter is never dropped.

## M-2 · `GET /api/bills` crashed on malformed dates
`new Date("abc")` → `Invalid Date` → Prisma validation error → **500**.
**Fix:** `parseDateRangeBound()` validates strict `YYYY-MM-DD` (round-trip check) or ISO timestamps, rejects inverted ranges with `400 INVALID_DATE_RANGE`, makes a date-only `to` inclusive, and clamps `limit` to 1..200.

## M-3 · Coupon creation accepted NaN / impossible values
`Number("abc")` → `NaN` (Prisma 500), negative/`NaN` limits silently disabled caps (`usageLimit > 0` false), inverted `validFrom/validUntil` produced unredeemable coupons, and `maximumDiscount < discountValue` truncated redemptions.
**Fix:** explicit validators for amounts/limits/dates → `422 INVALID_AMOUNT / INVALID_LIMIT / INVALID_DATE / INVALID_DATE_RANGE / INVALID_DISCOUNT`.

## M-4 · Date-only customer fields drifted by a day
- POST parsed `"1990-05-15"` as UTC midnight but `"1990-05-15T00:00"` as **local** midnight; impossible dates rolled over silently.
- `toDateInput` read them with **local** getters → a US browser displayed 1990-05-14 and shifted the date on every edit.
- `daysUntilNextYearly` (segments) used local getters on the UTC-midnight value → off-by-one “birthday within N days”.
- Profile rendered them with local `toLocaleDateString`.

**Fix:** normalise date-only input to `${value}T00:00:00.000Z` with round-trip validation (POST + PATCH); `toDateInput` uses UTC getters; new `formatCalendarDate()` (UTC) for birthday/anniversary display; `daysUntilNextYearly` takes the UTC month/day.

## M-5 · `dashboard/stats?days=` was ignored
**Fix:** validated (integer 1–90, default 14) and applied to both the trend window and `buildVisitTrend`; invalid → `400 INVALID_DAYS`.

## M-6 · Payment-link revoke not tenant-scoped
**Fix:** `updateMany({ where: { billId, hotelId, status: "ACTIVE" } })`.

## M-7 · Coupon redemption did not re-validate expiry / per-tenant cap
The live path (`processPaymentConfirmation`) and the SaaS helper (`redeemCoupon`) only re-checked `isActive` + global `usageLimit`.

**Fix (both paths):** the guarded increment now also requires the coupon to be currently valid (`startsAt ≤ now < expiresAt`) and stays under the global limit; the per-tenant cap is counted against PAID payments and, when exceeded, the increment is compensated (helper: transaction rollback; confirmation: decrement inside the same transaction). The confirmation marker is only claimed for a currently-valid coupon.

## L-1 … L-4
- **L-1:** removed the dead `NO_SHOW` branch from the cancel-reason guard (cancellation keeps requiring a reason; NO_SHOW behaviour unchanged for staff workflows).
- **L-2:** removed hard-coded `₹` from coupon messages (two places).
- **L-3:** type switches clear the stale unit/window fields.
- **L-4:** invalid `from/to` in `visits` → `400`; impossible `reservations?date=2026-13-45` → `400`; `inventory/ledger?limit=-5` no longer flips Prisma's `take` direction (clamped 1..500).

## T-1 · Test-fixture FK violation (phase10)
`tests/phase10-saas.test.ts` filled the campaign quota with `segmentId: ""`, which violates the FK whenever the tenant has no segment (true on a fresh seed). The fixture now creates a segment when missing and cleans it up.

---

## Files changed

| File | Change |
|---|---|
| `src/lib/saas/subscriptions.ts` | Cash-aware renewal sweep + dunning/expiry; `PAST_DUE` access level |
| `src/lib/saas/billing.ts` | Coupon validity + per-tenant cap at payment confirmation |
| `src/lib/saas/coupons.ts` | `redeemCoupon` transactional validity/limit guards |
| `src/lib/reservations.ts` | Midnight-safe overlap math, cross-date conflict query, guard cleanup |
| `src/lib/billing.ts` | Correct cash-drawer refund attribution |
| `src/lib/automations.ts` | Hotel-local birthday/anniversary matching |
| `src/lib/timezone-core.ts` | `calendarMonthDay`, `zonedMonthDay`, `sameZonedMonthDay` |
| `src/lib/promotions.ts` | **New** — shared promotion validation/patch builder |
| `src/lib/format.ts` | `formatCalendarDate` (UTC for date-only values) |
| `src/lib/segments.ts` | `daysUntilNextYearly` uses the date-only column's UTC parts |
| `src/lib/loyalty.ts`, `src/lib/coupons.ts` | Self-pruning lock maps; currency-neutral messages |
| `src/app/api/promotions/route.ts`, `[id]/route.ts` | Full field support + validation + inclusive end date |
| `src/app/api/hotels/route.ts` | Uniform anti-enumeration registration response |
| `src/app/api/bills/route.ts` | Validated date range + inclusive end + limit clamp |
| `src/app/api/coupons/route.ts` | Strict numeric/date validation |
| `src/app/api/dashboard/stats/route.ts` | Honoured `days` window |
| `src/app/api/payment-links/route.ts` | Tenant-scoped revoke |
| `src/app/api/visits/route.ts`, `api/reservations/route.ts`, `api/inventory/ledger/route.ts` | Date/limit param validation |
| `src/app/api/customers/route.ts`, `api/customers/[id]/route.ts` | UTC-normalised date-only fields |
| `src/components/app/promotions-view.tsx` | Correct create payload + happy-hour label |
| `src/components/app/customer-dialog.tsx`, `customer-profile-view.tsx` | UTC rendering of date-only fields |
| `src/components/app/reservations-view.tsx` | Reason wiring cleanup |
| `tests/helpers.ts` | `currentUser()` helper |
| `tests/phase7.test.ts`, `phase13/14/15/16/17/18`, `phase10-saas.test.ts` | Adapted to the hardened contracts |
| `scripts/run-tests.ts` | Registers the new regression suite |
| `tests/dashboard-regressions.test.ts` | Source assertion updated: the trend window is now `trendWindow` (validated `?days=`) instead of a hard-coded 14 |
| `tests/audit-2026-10-21-fixes.test.ts` | **New** — 16 regression tests |

---

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ 0 errors |
| `npx eslint .` | ✅ 0 problems |
| `bun test tests/audit-2026-10-21-fixes.test.ts` | ✅ 16 pass / 0 fail |
| `tests/phase7` (registration + email verification) | ✅ 13 pass |
| `tests/phase10-saas` | ✅ 29 pass |
| `tests/phase13-orders` | ✅ 16 pass |
| `tests/phase14-billing` (cash drawer) | ✅ 22 pass |
| `tests/phase15-retention` (promotions/payment links) | ✅ 13 pass |
| `tests/phase16-operations` (reservations) | ✅ 13 pass |
| `tests/phase17-enterprise` / `phase18-ai` | ✅ 12 / 37 pass |
| `tests/audit-fixes` (F12 birthday automations) | ✅ 18 pass |
| `tests/customers-crm` (date-only fields) | ✅ 63 pass |
| `tests/rbac-security-master` | ✅ 26 pass |
| `tests/dashboard-regressions` | ✅ 16 pass (after updating the source assertion) |
| `bun run test` (full harness: 61 test files + phase1/phase2/phase63 acceptance scripts) | ✅ **ALL TEST SUITES PASSED** — 753 `pass` assertions, 0 failures; acceptance: phase1 **93/93**, phase2 **79/79**, phase6.3 **62/62** |

---

## Live verification (against a seeded instance)

| Request | Before | After |
|---|---|---|
| `GET /api/bills?from=abc` | 500 (Prisma `Invalid Date`) | **400 `INVALID_DATE_RANGE`** |
| `GET /api/visits?from=abc` | 200, filter silently dropped | **400 `INVALID_DATE_RANGE`** |
| `GET /api/reservations?date=2026-13-45` | 200, empty list | **400 `INVALID_DATE`** |
| `GET /api/dashboard/stats?days=7` | 200, 14-day trend (param ignored) | **200, `visitsTrend.length = 7`** |
| `GET /api/dashboard/stats?days=abc` | 200, param ignored | **400 `INVALID_DAYS`** |
| `GET /api/inventory/ledger?limit=-5` | 200, Prisma `take: -5` (reversed) | **200, clamped** |
| `POST /api/coupons {usageLimit:"abc"}` | 500 / NaN cap silently disabled | **422 `INVALID_LIMIT`** |
| `PATCH /api/promotions/:id {daysOfWeek,startDate,endDate}` | 200, all persisted `null` | **200, `["MON","TUE"]`, `2026-11-01T00:00Z`, `2026-11-30T23:59:59.999Z`** |
| `PATCH /api/promotions/:id {type:"HACK"}` | 200, silent no-op | **422 `INVALID_TYPE`** |
| `POST /api/promotions` happy-hour (UI payload) | 422 `INVALID_VALUE` (form omitted `percentBps`) | **201 `HAPPY_HOUR` 2000 bps** |
| `POST /api/hotels` existing vs new email | different bodies (`hotel`, `devUrl`) | **byte-identical `{ok, message}` (201)** |

## Remaining observations (not fixed — documented as design choices)

1. **Cash refunds across shifts:** exact attribution needs a `BillRefund.cashSessionId/paymentMethod` migration; the current cap prevents over-subtraction (see H-2).
2. **`analytics/overview`** has no query parameters at all — the earlier “ignored `days`” observation was a false positive; only `dashboard/stats` had the defect (fixed).
3. **`campaigns?status=`** is not a supported filter on `GET /api/campaigns`; unknown params are ignored by design (no data risk).
4. **`menu/items?categoryId=bad`** returns an empty list — a UUID filter that matches nothing is not an error; left as-is.
5. **`audit-logs?page/pageSize`** already clamps to safe ranges; no change needed.
