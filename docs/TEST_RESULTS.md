# BYATO — Test Results & Evidence (audit 2026-10-18)

Every command below was actually executed in this workspace. Outputs are quoted verbatim (truncated where noted). Exit codes recorded. Nothing was fabricated; where a check could not run, the limitation is stated.

**Environment:** Node v22.22.3, npm 10.9.8, Bun 1.4.3 (installed from npm registry during the audit — the repo assumes Bun ≥1.3), Prisma 6.19.3. Sandbox network egress is restricted to github.com / registry.npmjs.org / pypi.org — **`binaries.prisma.sh` is unreachable**, so native Prisma engine binaries cannot be downloaded.

---

## 1. Automated checks (Phase 7)

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `npm install` | 1 (postinstall) | Packages installed; `postinstall`→`prisma generate` failed downloading the schema engine from binaries.prisma.sh (blocked host). **Workaround (project's own designed path):** `STAYLOOP_TEST=1` selects `prisma/schema.test.prisma` whose generator uses `engineType="client"` (pure-JS/WASM, no native binary). `STAYLOOP_TEST=1 DATABASE_URL=file:… npx prisma generate --schema prisma/schema.test.prisma` → `✔ Generated Prisma Client (v6.19.3)`. |
| 2 | `npx tsc --noEmit` | 0 | **PASS** — no type errors. |
| 3 | `npx eslint .` | 0 | **PASS** — no errors/warnings. |
| 4 | `bun run test` (full harness: temp SQLite DB → `prisma db push` (WASM schema engine) → seed → `next dev` on :3100 → 54 suites) | 1 → **0 after fixes** | Before fixes: `3 test suite(s) FAILED` — BUG-1 (unregistered suite), BUG-2 (stale assertion). After fixes (BUG-1/BUG-2): **`ALL TEST SUITES PASSED`** (run 2). **Final clean re-run after all fixes (run 4): exit 0, `ALL TEST SUITES PASSED`.** Breakdown: **609 bun tests / 54 files, 0 failures**; functional acceptance suites: Phase 1 **93/93**, Phase 2 **79/79**, Phase 3–6, Phase 6.3 **62/62** — **234 functional checks ✅, 0 ❌**. (Run 3 failed at server boot with `⨯ Another next dev server is already running` — the audit's own probe server on :3000 held the Next dev lock; an infrastructure collision, not an application failure. Probe server + worker were stopped and the suite re-run clean.) |
| 5 | `bun run build` (production) | 1 → **0 after BUG-3 fix** | Before: `PrismaClientInitializationError … libsql … not compatible with provider postgres` during page-data collection (STAYLOOP_TEST leak, BUG-3). After the `isTest()` gate: `✓ Compiled successfully`, `✓ Generating static pages (145/145)`, full route table for all 204 API routes, `BUILD_EXIT:0`. Non-fatal `stub.so.node` messages in the log are artifacts of the engine-download workaround (PRISMA_QUERY_ENGINE_LIBRARY points at a placeholder file; dynamic routes never execute it at build time). |
| 6 | `prisma validate` (dev + test schemas) | 0 | `The schema at prisma/schema.prisma is valid 🚀` (same for schema.test.prisma). |
| 7 | `prisma validate --schema prisma/schema.postgres.prisma` | 0 | Valid (requires a `postgresql://` DATABASE_URL; validated with a dummy URL — engine download for the classic CLI path is blocked in this sandbox, so validation used the WASM schema engine where possible). |
| 8 | PostgreSQL migration replay — `node audit/tools/check-postgres-migrations.mjs /tmp/stayloop-audit-tools` (@electric-sql/pglite@0.5.10, in-memory PostgreSQL 18.6) | 0 | **PASS 0001…0014** (all 14 migrations), `PASS existing reservation fence backfill; 110 tables`, idempotent re-apply of 0012/0013/0014, `PASS BUG-16 original uniqueness failure and parameterized tombstone update on PostgreSQL`. |
| 9 | `npm audit --omit=dev` | 0 | **found 0 vulnerabilities** (production dependency tree). |
| 10 | `npm audit` (full tree) | 1 | 5 high — all in the dev-only eslint toolchain (`braces`→`micromatch`→`fast-glob`→`@next/eslint-plugin-next`→`eslint-config-next`). Not reachable at runtime. See BUG-DEP-002. |
| 11 | `bun run scan:secrets` | 0 | `SECRET SCAN — clean (no secrets detected in tracked files).` |
| 12 | Git-history secret scan (`git log --all -p -S "BEGIN PRIVATE KEY|AKIA|sk_live_|ghp_"`) | 0 | No matches. `.env*` (except examples) gitignored; no database files tracked. |

### Live runtime verification (seeded dev server, port 3000)

Setup: fresh SQLite DB → `prisma db push` (WASM engine) → `scripts/seed.ts` + `seed-phase3-6.ts` + `seed-phase63.ts` (pinned test passwords) → `next dev -p 3000` → standalone worker process.

| Probe | Command | Result |
|---|---|---|
| Health | `curl /api/health` | `{"status":"ok","checks":{"database":"ok","queue":"ok","redis":"disabled","rateLimiter":"disabled","email":"mock","worker":"ok"}}` — after the worker started, `worker` flipped from `unknown` → `ok` via a real DB heartbeat. |
| Route sweep | `PROBE_BASE=http://localhost:3000 bun run scripts/verify/route-sweep.ts` | **87/87 checks passed; 0 failed** (auth, CRM, loyalty, restaurant ops, POS, inventory, enterprise, AI, super-admin, RBAC). |
| End-to-end journey | `… scripts/verify/e2e.ts` | **33/33** — menu → QR → table session → public order → KDS → bill → partial + full payment → receipt → reservation → purchase order, plus RBAC and tenant isolation (cross-hotel bill read → 404). |
| Public surface | `… scripts/verify/public-pages.ts` | **9/9** — QR landing pages, public menu JSON, guest feedback, invalid-QR 404, app shell. |
| Feature probe | `… scripts/verify/feature-probe.ts` | **27/27** after BUG-4 fix (was 26/27: wallet pass issued before the tenant opt-in was enabled — the 403 was correct fail-closed behaviour; probe reordered and a fail-closed regression check added). |
| Super-admin console | `SA_MFA_SECRET=… PROBE_BASE=… bun run scripts/verify/super-admin.ts` | **25/25** after BUG-5 fix — self-provisioned super admin (bootstrap → temp password → password change → TOTP enrollment), 18 platform read endpoints, tenant suspend→activate, feature-flag toggle, manual backup **QUEUED → worker completed → SUCCESS, checksum verified**, audit trail populated. |
| Fuzz | `… scripts/verify/fuzz.ts` | **343 malformed payloads across 49 mutation endpoints — zero 5xx** (all handled as 4xx). |

### Not run / blocked (stated explicitly)

- **Live provider deliveries** (WhatsApp, Twilio SMS, SMTP/SES/Resend/SendGrid, Razorpay/Stripe sandbox round-trips): no credentials in the sandbox. Unit/integration suites use fakes and the simulation mode is honestly labelled (`SIMULATED` status, `BLOCKED_PROVIDER_ACCESS` wallet provider status). Marked **Unverified**, per the mandatory rules.
- **Redis-backed distributed rate limiting:** no Redis service in the sandbox; in-process fallback is what the suites exercise.
- **Browser/Playwright E2E and a11y checks:** no browser automation available; UI wiring verified by source inspection + HTTP probes.
- **Neon PostgreSQL 16 concurrency stress:** migrations replayed on real PostgreSQL (PGlite WASM); lock behaviour under production-grade concurrency remains a CI gate (interactive-transaction suites pass on SQLite).

---

## 2. Fix verification (regression evidence)

| Fix | Regression command | Result |
|---|---|---|
| BUG-1 (register `tests/export-policy.test.ts`) | `bun test tests/export-policy.test.ts` | 4 pass, 0 fail |
| BUG-2 (stale `aria-expanded` assertion) | `bun test tests/dashboard-regressions.test.ts` | 16 pass, 0 fail |
| BUG-1+2 together | `bun run test` (full harness) | **ALL TEST SUITES PASSED** (609 tests, 54 files; 234 functional checks) |
| BUG-3 (`isTest()` gate in `src/lib/db.ts`) | `bun run build` | exit 0, 145 pages, all routes compiled |
| BUG-4 (probe ordering) | `PROBE_BASE=… bun run scripts/verify/feature-probe.ts` | 27/27 |
| BUG-5 (probe self-provisioning + backup field) | `SA_MFA_SECRET=… PROBE_BASE=… bun run scripts/verify/super-admin.ts` | 25/25 |

Combined re-run of the three directly-affected suites after fixes: `bun test tests/dashboard-regressions.test.ts tests/export-policy.test.ts tests/bugfix-regressions-2026-10.test.ts` → **44 pass, 0 fail**.
