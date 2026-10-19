# BYATO — Bug Report (audit 2026-10-18)

All bugs below were **confirmed by reproduction** (command + observed output), root-caused, and — where fixed — re-verified. Severity scale: Critical (data loss / security breach) · High (broken core workflow / production failure) · Medium (degraded assurance) · Low (cosmetic / dev-only).

---

## Fixed in this audit (branch `audit/byato-feature-verification`)

### BUG-1 — Test suite registration gap (Medium, test-infrastructure)
- **Files:** `scripts/run-tests.ts` (TEST_FILES), `tests/export-policy.test.ts`
- **Symptom:** `bun run test` printed `✗ Test files missing from TEST_FILES: tests/export-policy.test.ts` and failed the harness guard; `tests/export-policy.test.ts` (CSV export inline-size boundary policy) was silently never executed by `bun run test` or CI.
- **Repro (before fix):** `bun run test` → `3 test suite(s) FAILED`; guard message names the missing file.
- **Root cause:** the suite was added to `tests/` without registering it in the runner's TEST_FILES array.
- **Fix:** registered `tests/export-policy.test.ts` in TEST_FILES (next to the related `export-quota` suite).
- **Re-verification:** `bun run test` → **ALL TEST SUITES PASSED**; `bun test tests/export-policy.test.ts` → 4 pass.

### BUG-2 — Stale test assertion after a11y improvement (Medium, test-infrastructure)
- **Files:** `tests/dashboard-regressions.test.ts`
- **Symptom:** `expect(shell).toContain('aria-expanded={moreOpen}')` failed; the app shell had been improved to `moreExpanded` (More section also stays open when the active view lives inside it).
- **Repro (before fix):** `bun test tests/dashboard-regressions.test.ts` → `(fail) owner dashboard usability > owner navigation keeps five everyday tasks visible…`
- **Root cause:** source was refactored (`hasActiveMoreView`/`moreExpanded`) without updating the assertion.
- **Fix:** assertions updated to the current, strictly-better contract (`aria-expanded={moreExpanded}`, `const hasActiveMoreView = …`, `const moreExpanded = moreOpen || hasActiveMoreView;`).
- **Re-verification:** suite passes (16/16).

### BUG-3 — `STAYLOOP_TEST` leak could break the production build (Medium → hardening; build failure reproduced)
- **Files:** `src/lib/db.ts` (`testDriverAdapter`)
- **Symptom (reproduced):** with `STAYLOOP_TEST=1` exported during `bun run build`, `next build` failed with
  `PrismaClientInitializationError: The Driver Adapter '@prisma/adapter-libsql', based on 'sqlite', is not compatible with the provider 'postgres'` → `Failed to collect page data`.
- **Root cause:** `testDriverAdapter()` gated on the **raw** `process.env.STAYLOOP_TEST` instead of the `isTest()` helper. `src/lib/config.ts` documents the SEC-004 policy — test-only behaviour must never activate in production even if the variable leaks (startup validation rejects it) — but `db.ts` bypassed that backstop. During `next build` (NODE_ENV=production) the SQLite adapter was force-attached to the PostgreSQL-provider client.
- **Fix:** gate on `isTest() && process.env.STAYLOOP_TEST === "1"` (production can never reach the adapter branch). Also added `/* turbopackIgnore: true */` to the two `path.resolve(process.cwd(), …)` calls in `resolveSqlitePath` that Turbopack flagged as whole-project tracing (deployment-size risk for standalone output).
- **Re-verification:** `bun run build` → **exit 0**, all routes compiled. (Normal CI never sets STAYLOOP_TEST, so this was a latent hardening gap, not a live outage; the sandbox build is how it was reproduced.)

### BUG-4 — Feature probe exercised wallet passes before enabling the opt-in flag (Low, probe contract)
- **Files:** `scripts/verify/feature-probe.ts`
- **Symptom:** `[wallet] issue loyalty wallet pass — 403 {"error":"Wallet passes are disabled for this tenant."}` — the probe issued a pass **before** the `PATCH /api/ai/settings {walletEnabled:true}` step that runs 15 lines later. The 403 is correct fail-closed product behaviour; the probe order was wrong (README claimed 26/26).
- **Fix:** probe now (a) explicitly disables the flag and asserts issuance is denied with 403 (new fail-closed regression check), then (b) enables the flag before the positive-path issue/revoke checks.
- **Re-verification:** `PROBE_BASE=… bun run scripts/verify/feature-probe.ts` → **27/27**.

### BUG-5 — Super-admin probe used a stale account contract (Low, probe contract)
- **Files:** `scripts/verify/super-admin.ts`
- **Symptom:** probe logged in with hardcoded `super@stayloop.test` / `SuperAdmin12345`, but the current bootstrap contract deliberately accepts **no password** (random temp password + mustChangePassword) — the probe could never pass against a fresh database. Additionally the backup-completion check read `body.backups[].id` while the API returns `{history:[…]}` and the trigger returns `recordId`, so the check silently never executed.
- **Fix:** probe is now self-provisioning (bootstrap → temp-password login → password change → TOTP enrollment capturing the once-returned secret, or SA_MFA_SECRET for pre-enrolled accounts) and reads `history`/`recordId`.
- **Re-verification:** **live 25/25**, including the previously-skipped end-to-end check: trigger → QUEUED → worker completes → `SUCCESS`, encrypted artifact, checksum `verified:true`.

---

## Confirmed, not fixed (documented; low severity / out of code-fix scope)

### BUG-7 — Dev-only MFA helper writes to a hardcoded absolute path (Low, dev-only)
- **File:** `scripts/dev-enroll-mfa.ts`
- **Detail:** writes the dev TOTP secret to `/home/z/my-project/.dev-mfa-secret` — a path that does not exist on any other machine (and is also convoluted: calls `beginMfaSetup` twice). Dev-only script, guarded by `assertDevOnlyScript`; no production impact.
- **Fix (recommended, not applied):** write to `process.cwd()/.dev-mfa-secret` (already gitignored) and drop the redundant first `beginMfaSetup` call.

### BUG-8 — Worker heartbeat upsert can time out on dev SQLite (Low, dev-environment)
- **Files:** `src/lib/worker-heartbeat.ts:33` (observed in worker log during the live audit run)
- **Detail:** `db.platformSetting.upsert()` intermittently returns `Operation has timed out` when the dev server and the worker write the same SQLite file from two processes (single-connection pool + file locks). The heartbeat write is best-effort and never crashes the worker; the next heartbeat succeeded and `/api/health` correctly reported `worker: ok`. Production runs PostgreSQL per the schema split (`schema.postgres.prisma`), where this contention class does not occur.
- **Fix (optional hardening):** none required for production; could add a short retry inside `setWorkerHeartbeat` for dev SQLite setups.

### DEP-002 — 5 high advisories in dev tooling (Medium, supply-chain hygiene)
- **Detail:** `npm audit` (full tree) reports 5 high: `braces` (stack-exhaustion DoS, GHSA-vfj7-8cjw-p6xm) → `micromatch` → `fast-glob` → `@next/eslint-plugin-next` → `eslint-config-next`. **Production dependencies audit clean (0 vulnerabilities).** The chain is lint-time only.
- **Fix (deferred):** upgrade the eslint toolchain when Next.js publishes a compatible `eslint-config-next` with patched transitive deps; do not bulk-force major bumps.

---

## Explicitly NOT bugs (verified correct behaviour)

- `POST /api/wallet/passes` → 403 while the tenant opt-in flag is off — fail-closed by design (`src/lib/ai/wallet.ts:56`).
- `GET /api/test/mock-emails` → 404 outside test env — dev-only surface correctly gated by `isTest()`.
- Health endpoint reporting `redis: disabled`, `rateLimiter: disabled`, `email: mock` in dev — honest component reporting, not a failure (readiness fails closed only when a *required* check is down).
- Simulation-mode campaign sends stored as `SIMULATED`, never counted as real deliveries — honest status model (`src/lib/campaigns.ts`).
- Password change revoking the current session (`SESSION_REVOKED` on the old cookie) — Phase 9 tokenVersion revocation working as specified.
