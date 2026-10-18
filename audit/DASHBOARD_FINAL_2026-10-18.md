# StayLoop / Byato dashboard audit — final report — 2026-10-18

Branch: `arena/4e49304e-byato`

## Executive result

The dashboard audit found and fixed six confirmed dashboard correctness, resilience, consistency, and privacy issues. The fixes stay inside the existing dashboard/API/service conventions; no authentication, authorization, tenant scoping, migrations, or production data were weakened or changed.

The dashboard regression suite and the full repository harness pass after the fixes. The exact production build remains **BLOCKED** by the sandbox's inability to download the Prisma schema engine from `binaries.prisma.sh`; a synthetic engine-stub build previously compiled successfully, but it is not a production-runtime verification. Browser automation, live PostgreSQL/Redis, and external providers were unavailable and are reported as unverified below.

The pre-edit evidence is preserved in [`DASHBOARD_BASELINE_2026-10-18.md`](./DASHBOARD_BASELINE_2026-10-18.md).

## Confirmed findings and fixes

### DASH-001 — Hotel-local dashboard visit trend was classified in the wrong calendar — Medium

- **Paths:** `src/app/api/dashboard/stats/route.ts`, `src/lib/timezone-core.ts`, `src/lib/format.ts`, `src/components/app/dashboard-view.tsx`
- **Reproduction:** with a hotel in `Asia/Kolkata`, a visit at `2026-10-05T18:45:00Z` is `2026-10-06 00:15` for the hotel. The old stats route built the window with server-local `setHours`/`setDate` and bucketed with `toISOString().slice(0, 10)`, so a UTC/server boundary could assign the visit to the wrong displayed day or exclude it from the 14-day window. The old client also parsed a date-only label as a browser-local instant.
- **Root cause:** UTC/server calendar operations were used for a tenant-local calendar metric; date-only API labels were parsed as instants in the browser.
- **Impact:** incorrect visit counts and labels around UTC midnight, with additional DST risk for non-India tenants.
- **Fix:** obtain and validate the hotel's IANA timezone; compute one shared 14-day local window from one `now` instant; query `[start, end)` bounds; bucket by `zonedDayKey`; format date keys at UTC without parsing them as viewer-local dates. Pure helpers live in the client-safe `timezone-core.ts`.
- **Regression coverage:** dashboard trend boundary test, viewer-timezone label test, DST 23-hour-day test, existing tenant-local day-bound tests, and the client-bundle import guard all pass.

### DASH-002 — Dashboard consent metrics used inconsistent customer populations — Medium

- **Paths:** `src/app/api/dashboard/stats/route.ts`, `src/lib/dashboard.ts`
- **Reproduction:** an inactive customer with `optOut = true` was included in `optedOut`, while `totalCustomers` and `marketingOptIn` were active-only. That could produce a consent chart that did not reconcile with the displayed active-customer total and could make the computed no-consent bucket negative.
- **Root cause:** the `optedOut` count omitted the `status = ACTIVE` predicate; the no-consent calculation was also clamped with `Math.max`, which masked count invariants.
- **Impact:** misleading current CRM reach and consent health.
- **Fix:** scope opted-out customers to active records and centralize the count relationship in `dashboardConsentStatsFromCounts`; inconsistent inputs remain observable rather than being silently converted to zero.
- **Regression coverage:** active/inactive fixture, count relationship/invariant test, and route predicate guard pass.

### DASH-003 — Analytics used a different current-customer denominator — Medium

- **Paths:** `src/app/api/analytics/overview/route.ts`, `src/lib/segments.ts`
- **Reproduction:** analytics loaded all customer rows and used `intel.length` for segment/consent totals, while the main dashboard used active customers. Historical inactive records therefore changed analytics totals without changing dashboard totals.
- **Root cause:** analytics did not apply the active-customer population policy used by the dashboard.
- **Impact:** dashboard and analytics disagreed about the size of the current guest book and consent health.
- **Fix:** load analytics intelligence with the database-level `ACTIVE` predicate and retain an explicit active filter at the response boundary. The generic segmentation loader remains able to load either all statuses or a requested status for its other callers.
- **Regression coverage:** analytics source/contract guard and full Phase 2 acceptance suite pass.

### DASH-004 — Owner Reports hid failures and could crash on persisted schedule data — Medium

- **Paths:** `src/components/app/reports-view.tsx`, `src/lib/dashboard.ts`
- **Reproduction:** when `/api/reports/sales` failed, optional chaining rendered zero-valued cards and an empty payment message, making an unknown result look like a real zero. A malformed `ReportSchedule.recipients` JSON value caused `JSON.parse` during render or a switch mutation to throw. The frequency state also initialized to `DAILY` and could override a stored `WEEKLY` value before the query state was reflected.
- **Root cause:** missing query loading/error branches, unsafe render-time JSON parsing, and component state initialized to a real schedule value rather than an unset value.
- **Impact:** false financial display, a potentially unusable Reports view, and incorrect schedule edits.
- **Fix:** add skeleton/loading states, explicit error/empty messaging, retry buttons, safe recipient parsing, controlled schedule fields that defer to server values, and mutation disabling while saving. Failed reports are no longer represented as zero.
- **Regression coverage:** malformed-recipient parser tests plus source guards for loading, error, retry, schedule error, and no direct `JSON.parse`; targeted dashboard suite passes.

### DASH-005 — Sales report accepted impossible dates and returned an incompatible error shape — Medium

- **Paths:** `src/app/api/reports/sales/route.ts`, `src/lib/timezone-core.ts`
- **Reproduction:** the old route checked only the `YYYY-MM-DD` shape, so `2026-02-29` passed validation and was normalized by JavaScript date math. Its timezone error response was a plain `{ error: string }`, while the shared browser API client reads the structured `{ error: { code, message } }` contract.
- **Root cause:** shape-only date validation and a route-local error response format.
- **Impact:** wrong business-day windows for impossible dates and generic/misleading client errors.
- **Fix:** validate real Gregorian calendar keys with `isValidDateKey`, derive the default date with `zonedDayKey`, and use structured `jsonError` responses for invalid dates and timezones.
- **Regression coverage:** impossible-date test, sales route contract guards, existing tenant-local sales-day tests, and full harness pass.

### DASH-006 — Dashboard recent-customer responses exposed unused contact/consent fields — Low

- **Paths:** `src/app/api/dashboard/stats/route.ts`, `src/lib/types.ts`
- **Reproduction:** the dashboard selected and returned customer phone and marketing-consent fields even though the activity UI rendered only `id`, `name`, and `createdAt`.
- **Root cause:** an over-broad Prisma select and corresponding client type.
- **Impact:** unnecessary sensitive data exposure to browser memory, network responses, and client-side tooling for an authorized dashboard view.
- **Fix:** select only the rendered fields, scope recent customers to active records, and minimize `DashboardData.recentCustomers`.
- **Regression coverage:** route select/privacy guard and full security/functional harness pass.

## Areas audited with no new confirmed defect

- **Server authentication/authorization:** dashboard, analytics, sales, and report-schedule routes retain `requireAuth` plus their existing permission checks. No client-only permission decision was added. The full harness includes unauthenticated and cross-tenant checks; navigation/RBAC source tests pass.
- **Tenant isolation:** all modified dashboard queries remain keyed by the authenticated `hotelId`; the new timezone lookup is also keyed by that ID. No user-supplied hotel ID was introduced.
- **Navigation:** existing role-specific navigation and routing guards pass the full `navigation-rbac` suite. Browser navigation was not independently exercised.
- **Chart empty state:** the dashboard retains an explicit no-visit empty state and now receives stable date labels. Analytics has an explicit loading/error/retry path.
- **Secrets:** no environment files, credentials, tokens, or database values were added. The tracked-file secret scan is clean.

## Potential risks and remaining work

These are not reported as confirmed dashboard bugs because the relevant live or browser verification was unavailable:

1. **Browser/UI verification pending — NOT TESTED.** No browser automation or live preview session was available for responsive layout, chart tooltips, keyboard/focus behavior, actual navigation clicks, or visual confirmation of loading/error/empty states.
2. **Production database/runtime pending — BLOCKED.** No live PostgreSQL, Redis, email, SMS/WhatsApp, or analytics provider was available. SQLite used by the disposable harness is test infrastructure and was not proposed as a production substitute.
3. **Production build prerequisite pending — BLOCKED.** `npm run build` cannot download the Prisma schema engine in this sandbox. The successful synthetic build used diagnostic engine stubs only to test Next compilation and is not evidence that a deployed Prisma runtime can connect.
4. **Analytics scale risk — potential.** Segment intelligence still evaluates visit-derived rules in application code. The analytics path now filters active customers in SQL, reducing the population, but large-tenant query/CPU behavior should be measured with approved PostgreSQL data and production-like volumes.
5. **Repository hygiene — pre-existing.** `npm ci --ignore-scripts` is blocked by existing npm lockfile/package metadata drift; the workaround install used no lockfile write and left `package-lock.json` unchanged. The repository's full format check reports 154 pre-existing files; all files changed by this audit pass targeted Prettier checks. No broad formatting rewrite was performed.
6. **Dependency audit — development-only risk.** `npm audit --omit=dev --audit-level=high` reports zero runtime vulnerabilities. Full `npm audit --audit-level=high` reports five high-severity development-tool findings through `braces`/`eslint-config-next`; `npm audit fix --force` was not run because the suggested change is breaking and unrelated to the dashboard repair.

## Changed files

- `audit/DASHBOARD_BASELINE_2026-10-18.md` — pre-edit discovery and hypotheses, preserved as the baseline.
- `audit/DASHBOARD_FINAL_2026-10-18.md` — this final audit report.
- `src/app/api/dashboard/stats/route.ts` — active consent counts, tenant-local trend bounds/bucketing, minimized recent-customer selection.
- `src/app/api/analytics/overview/route.ts` — active-customer analytics denominator.
- `src/app/api/reports/sales/route.ts` — strict date validation, tenant-local default date, structured errors.
- `src/components/app/dashboard-view.tsx` — stable date-key labels and existing dashboard error/retry behavior retained.
- `src/components/app/analytics-view.tsx` — explicit analytics error/retry state.
- `src/components/app/reports-view.tsx` — loading/error/empty states and defensive schedule editing/parsing.
- `src/lib/dashboard.ts` — pure consent/trend/recipient helpers.
- `src/lib/timezone-core.ts` — browser-safe pure IANA/calendar helpers.
- `src/lib/timezone.ts` — server-facing re-export plus lazy hotel database lookup.
- `src/lib/format.ts` — timezone-independent date-key formatting.
- `src/lib/segments.ts` — optional status predicate for efficient analytics loading; existing all-status callers remain unchanged.
- `src/lib/types.ts` — minimized dashboard recent-customer type.
- `scripts/run-tests.ts` — dashboard regression suite registration and formatting.
- `tests/dashboard-regressions.test.ts` — 14 deterministic tests / 36 expectations covering the fixes and build guard.

## Exact verification status

| Check | Status | Evidence / limitation |
| --- | --- | --- |
| `npm run lint` | **PASS** | ESLint completed with exit 0 after the final source changes. |
| `npm run typecheck` | **PASS** | `tsc --noEmit` completed with exit 0 using the generated test client. |
| Dashboard regression suite | **PASS** | 14 tests, 36 expectations; targeted Bun run and full harness run. |
| Full `PATH="$PWD/node_modules/.bin:$PATH" bun run test` | **PASS** | Exit 0; dashboard suite 14/14, security-hardening 10/10, navigation/RBAC 12/12, bugfix regression suite 24/24, plus integration sections 93/93, 79/79, and 62/62. |
| Both Prisma schema validations | **PASS** | `prisma/schema.prisma` and `prisma/schema.postgres.prisma` parsed successfully with diagnostic engine-path overrides; this is schema validation, not live DB health. |
| Prisma schema/model drift checks | **PASS** | Existing test-schema drift guard and build-mode contract passed; no schema or migration files changed. |
| `npm run scan:secrets` | **PASS** | Tracked-file scanner reports clean. |
| Runtime dependency audit | **PASS** | `npm audit --omit=dev --audit-level=high`: zero vulnerabilities. |
| Full dependency audit | **FAIL / pre-existing risk** | Five high development-tool findings; no forced/breaking dependency update applied. |
| Targeted Prettier checks | **PASS** | All changed TypeScript/TSX files pass. |
| `git diff --check` | **PASS** | No whitespace errors. |
| `npm run format:check` | **FAIL / pre-existing** | 154 repository files are already not formatted; changed files pass targeted checks. |
| Exact `npm run build` | **BLOCKED** | Prisma download failed before Next build: TLS/network failure reaching `binaries.prisma.sh`. |
| Diagnostic synthetic Next build | **PASS — compilation only** | Compiled/typechecked/collected pages with engine stubs; emitted expected engine-initialization/tracing caveats, so not a production runtime pass. |
| Browser dashboard/E2E | **NOT TESTED** | No browser runner or live browser session available. |
| Live PostgreSQL/Redis/providers | **BLOCKED** | No approved live services or credentials available; no live health claim made. |
| Production migration/deploy rehearsal | **NOT TESTED** | No migration was created or run; deployment remains gated on normal engine-enabled build and environment verification. |

## Deployment safety

This patch is migration-free and keeps server-side authentication, permissions, tenant predicates, and bootstrap/account security intact. It is safe to review and deploy from a code/data-shape perspective only after CI or an approved build environment can complete the normal PostgreSQL Prisma generation and production build. Before release, run the exact build with the real deployment environment (without diagnostic engine overrides), then perform authenticated browser smoke tests for dashboard, analytics, and Owner Reports, plus tenant-isolation checks against an approved disposable PostgreSQL environment. Do not run destructive migrations or point the test harness at production data.
