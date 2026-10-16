# TEST_REPORT.md — Merged StayLoop Repository

**Date:** 2026-10-16
**Environment:** Linux sandbox, Bun 1.3.14, Node v24.21.0, npm 11.19.0, 4 GB RAM.
**Test data:** synthetic seed data only (fresh throwaway SQLite database per run, known test passwords `TestAdmin123`/`TestStaff123`, deterministic test secrets). No real customer data, no real payment transactions, no live provider calls (mock email adapter; gateway flows tested at signature/state level).

---

## 1. How the Suite Was Executed

The repository's own harness (`scripts/run-tests.ts` via `bun run test`) boots a fresh seeded SQLite database, a dev-mode Next.js server on :3100, then runs each of the 41 registered test files in an isolated `bun test` process with per-file timeouts (30 s standard, 120 s for the phase 11/14/15/16/17 suites that spawn Prisma CLI and compile many routes), health-checking and restarting the server between files, and finally runs the three acceptance suites (phase1, phase2, phase63).

This sandbox reaps background processes (~1–2 minutes after the spawning shell returns), so the full single-process run could not complete in the background. The suite was therefore executed **in five sequential chunks** using a runner that replicates the harness exactly (same fresh-DB setup, same seed scripts, same server environment and secrets, same per-file timeouts, same watchdog restart): `bash scripts/chunk-test.sh <range>` (script kept outside the deliverable at `/home/z/my-project/scripts/chunk-test.sh`). One file (`phase14-billing`) was re-run standalone to capture named results. The registration gate ("every `tests/*.test.ts` must be listed in `TEST_FILES`") was satisfied — no unregistered-suite failures.

---

## 2. Results Summary

### 2.1 Environment & dependency checks

| # | Check | Result |
|---|---|---|
| 1 | Dependency/lockfile consistency — `bun install --frozen-lockfile` | **PASS** (561 packages, zero drift vs `bun.lock`) |
| 2 | `prisma validate` — SQLite dev schema (`prisma/schema.prisma`) | **PASS** |
| 3 | `prisma validate` — PostgreSQL prod schema (`prisma/schema.postgres.prisma`) | **PASS** (required synthetic `DATABASE_URL=postgresql://…`; see §4.1) |
| 4 | `prisma generate` (SQLite schema) | **PASS** (client v6.19.3 generated) |
| 5 | TypeScript — `tsc --noEmit` | **PASS** (0 errors) |
| 6 | ESLint — `eslint .` | **PASS** (0 errors, 0 warnings) |
| 7 | Secret scan infrastructure | present in CI (`scripts/scan-secrets.ts`); no secrets in repo |
| 8 | Production build — `npm run build` (the exact Netlify command) | **PASS** — BUILD_ID `R7hQPBv3xABNO1zPSCfQd`, default output (no `.next/standalone` — correct for Netlify), all routes + middleware compiled, everything dynamic server-rendered |
| 9 | Standalone build — `npm run build:standalone` (Docker/VPS path) | **PASS** — `.next/standalone/server.js` + static assets produced |
| 10 | Migration consistency | migration 0013 restored; 0001–0012 unchanged; PostgreSQL `migrate diff` parity is enforced by CI (PostgreSQL 16 service) — **BLOCKED** in this sandbox (no PostgreSQL server available); see §4.2 |

### 2.2 Integration suites (41 registered files, per-file isolation)

| Chunk | Files | Result |
|---|---|---|
| 1 (tests 1–6) | auth, lockout, navigation-rbac, phase64, phase7, privacy-phone | **63 pass / 0 fail** |
| 2 (tests 7–16) | rbac-tenant, security, super-admin-platform, phase10-saas, unit, **qr-injection-regression (new)**, queue-reliability, ops-reliability, deployment-config, restore-args | **159 pass / 0 fail** |
| 3 (tests 17–26) | crypto-rotation, billing-outbox, export-quota, backup-schedule, bootstrap-atomicity, audit-fixes, recheck-fixes, phase11-scheduler, phase12-menu, phase13-orders | **96 pass / 0 fail** |
| 4 (tests 27–31) | **phase14-billing**, phase15-retention, phase16-operations, phase17-enterprise, phase18-ai | **97 pass / 0 fail** |
| 5 (tests 32–41) | audit-2026-regressions, bugfix-regressions-2026-10, custom-role-resolution, custom-role-api, payment-link-limit, payment-link-settle, payment-callback-routes, import-cycle-regression, config-secret-stability | **62 pass / 0 fail** |

**Integration total: 477 pass / 0 fail / 0 skipped.**

### 2.3 Functional acceptance suites

| Suite | Result |
|---|---|
| `scripts/test-phase1.ts` | **93 passed / 0 failed** |
| `scripts/test-phase2.ts` | **79 passed / 0 failed** |
| `scripts/test-phase63.ts` | **62 passed / 0 failed** |

**Acceptance total: 234 pass / 0 fail. Grand total: 711 passing, 0 failing, 0 skipped.**

### 2.4 Merge-critical tests (explicitly named)

| Behavior under test | Suite / test | Result |
|---|---|---|
| Duplicate payment: same idempotency key returns the SAME paymentId, does not double-allocate; bill shows 1 payment / paidMinor unchanged | `phase14-billing` — "payment idempotency: same key does not double-allocate" | **PASS** |
| Reused idempotency key with a **different amount** is **rejected (422)** | `phase14-billing` (restored assertions) | **PASS** |
| Partial refund sets bill status `PARTIALLY_REFUNDED`; refund cap enforced | `phase14-billing` — "partial refund then refund cap enforcement" | **PASS** |
| Bill-creation idempotency; double-billing same orders rejected | `phase14-billing` | **PASS** |
| Cross-tenant bill ID → 404; unauthenticated bill access denied; kitchen cannot pay; cashier cannot refund | `phase14-billing` | **PASS** |
| Malicious QR label/URL payloads neutralized (script tags, `onerror`, single-quote breakout, double-escape ordering) | `qr-injection-regression` (new, 16 tests) | **PASS** |
| QR origin scheme validation (`javascript:`/`data:`/`vbscript:`/garbage rejected) | `qr-injection-regression` | **PASS** |
| Netlify/Docker build-config invariants (default output on Netlify; standalone only via `build:standalone`) | `deployment-config` (16 tests) | **PASS** |
| Deterministic test secrets (no adoption race) | `config-secret-stability` (5 tests) | **PASS** |
| Webhook security (missing/invalid signature, replay window, query-string secret refused) | `security` + `payment-callback-routes` + `payment-link-settle` | **PASS** |
| Tenant isolation (cross-tenant customer read/update/delete denied; super-admin APIs reject hotel users) | `rbac-tenant` + `super-admin-platform` | **PASS** |

### 2.5 Failure cases exercised

The suites cover the required failure scenarios: invalid credentials and malformed payloads (auth), account lockout (lockout), expired/revoked sessions (auth, `SESSION_REVOKED` after `tokenVersion` bump), unauthorized admin actions (RBAC suites, "kitchen cannot pay", "cashier cannot refund"), cross-tenant resource access (404/denied), duplicate payment requests (single allocation), idempotency-key reuse with conflicting data (422), invalid webhook signatures/garbage with no secret (401/503, never 200), malicious QR labels (escaped), unconfigured webhook secret (503), and rate limiting (payment-link limit). Missing database configuration is fail-closed at startup by design (production requires `DATABASE_URL` postgres — enforced in `src/lib/db.ts`; see §4.1 for the sandbox note).

---

## 3. What Was NOT Run (BLOCKED) — and Why

| # | Item | Status | Blocker |
|---|---|---|---|
| B-1 | `prisma migrate diff` parity + migration application against a live **PostgreSQL 16** server | **BLOCKED** | No PostgreSQL server can run in this sandbox. CI (`.github/workflows/ci.yml`) performs exactly this check on every push with a PostgreSQL 16 service — run the pipeline once on GitHub to discharge it. The SQLite path (`prisma db push` from the same schema set) executed cleanly 6× during chunked runs. |
| B-2 | Live Razorpay/Twilio/WhatsApp/SMTP integration flows | **BLOCKED** | No sandbox credentials available (by policy, no live calls). Signature logic, state machines, and fail-closed behaviors are covered by unit/integration suites. |
| B-3 | Netlify end-to-end deploy (real Runner + domain) | **BLOCKED** | Requires Netlify account access. The exact build command (`npm run build`) was executed locally and passed with the correct output shape; `tests/deployment-config.test.ts` (16 tests) pins the config invariants. |
| B-4 | Redis-backed distributed rate limiting / queue behavior | **BLOCKED** | No Redis server in the sandbox. In-process fallbacks are exercised by the suites; CI runs a Redis 7 service. |
| B-5 | Browser/DOM-level E2E (CSP enforcement in a real browser, print-window rendering) | **BLOCKED** | No headless browser in this environment. |
| B-6 | Docker image build + container startup + health checks + Trivy scan | **BLOCKED** (not attempted) | Docker daemon not available in this sandbox. CI covers this on GitHub runners. The standalone build that the Dockerfile invokes (`build:standalone`) was verified to produce `server.js` + assets. |
| B-7 | Backup encryption / restore round-trip against PostgreSQL (`scripts/restore-backup.ts`) | **BLOCKED** | Requires a live PostgreSQL + `pg_dump`/`pg_restore`. Test-mode backup logic is covered by `ops-reliability` + `backup-schedule` (both green). |

No result above has been reported as passed without execution; BLOCKED items are explicitly listed rather than assumed.

---

## 4. Environment Notes & Discrepancies Encountered

1. **Sandbox-injected `DATABASE_URL=file:/home/z/my-project/db/custom.db`.** The sandbox exports a global SQLite `DATABASE_URL`, which `prisma validate` picks up for the PostgreSQL schema (rejecting the `file:` protocol). Validation/generation/build were performed with an explicit synthetic `postgresql://` URL — a sandbox artifact, not a repository defect. Production code itself fails closed when `DATABASE_URL` is not PostgreSQL (by design).
2. **Background-process reaping.** The sandbox kills background processes 1–2 minutes after the spawning shell call returns (verified with a heartbeat process). This forced the chunked execution strategy (§1); each chunk is a faithful replication of the harness environment, and one suite (`phase14-billing`) was re-verified standalone.
3. **One historical note:** a 2026-10-11 audit stated "`next build` fails in this sandbox on Google Fonts". The codebase now ships local Geist font files (`src/app/fonts/`), and the production build passes here — that blocker no longer exists.

---

## 5. Test Infrastructure Changes Made in This Merge

- `tests/qr-injection-regression.test.ts` added (16 tests) and registered in `scripts/run-tests.ts` (the registration gate would fail the run otherwise).
- `tests/phase14-billing.test.ts` restored to the original's full assertions (the fixed fork had deleted the mismatched-replay and PARTIALLY_REFUNDED assertions).
- `tests/config-secret-stability.test.ts` (fixed fork) retained and registered.
- No test was modified to pass. No assertion was weakened.
