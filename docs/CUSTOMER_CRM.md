# Customer Section & Add Customer — improvement reference

> Scope: the restaurant CRM (customer list/dashboard, add & edit customer,
> duplicate prevention, customer profile/history, and customer linking from the
> paid-bill workflow).
> Status: implemented, covered by `tests/customers-crm.test.ts`.

## 1. What the customer system looked like before

| Area | Before |
| --- | --- |
| Data model | `Customer` is tenant-scoped (`hotelId`) and already unique per `(hotelId, phone)`. Name and phone are required, email/notes/birthday/marketing flags are optional. |
| List API | `GET /api/customers` had server-side search, consent/status filters, sorting and pagination — but **no summary numbers** and **no visit-activity filter**. |
| Create API | `POST /api/customers` validated by hand, pre-checked the phone, then created. A concurrent create hit the unique constraint and surfaced a **500**, not a 409. `src/lib/validation.ts` already exported a `customerCreateSchema` that **no route used**. |
| Duplicate UX | A duplicate returned a bare 409 message with no reference to the existing customer, so staff re-typed the guest or created a near-duplicate. |
| Add form | A single long form with `required` HTML attributes only — no field-level messages, no explicit "not the same as registration" consent framing. |
| Profile | `GET /api/customers/[id]` counted **only hotel stays** (`Visit`). For a restaurant, a guest with paid bills showed `totalVisits = 0` and `₹0` lifetime spend. No order history, no loyalty. |
| Orders | POS bills and QR orders stored free-text `customerName` / `customerPhone` and **never linked a customer**. The paid-bill hook matched the RAW phone against the normalized one, so `+91 98765 43210` never matched `+919876543210`. |
| Client authorization | The UI had no permission signal — every button was shown to every role. |

## 2. What changed

### 2.1 Shared domain layer — `src/lib/customers.ts` (new)

One place for the rules, used by every route and by the billing hook:

- `isUniqueConstraintError` / `isPhoneUniqueViolation` — stable `P2002`
  detection (the error code, not `instanceof`: the test/dev build runs the
  pure-JS engine behind a driver adapter).
- `findCustomerByPhone(hotelId, phone, excludeId?)` — always normalized, always
  tenant-scoped.
- `createCustomerForTenant(hotelId, input)` — duplicate-safe AND race-safe:
  explicit lookup → create inside the plan-limit transaction → if the database
  constraint wins the race, re-read the winner and return the **same 409
  contract**. Never merges or deletes anything.
- `linkOrCreateCustomerFromOrder(...)` — link-or-create for orders/bills (see
  §2.5).
- `classifyActivity(...)` + `emptySummary()` — the summary-card maths, in one
  place so the API and the UI copy can never drift.

### 2.2 List & dashboard — `GET /api/customers`

- New `summary` block: `total`, `newCustomers`, `returningCustomers`,
  `lapsedCustomers`, `neverVisited`, plus the windows (`newWindowDays` 30,
  `lapsedWindowDays` 90) so the UI labels them from the data.
- New `activity` filter: `all | new | returning | lapsed | never`.
- Query params are validated with `customerListQuerySchema` (Zod); `search` is
  accepted as an alias of `q`; phone search normalizes the term the same way
  stored numbers are, so `9876543210`, `+919876543210` and `+91 98765 43210`
  all find the same guest.
- Each row also carries `isNew` / `isReturning` / `isLapsed` / `neverVisited` so
  the list can render a chip without a second request.
- Visits and spend are **unified** (hotel stays + paid restaurant bills); the
  split stays available under `hotelVisits` / `restaurantVisits` /
  `lastRestaurantVisit` / `totalRestaurantSpend`.

Definitions (repeated verbatim in the UI tooltips — nothing is estimated):

- **New** — has at least one visit/order and the *first* one was within the last
  30 days. Creating a profile is not a visit.
- **Returning** — 2 or more visits/orders.
- **Not visited recently** — no visit/order in the last 90 days (includes guests
  who never visited; `neverVisited` breaks that subset out).

### 2.3 Add / edit customer

- `POST /api/customers` now validates with the existing `customerCreateSchema`
  (extended with the channel opt-ins) and returns
  `{ error: { code: "VALIDATION_ERROR", message, fields: { field: message } } }`
  so the form can show a message under the exact input.
- Duplicates return **409 `DUPLICATE_PHONE` with `existing: { id, name }`** —
  the UI offers to open that profile instead of creating a second one.
- `PATCH /api/customers/[id]` returns the same `existing` payload on both the
  pre-check and the (new) constraint-violation path, so a race can no longer
  surface as a 500.
- The tenant is always the session's hotel. A `hotelId` / `restaurantId` in the
  body is ignored (covered by a test).
- The audit row for `CUSTOMER_CREATED` no longer duplicates the phone number —
  the row is linked by `entityId`.

### 2.4 Profile & history — `GET /api/customers/[id]`

- `orders[]` — one entry per paid bill (`RestaurantVisit`), newest first.
- `stats` is unified (`totalVisits`, `totalSpend`) and additionally exposes
  `hotelVisits`, `hotelSpend`, `restaurantVisits`, `restaurantSpend`,
  `neverVisited`, `isReturning`, `averageOrderValue`.
- `loyalty` — the `LoyaltyAccount` balance, or `null` when the hotel has no
  account for that guest. **No loyalty card is rendered without an account**, so
  a fabricated `0` is impossible.
- Orders are added to the activity timeline.
- A guest with no activity reports `0` visits, `₹0`, `null` dates and an empty
  history — never a placeholder number.

### 2.5 Orders → CRM (`src/lib/billing.ts`)

`resolveBillCustomer()` runs **after** a bill is paid (never during checkout):

1. `bill.customerId` present → `attached`.
2. Otherwise the phone is **normalized** before the lookup (the old raw
   comparison silently lost repeat guests).
3. No match and the bill has a real name + a valid phone → a minimal profile is
   created (`marketingConsent: false` — an order is not consent).
4. No phone, or a phone that fails validation → nothing is created (guest
   checkout is preserved).

Manual (CASH/UPI/CARD) payments create their follow-up job inside the payment
transaction, so the resolved id is **backfilled onto the QUEUED job** with a
conditional `updateMany` (a worker that already claimed the row wins). The
whole hook is wrapped in `try/catch`: a CRM problem can never fail or roll back
a payment.

### 2.6 UI

- `customers-view.tsx` — four summary cards (clickable = activity filter),
  activity/consent/status filters, page-size selector, a **card list on mobile
  and a table on desktop**, and explicit loading / error (retry) / empty /
  no-match states. Actions are hidden when the session lacks the permission.
- `customer-dialog.tsx` — client-side validation with the **same Zod schema**
  producing per-field messages (`aria-invalid`, `role="alert"`), a
  `submittingRef` guard against double submits, values preserved on every
  failure, marketing consent framed as a separate explicit opt-in, and the
  duplicate alert offering "Open …'s profile".
- `customer-profile-view.tsx` — order history card, loyalty card (only when an
  account exists), permission-gated actions, and an "orders only" empty state
  for guests with bills but no stays.
- `SessionUser.permissions` is now typed and consumed (the server already
  returned it). Hiding is UX only — every route re-checks server-side.

## 3. Database / schema changes

**None.** No Prisma model, index or migration was added or altered:

- `@@unique([hotelId, phone])` already existed and is the constraint the new
  race handling relies on.
- Every new field is derived at read time (aggregates, activity buckets) or
  reused (`notes`, `birthday`, `marketingConsent`, `LoyaltyAccount`).

## 4. Security & tenant-isolation findings

| Finding | Status |
| --- | --- |
| Concurrent creates returned 500 instead of 409 (unique violation unhandled) | Fixed — `isPhoneUniqueViolation` + re-read, in `POST` and `PATCH`. |
| A client-supplied `hotelId`/`restaurantId` could decide the tenant | Verified safe (body is ignored), now covered by a regression test. |
| Paid-bill phone matching used the RAW string, so the wrong/no guest was attributed | Fixed — normalized lookup. |
| Cross-tenant read/update/delete | Unchanged and re-tested: a foreign customer is a 404, never a 403 (no existence leak). |
| Audit rows duplicated the customer's phone number | Removed; the row is linked by `entityId`. |
| UI showed every action to every role | Fixed for customers (create/update/delete/export/visit) via the session permission set. |
| Public menu leaked customer data | Re-tested: the public menu response contains no `+91…` number and no email. |

## 5. Tests

`tests/customers-crm.test.ts` (registered in `scripts/run-tests.ts`), 63
assertions-rich cases:

1. successful creation (+ phone normalization, optional fields, consent rules)
2. missing / too-short / empty required fields (field-level messages)
3. invalid phone, too-short phone, invalid email, phone-normalization units
4. duplicate phone in the same restaurant (409 + `existing`)
5. identical phone numbers in two restaurants (both allowed, each sees its own)
6. 8 concurrent creates → exactly one 201 + seven 409 and one row in the DB;
   repeated identical submits
7. anonymous 401; `HOTEL_STAFF` 403 on create/update/delete, 200 on read
8. cross-tenant GET/PATCH/DELETE → 404; cross-tenant phone move; list isolation
9. editing, the 409 on rename-to-an-existing-phone, unified stay + order
   history, list/profile agreement, loyalty only when an account exists
10. paid bill → new customer linked, second bill → reused, no-phone bill →
    nobody created, invalid phone → nobody created, existing profile never
    renamed by a bill
11. search (name, three phone formats, `search` alias), empty result, invalid
    filter → 400, summary consistency, activity-filter subsets, pagination,
    and source-level checks for the loading/empty/error/duplicate UI states
12. regression: bills, orders, menu, dashboard, leaderboard, export
    authorization, public menu privacy, and the original list response contract

The suite registers **its own throwaway restaurants** — the functional
acceptance suites that run afterwards assert exact seeded counts, so writing
into the demo tenants would fail them.

## 5.1 Verification actually run (commands + exit codes)

| Command | Exit | Result |
|---|---|---|
| `bun run scripts/run-tests.ts` (full harness: temp SQLite DB → `prisma db push` → 3 seeds → `next dev` on :3100 → 55 suites + 3 functional scripts) | **0** | `ALL TEST SUITES PASSED` — **678 bun assertions / 55 suite files, 0 failures**; functional acceptance scripts: Phase 1 **93/93**, Phase 2 **79/79**, Phase 6.3 **62/62** (**234 functional checks ✅, 0 ❌**). CRM suite alone: **63 pass, 0 fail** (`bun run scripts/run-tests.ts` step 4). |
| `npx tsc --noEmit` | **0** | no type errors |
| `npx eslint .` | **0** | no errors / warnings |
| `npx prettier --check` on every file this branch touches | **0** | clean (`src/lib/billing.ts` is already non-conformant at `HEAD` and is intentionally left untouched — verified against a pristine `HEAD` copy, so reformatting it would add ~900 lines of unrelated diff) |
| `bun run build` | **1** | Blocked in this sandbox — see below. |

**About `bun run build`:** the compile phase passes (`✓ Compiled successfully`, `✓ Finished TypeScript`), but the *page-data collection* phase fails with `PrismaClientInitializationError: Missing configured driver adapter … at src/lib/db.ts:152` for every API route. Root cause is environmental, not this branch: `bun run build` generates the client from `prisma/schema.postgres.prisma` with the classic binary engine, which downloads from `binaries.prisma.sh` — a host this sandbox cannot reach. The only client that can be generated offline here is the JS/WASM one (`prisma/schema.test.prisma`), and it needs a runtime driver adapter that production code does not supply. **Verified identical on pristine `HEAD`** (same route, same message, `git stash -u` → rebuild → `EXIT=1`), so this is not a regression. CI has unrestricted egress and runs the real build; its result is still pending at the time of writing and must be green before merge.

## 6. Limitations / follow-ups

- The list computes the summary (and the aggregate sorts) from every matching
  customer and its visits/orders, matching the pre-existing pattern in this
  route. It is fine for the plan sizes in use (≤ 5,000 customers); a
  `groupBy`-based aggregate rollup is the next step if a tenant outgrows it.
- Automatic customer creation happens only on **paid** bills. Unpaid/void bills
  and QR orders that never become a bill stay anonymous by design (guest
  checkout).
- `bill.customerId` is not written back when the guest is created at payment
  time — the link lives on the recorded `RestaurantVisit` and the follow-up job.
- Loyalty is reported from `LoyaltyAccount` (the live program). The legacy
  `Customer.loyaltyPoints` column is untouched.
- Phone masking stays a display concern; the authorized CRM flow still returns
  the full number (unchanged, intentional — see `tests/privacy-phone.test.ts`).
