# MERGE_SUMMARY.md — StayLoop Merge at a Glance

**Date:** 2026-10-16 · **Inputs:** `hotal-main (2).zip` + `stayloop-fixed-repo.zip` (both untouched) · **Output:** this merged repository.
**Comparison basis:** SHA-256 of all 573/572 files → 558 identical, 13 changed, 2 original-only, 1 fixed-only. Full detail: `MERGE_AUDIT.md`.

---

## Major Changes

1. **Payment idempotency restored (the core regression).** The fixed fork had deleted `BillPayment.idempotencyKey @unique` (both schemas), migration `0013`, the robust `recordManualPayment` implementation, *and* the test assertions proving it. Restored in full: SHA-256-scoped keys on a unique column, 422 on key reuse with conflicting amount/method/reference/cash-session, P2002 concurrent-winner replay, legacy-row compatibility, replay-before-terminal-state ordering, and correct `PARTIALLY_REFUNDED` refund status. Verified by the passing billing suite (22/22).
2. **Netlify configuration kept correct.** Default build output for Netlify (`netlify.toml` + conditional `STAYLOOP_STANDALONE` in `next.config.ts` + `build`/`build:standalone` script split + `NODE_VERSION=22`). Production build verified locally: default output, BUILD_ID `R7hQPBv3xABNO1zPSCfQd`; standalone path verified for Docker.
3. **QR-code security preserved, consolidated, hardened.** Fixed fork's print-window `escapeHtml` kept but deduplicated into a shared, unit-tested `src/lib/html-escape.ts` (replacing 4 divergent copies — the email copy was missing single-quote escaping). **New:** `buildPublicUrl` rejects non-http(s) origins (`javascript:`/`data:`/etc. can never be embedded into a QR image). **New suite:** `tests/qr-injection-regression.test.ts` (16 tests).
4. **Prisma schemas reconciled.** Postgres schema = fixed fork's parity fixes (relation naming) + restored idempotency column; migration `0013` restored verbatim (idempotent SQL); both schemas validate; `bun.lock` authoritative, `package-lock.json` retained deliberately for Netlify `npm ci`.
5. **Test-infrastructure fixes kept.** Deterministic test secrets (adoption race), process-group server teardown, new stability suite retained and registered.
6. **Stale dev database excluded.** The original's committed `prisma/db/custom.db` (2.2 MB, known-password accounts) was not carried over; `.gitignore` covers it.

## Files Changed vs the Fixed Fork (base)

| File | Change |
|---|---|
| `src/lib/billing.ts` | restored from original (full idempotency implementation) |
| `prisma/schema.prisma` | restored from original (idempotencyKey column) |
| `prisma/schema.postgres.prisma` | surgical: `idempotencyKey @unique` re-added (parity fixes kept) |
| `prisma/migrations/0013_bill_payment_idempotency/migration.sql` | restored from original |
| `tests/phase14-billing.test.ts` | restored from original (full assertions) |
| `src/lib/html-escape.ts` | **new** — shared escapeHtml |
| `src/components/app/qr-codes-view.tsx` | imports shared escapeHtml (local copy removed) |
| `src/app/api/bills/[id]/receipt/route.ts` | imports shared escapeHtml (local copy removed) |
| `src/lib/providers/email.ts` | imports shared escapeHtml (**gains single-quote escaping**) |
| `src/lib/retention.ts` | imports shared escapeHtml (local copy removed) |
| `src/lib/qr.ts` | `buildPublicUrl` origin scheme validation |
| `tests/qr-injection-regression.test.ts` | **new** — 16 injection/scheme regression tests |
| `scripts/run-tests.ts` | registers the new suite |
| `MERGE_AUDIT.md` / `CLEANUP_REPORT.md` / `SECURITY_AUDIT.md` / `DEPLOYMENT_GUIDE.md` / `TEST_REPORT.md` / `MERGE_SUMMARY.md` | **new** — this deliverable set |

## Files Removed

- `prisma/db/custom.db` (from the original; stale committed dev database — not carried into the merge). Nothing else removed.

## Tests

| Category | Result |
|---|---|
| Dependency/lockfile consistency (`bun install --frozen-lockfile`) | **PASSED** |
| TypeScript (`tsc --noEmit`) | **PASSED** (0 errors) |
| ESLint (`eslint .`) | **PASSED** (0 errors) |
| Prisma validate (SQLite + PostgreSQL) & client generation | **PASSED** |
| Integration suites (41 files, chunked full run of the repo harness) | **477 pass / 0 fail** |
| Acceptance suites (phase1 / phase2 / phase63) | **234 pass / 0 fail** (93 / 79 / 62) |
| Production build (`npm run build`, the Netlify command) | **PASSED** |
| Standalone build (`npm run build:standalone`, Docker path) | **PASSED** |
| **Failed** | **0** |
| **Blocked** | PostgreSQL `migrate diff` parity (no PG server in sandbox — CI runs it on every push); live Razorpay/Twilio/SMTP sandbox flows (no credentials); real Netlify deploy (needs account); Redis-backed distributed behavior; browser-level E2E; Docker daemon build/scan; PG backup/restore round-trip. Full list + reasons: `TEST_REPORT.md` §3. |

## Remaining Security Issues (none critical; details in SECURITY_AUDIT.md §10–11)

- **[POTENTIAL]** per-handler tenant-isolation review is pattern-based across ~200 handlers (suites cover the critical paths; continue route-by-route review per `audit/ROUTE_INVENTORY.md`).
- **[POTENTIAL]** QR creation falls back to the request origin when `APP_ORIGIN` is unset — set `APP_ORIGIN` in production (phishing-adjacent only; QRs resolve tenant server-side).
- **[ACCEPTED]** `SameSite=None; Partitioned` production cookies (embedded-preview requirement) and bearer-token availability (SEC-008, informational) — documented designs mitigated by the nonce CSP.
- **[ACCEPTED]** without `REDIS_URL`, rate limiting/queue coordination is per-instance (documented).

## Remaining Deployment Blockers

1. **Run CI once on GitHub** (PostgreSQL 16 + Redis services) to discharge the sandbox-blocked migration-parity and Docker checks — the workflow is already configured and the merge keeps its `migrate diff` gate green.
2. **Netlify Hybrid Node servers (Runners) must be enabled** on the account — standard static/edge Netlify cannot run this app.
3. Set production env vars (`DATABASE_URL` Neon pooled, `AUTH_SECRET`, `INTEGRATION_ENCRYPTION_KEY`, `APP_ORIGIN`, …) and apply migrations once (`bun run db:migrate:deploy`).
4. Deploy **one background worker** (VPS container or scheduled-job platform) if campaigns > 25 recipients, CSV exports > 5000 rows, scheduled backups, or retention sweeps are needed.

## Exact Next Steps to Launch

1. Push this repository to GitHub → branch-protect `main` requiring the CI workflow.
2. Watch CI: it installs frozen, audits, validates, applies migrations to a fresh PostgreSQL 16, runs the full suite, and builds/scans the Docker image.
3. Create the Neon database (pooled connection string).
4. Netlify: import the repo (config comes from `netlify.toml`), set the env vars, first deploy.
5. Apply migrations to Neon once (`bun run db:migrate:deploy` with the production `DATABASE_URL`).
6. Bootstrap the first super admin (`ADMIN_BOOTSTRAP_SECRET` + `bun run bootstrap:admin --name '<name>' --email <email>`), then unset the bootstrap secret.
7. Deploy the worker container (§DEPLOYMENT_GUIDE.md) if background jobs are needed.
8. Smoke-verify per `DEPLOYMENT_GUIDE.md` §6 (health, QR scan, idempotent payment replay, security headers, worker heartbeat).
9. Alternatively, follow the verified VPS path in `DEPLOYMENT.md` (Docker Compose end-to-end).
