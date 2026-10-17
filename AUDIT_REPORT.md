# Repository audit and repair report — 2026-10-17

## Executive result
**Six newly confirmed findings: 0 Critical, 3 High, 3 Medium, 0 Low. Five fixed; one unresolved; none partially fixed.**
200 tests across 20 independently executed suites pass. Lint/typecheck and both schema
validations pass. Next production compilation passes with an engine-free Prisma client.
Normal production build and full integration harness cannot complete because native Prisma
engine downloads are blocked. **No verified production deployment or production-readiness sign-off.**

Discovery covered the repository tree, configuration, schema/migration history, route catalog,
service/UI/test/deployment modules and existing audit documentation. Deep review focused on
MFA/auth guards, role/tenant enforcement boundaries, OTP, webhooks and build/deployment contracts.
This is NOT an exhaustive line-by-line semantic audit of all 421 source files. Remaining modules
are inventoried, but their complete workflows remain explicitly unverified/blocked. Historical
reports were treated as leads, never evidence that a test passed in this session.

## Actual stack and structure
- Package stayloop 1.0.0 (Byato repository; UI also uses RestroLoop branding), TypeScript,
  Next.js 16.4.0 App Router, React 19, Tailwind 4, Radix/shadcn UI, Recharts/Framer Motion.
- Prisma client/CLI 6.19.3, Zod 4.6.5, Redis via ioredis; custom HMAC/scrypt sessions,
  MFA and DB-backed permission resolution. Nodemailer and provider adapters handle email.
- npm package-lock.json and bun.lock both present. npm clean install is lock-consistent;
  Bun is used by tests/scripts/workers; CI/Docker pin Bun 1.3.14, Netlify pins Node 22.
  Sandbox: Node 22.22.3, npm 10.9.8; installed temporary Bun 1.4.3 for verification.
- `src/app`: 8 page routes (/, /activate, /forgot-password, /reset-password, /verify-email,
  /menu/[code], /pay/[token], /r/[code]); shared layout/local fonts; 204 API route files.
- `src/components/app`: SPA modules for CRM, marketing, restaurant/POS/KDS, operations,
  enterprise/AI, tenant settings and super-admin; public menu/restaurant clients; UI primitives.
- `src/lib`: 110-model database access, security, tenant business services, providers, jobs,
  SaaS billing/security/backup, AI and enterprise services. `src/proxy.ts` supplies nonce CSP/CORS.
- `prisma`: dev SQLite/production PostgreSQL schemas and 14 PostgreSQL migrations.
- `scripts`, `tests`: isolated server/SQLite test harness, Bun unit/integration/security suites,
  PG/Redis integration, seed/bootstrap/worker/backup tools and browser-oriented verification scripts.
- `.github`, Dockerfile, Compose, Caddyfile, netlify.toml and docs cover distinct deployment paths.
  No general-purpose customer-auth role or generic upload/payment success service was assumed.

## Inventory and incomplete workflows
See FEATURE_TEST_MATRIX.md for actual feature status, ROLE_PERMISSION_MATRIX.md for all 88
sensitive-operation grants across 11 roles, and audit/CURRENT_ROUTE_INVENTORY.md for all routes.
Messaging has explicit SIMULATION/dev mock email adapters; live messaging is not established
without credentials. Wallet provider signing/distribution is explicitly absent/blocked, not
mistaken for a real integration. Enterprise/AI/catalog/UI names alone were not marked working.
Coming-soon UI and historical audit statements are not proof of implemented workflows. Both
Prisma schemas intentionally share one generated-client output; this is not duplicate runtime
storage, and switching test/build providers requires regeneration. Dead-code and every inert
button/link have NOT been exhaustively established; do not interpret absence of a finding as proof.

## A/B/C: findings, fixes and risks
- A: AUD-001 MFA setup bypass, AUD-002 confirmation race, AUD-003 OTP ceiling race,
  AUD-004 webhook namespace matching, AUD-005 build-mode contract: fixed within documented
  test scopes. Before patches the new suites had 4/5, 2/4 and 3/3 failing tests respectively;
  after patches all 12 new tests pass.
- B: AUD-006 development dependency advisory remains unresolved. Five package entries arise
  from one advisory chain; they are not counted as five independent application vulnerabilities.
- C: DNS-rebinding window, MFA cross-operation races/challenge lifecycle, raw-body size coverage,
  dev DB fallback and hosting/storage behavior require further reproduction/review. See REMAINING_ISSUES.md.

## D/E: executed commands and results
Dependency installation used `npm ci --ignore-scripts` (exit 0, 570 packages); scripts were
withheld initially for safe discovery and because the Prisma engine host is not permitted.
Bun was installed locally without saving package/lock changes, then its installer run (exit 0).

| Check | Exit | Actual result |
|---|---|---|
| `npm run lint` (baseline and final) | 0 | No lint diagnostics |
| `npm run typecheck` before client generation | 2 | Missing generated Prisma exports and cascading types; environment prerequisite, not counted as app bug |
| `npm run typecheck` after client generation / final | 0 | Pass |
| Native `node scripts/prisma-generate.mjs` | 1 | binaries.prisma.sh blocked |
| Schema validation for each schema with binary-path overrides | 0 each | Valid; WASM validation only, no DB connectivity |
| Engine-free client generation for each schema | 0 each | Generated types only; not usable as native DB connectivity evidence |
| `NEXT_TELEMETRY_DISABLED=1 node_modules/.bin/next build` | 0 | Production compile/typecheck/page collection pass; filesystem tracing warning in db.ts |
| `npm run build` (normal) | 1 | Native engine download blocked before Next compilation |
| `npm test` (PATH includes local Bun) | 1 | Harness stops at native SQLite client generation; no DB/API suites executed |
| `npm audit --json` | 1 | Five High dev-tool package entries, AUD-006 |
| `npm audit --omit=dev --json` | 0 | Zero runtime dependency advisories reported |
| `npm view braces version` | 0 | 3.0.3, no inspected latest patch beyond affected range |
| `npm run scan:secrets` | 0 | Existing tracked-file scanner clean; not a full historical/external secrets certification |
| Normalized model-field comparison | 0 | 110 identical model definitions ignoring comments/whitespace/order |
| `git diff --check` | 0 | No whitespace errors |

For the engine-free diagnostics ONLY:
```
PRISMA_SCHEMA_ENGINE_BINARY=/bin/true PRISMA_QUERY_ENGINE_LIBRARY=/bin/true DATABASE_URL=<synthetic-provider-URL> node_modules/.bin/prisma generate --no-engine --schema <schema-path>
PRISMA_SCHEMA_ENGINE_BINARY=/bin/true PRISMA_QUERY_ENGINE_LIBRARY=/bin/true DATABASE_URL=<synthetic-provider-URL> node_modules/.bin/prisma validate --schema <schema-path>
```
`/bin/true` merely prevents the CLI downloader from fetching binaries; validation/generation
use installed WASM tooling. It is NOT a substituted working DB engine, no tests executed DB
queries through it, and no deployment code or environment was changed to use these overrides.
Synthetic local URLs contained no real credentials. Regenerate a normal client before runtime use.

Each following suite was executed in a separate Bun process, avoiding module-mock pollution:

| Command | Exit | Result |
|---|---|---|
| `bun test tests/audit-2026-regressions.test.ts --timeout 30000` | 0 | 13 pass, 0 fail |
| `bun test tests/audit-current-regressions.test.ts --timeout 30000` | 0 | 4 pass, 0 fail |
| `bun test tests/bootstrap-endpoint.test.ts --timeout 30000` | 0 | 26 pass, 0 fail |
| `bun test tests/bugfix-regressions-2026-10.test.ts --timeout 30000` | 0 | 24 pass, 0 fail |
| `bun test tests/build-mode-contract.test.ts --timeout 30000` | 0 | 3 pass, 0 fail |
| `bun test tests/config-secret-stability.test.ts --timeout 30000` | 0 | 5 pass, 0 fail |
| `bun test tests/crypto-rotation.test.ts --timeout 30000` | 0 | 11 pass, 0 fail |
| `bun test tests/custom-role-resolution.test.ts --timeout 30000` | 0 | 3 pass, 0 fail |
| `bun test tests/deployment-config.test.ts --timeout 30000` | 0 | 16 pass, 0 fail |
| `bun test tests/dev-script-guard.test.ts --timeout 30000` | 0 | 5 pass, 0 fail |
| `bun test tests/import-cycle-regression.test.ts --timeout 30000` | 0 | 4 pass, 0 fail |
| `bun test tests/mfa-enrollment-regression.test.ts --timeout 30000` | 0 | 5 pass, 0 fail |
| `bun test tests/payment-callback-routes.test.ts --timeout 30000` | 0 | 10 pass, 0 fail |
| `bun test tests/payment-link-limit.test.ts --timeout 30000` | 0 | 1 pass, 0 fail |
| `bun test tests/payment-link-settle.test.ts --timeout 30000` | 0 | 4 pass, 0 fail |
| `bun test tests/qr-injection-regression.test.ts --timeout 30000` | 0 | 16 pass, 0 fail |
| `bun test tests/restore-args.test.ts --timeout 30000` | 0 | 8 pass, 0 fail |
| `bun test tests/security-hardening.test.ts --timeout 30000` | 0 | 10 pass, 0 fail |
| `bun test tests/super-admin-hotel-errors.test.ts --timeout 30000` | 0 | 5 pass, 0 fail |
| `bun test tests/unit.test.ts --timeout 30000` | 0 | 27 pass, 0 fail |

No test was silently marked skipped/passed because it could not connect. All 200 executed
assertion tests pass; full integration command is blocked. Browser E2E, Docker, PG, Redis and
real providers were not run (tools/services/credentials or native engine unavailable).

## F/G: production status and next actions
Full workflows, all direct HTTP role/tenant cases, live provider delivery/payment, browser/mobile
accessibility and real production deployment remain unverified. See FEATURE_TEST_MATRIX.md.
The project needs native engine access and disposable PG/Redis to continue. Production host,
credentials and operator approval are required before real account/bootstrap/migration/deployment
operations. No approval-requiring action was taken. No commit, push, deploy, reset, destructive
migration or production data change was performed.

## Deliverables
BUGS_FOUND.md; FIXES_APPLIED.md; SECURITY_AUDIT.md (current addendum, history preserved);
ROLE_PERMISSION_MATRIX.md; FEATURE_TEST_MATRIX.md; DATABASE_AUDIT.md;
DEPLOYMENT_READINESS.md; REMAINING_ISSUES.md. Exact file changes are listed in FIXES_APPLIED.md.
