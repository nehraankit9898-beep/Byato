> Final 2026-10-18 verification: `bun run test` **PASS** (587 Bun tests in 52 files; functional 93/93 + 79/79 + 62/62), lint/typecheck/frozen install **PASS**. Native production build **BLOCKED** before compilation. See the deep-hunt report and evidence JSON for the initial failed run and remaining release gates.

# Current release blockers — 2026-10-18

Latest evidence: [DEEP_BUG_HUNT_2026-10-18.md](DEEP_BUG_HUNT_2026-10-18.md). **NOT READY for unconditional release.**

- Native production `bun run build` fails before compilation downloading the Prisma schema engine from blocked `binaries.prisma.sh`. Approved binary access and a clean standard/standalone build are still required; do not fake an engine or disable checks.
- Real PostgreSQL 16 / Neon service concurrency, drift and backup/restore remain required. All 14 migrations passed only on disposable PostgreSQL 18.6/PGlite WASM plus small existing-row fixtures. SQLite/controlled-delegate tests do not prove production locking.
- DEP-002: one unpatched **dev tooling** braces high advisory remains (GHSA-vfj7-8cjw-p6xm); full-tree high audit still exits 1. Separate actual-locked production inventory audit returns no advisories (265 package names).
- Real Razorpay/Stripe/refunds, Redis multi-instance behavior and browser/UI/accessibility checks were not performed. Existing PAY-001 code is present; its real provider/concurrency release gate remains.
- BUG-14–18 fixes and new regressions are documented. Privacy fix is customer-profile anonymization/tenant archival, not total erasure of related histories/providers/storage/backups; review legal retention and old stuck IN_PROGRESS requests manually.
- Full-suite current result and the initial ECONNRESET failure are recorded in the new report; historical passes below must not supersede current evidence.

No production database was reset, seeded or migrated. See the new report for exact disposable-database verification commands and no-DDL rollback guidance.

---

# Remaining blockers and risks — 2026-10-12

1. **High / deployment — Prisma engine unavailable**: approved egress/mirror needed for `binaries.prisma.sh` to generate Prisma client, typecheck, build, create disposable DB, run integration/tenant/auth tests and migrate/restore. Do not substitute fake client or mark tests PASS. `bunx prisma generate --schema prisma/schema.prisma` fails downloading pinned schema engine. On a controlled CI runner with network and PostgreSQL 16, rerun commands in `DATABASE_AND_MIGRATIONS.md`.
2. **Medium / financial — PAY-001 (code fixed, real DB + Razorpay sandbox still pending)**: `verify` no longer swallows link-settle failure (retry → `PAYMENT_LINK_SETTLE_FAILED` audit → retryable 503). The Razorpay restaurant webhook now also settles the originating payment link (id read from our own intent `meta`), releasing the dedupe fence + 503 on failure so the provider retries. Covered by DB-free route tests with in-memory fakes (`tests/payment-callback-routes.test.ts`, `tests/payment-link-settle.test.ts`: duplicate delivery, DB timeout, link-settle failure + retry, forged signature, replay). NOT verified: real PostgreSQL transactions/concurrency and a real Razorpay sandbox round trip (needs Prisma engine + sandbox keys, unavailable here).
3. **High / dependencies — DEP-002**: `bun audit --audit-level=high` returned 26 high advisories. Triage reachable runtime paths and compatible fixes; do not bulk-upgrade blindly.
4. **High / authorization verification — FUNC-001**: only mocked-delegate tests ran. Execute `tests/custom-role-api.test.ts` and whole `bun run test` against disposable DB; check transaction behavior and branch memberships under concurrency. No browser admin/owner test.
5. **High / coverage**: tenant-owned models, payment refunds, privacy exports, campaign consent, scheduled jobs, support impersonation, MFA recovery, backup/restore and external providers NOT TESTED. Prior historical source audits are not live assurance.
6. **Operational**: Redis required for shared limits at scale; checkout rate limiter falls back to per-process without it. No distributed test. No Docker image scan, live health check, Pg restore or production TLS check.

Decision: **NOT READY**. No production deployment or provider verification may be claimed. Explicit owner/security review required after outstanding checks pass.
