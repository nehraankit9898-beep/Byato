# Deep bug hunt — 2026-10-18

Base: `387e321c3c9d071df0b4eb67ca595fac91de21e4`; session branch `arena/974ae73b-byato` (fixed by the execution environment; no other branch created). No production database, customer message or payment provider was used. No deployment, push or PR was made.

**Verdict: NOT READY for an unconditional production release.** Five newly confirmed defects have fixes and regression coverage. Native production build, PostgreSQL 16 concurrency/drift/restore, real gateways, Redis and browser verification remain release gates. This is a scoped follow-up, not a claim that every line of every route is secure.

Read first: BUG_SWEEP, SECURITY_FINDINGS, REMAINING_BLOCKERS, REMAINING_RISKS, ROUTE_INVENTORY, PRODUCTION_READINESS, package/lockfiles, all three schemas and the complete 0001–0014 migration chain. IDs 11–13 were already assigned in `VERIFICATION_2026-10-12.md`; new IDs therefore start at **BUG-14**. Existing dependency finding DEP-002 is updated, not counted as new.

## New findings only

| ID | Severity | Confidence | Affected function / files | Status |
|---|---|---|---|---|
| BUG-14 | Medium | High: real production-mode proxy + environment validator | `buildPageCsp` in `src/proxy.ts`; `validateExtendedEnv` in `src/lib/env.ts` | Fixed; 10 regressions pass |
| BUG-15 | High | High for predicate defect; production concurrency still unverified | `recordManualPayment`, `refundOrVoidBill`, `recordGatewayCapture` in `src/lib/billing.ts` | Fixed balance compare-and-swap; 4 controlled-interleaving regressions pass |
| BUG-16 | High | High: real Prisma/LibSQL failure and rollback test; PostgreSQL SQL constraint corroboration | `executeDeleteRequest` in `src/lib/privacy.ts` | Fixed; 3 real-database regressions pass |
| BUG-17 | Medium | High for missing caps; resource-exhaustion load test not run | 22 API route files with direct `req.json()` / `req.text()` (listed below) | Fixed; 5 route/coverage regressions pass |
| BUG-18 | Medium | High: frozen install and declaration comparison fail on original tree | `bun.lock` workspace declaration/resolution vs `package.json` | Fixed; declaration regression and two Bun versions' frozen installs pass |

### BUG-14 — production embedding policy accepts wildcard and directive text

The common `originListSchema` explicitly accepted `*` and accepted any string starting with `https://`. The proxy inserted `EMBED_FRAME_ANCESTORS` verbatim into CSP. Contrary to historical audit assertions, production startup accepted `*`, `https://*.example.com`, paths and directive delimiters. A configuration such as `https://trusted.example; script-src *` could add CSP directive text. Impact is configuration-induced clickjacking / policy misconfiguration, not a demonstrated remote ability to set environment variables.

**Before:** `bun test tests/production-frame-policy.test.ts`: 0 pass / 10 fail. With `NODE_ENV=production EMBED_FRAME_ANCESTORS='*'`, validation did not reject it and the proxy emitted `frame-ancestors *`. Comma-separated origins were also emitted as invalid CSP instead of space-separated source tokens.

**Fix:** shared `src/lib/frame-policy.ts` parser used at startup and at the proxy. Production permits only explicit HTTPS origins, `'self'`, or standalone `'none'`; no credentials, paths, wildcard, query, fragment or directive text. Normalize accepted commas and trailing `/`. Invalid runtime configuration falls back to `'self'` if startup validation was bypassed. Development retains wildcard embedding. Existing nonce, Razorpay hosts and production no-`unsafe-eval` controls remain intact. `.env.example` documents the contract.

**After:** 10 pass / 0 fail, including unsafe policies, valid multiple trusted origins, deny-all, safe defaults and development embedding. These execute real proxy responses in fresh production-mode processes; not a browser clickjacking test.

### BUG-15 — unchanged partial-payment/refund status defeats optimistic locking

Historical P14-PAY-1 / P14-RFD-1 / P14-GWY-1 moved reads inside a transaction but used only `{id, status}` in `updateMany`. Under PostgreSQL READ COMMITTED, two transactions can read the same balances and both match `PARTIALLY_PAID` or `PARTIALLY_REFUNDED` after the first writer commits, because the status does not change. Both ledger operations can commit while the second overwrites the first balance. This is the **additional, same-status root-cause gap** in the historical fix, not a re-report of its original outside-transaction read.

Examples: paid 100 / total 1000; two 200 payments both commit while paid stays 300. Paid 1000 / refunded 100; two 600 refunds can both be authorized against refundable 900, while stored refund stays 700 and the refund ledger totals 1300 (including the original 100).

**Before:** controlled READ COMMITTED delegate interleavings through the actual service functions: 0 pass / 4 fail. Both calls reported success. Tests cover manual/manual, manual/gateway, distinct gateway/gateway intents and partial refund/refund.

**Fix:** all four bill updates (including void) compare `hotelId`, observed `status`, `paidMinor`, `refundMinor` and `totalMinor`. A stale update returns count 0 and throws inside the existing transaction, rolling back its payment/refund rows. Existing caller conflict/reconciliation behavior remains; no automatic provider retry or new charge is introduced.

**After:** 4 pass / 0 fail. Tests explicitly model a database interleaving, not real multi-connection PostgreSQL locking. PostgreSQL 16 concurrent service tests remain required before live payments. No money-unit conversion, schema field or migration is needed.

### BUG-16 — privacy deletion violates uniqueness and can strand partial cleanup

`Customer` has `@@unique([hotelId, phone])`. The deletion service bulk-set every phone to `[DELETED]`, so any tenant with two customers failed with P2002. It had already committed `IN_PROGRESS`, making the request non-retryable. A later archive/revocation failure for a single-customer tenant left customer changes committed without completing the workflow. It also never checked the documented `legalReviewBy` precondition and left profile dates/notes/channel opt-ins populated.

**Before (real disposable full-schema Prisma/LibSQL database):** 0 pass / 3 fail. Two-customer deletion raised `UniqueConstraintViolation` on `(hotelId, phone)`; injected hotel-archive failure left name `[DELETED]` rather than `Guest 0`; an approved request with missing legal review executed. PostgreSQL/PGlite independently reproduces the original phone-constraint failure.

**Fix:** conditional APPROVED/type/tenant/legal-review/expired-hold claim and all database changes in one transaction. Parameterized SQL assigns a random non-phone namespace plus row ID (unique tombstones), then bulk-anonymizes customer profile fields, suppresses all marketing channels, revokes keys/sessions, archives the hotel, completes the request and records transactional audit evidence. Database failure rolls back the claim and changes. No financial history is erased. Summary explicitly says customer-profile-only anonymization and related-record retention.

**After:** 3 pass / 0 fail, 28 assertions: multi-customer success, unique tombstones, cleared profile data, foreign tenant untouched, completion/repeat protection, rollback after injected failure, owner tenant/retention/legal-review gates. Fixture uses real owner rows so the transactional audit foreign key is valid.

**Important limit:** this is NOT comprehensive personal-data erasure or legal certification. Bills' legal/customer snapshots, related messages/history, staff PII, provider/storage data and backups require a separate legally reviewed retention/deletion procedure. Concurrent new customer creation during archival, large-tenant transaction duration and real PostgreSQL transaction behavior are unverified. Previously stranded IN_PROGRESS requests require operator inspection of partial changes before any conditional reset; do not blindly retry or reset all requests.

### BUG-17 — public/auth/webhook routes bypass historical SEC-005's body helper

SEC-005 fixed `readJson` callers; it did not replace direct body reads. The 204-route scan found **22 files / 23 direct body-read sites**, including public login/reset/bootstrap, developer API, and signed payment/marketing webhooks. These could read arbitrarily large length-less/chunked bodies before schema validation or signature checks. This is additional reachable exposure beyond the historical shared-helper fix, not a claim that the helper itself regressed.

**Before:** 2 pass / 3 fail in `tests/body-cap-route-coverage.test.ts`. A valid-shaped reset request with >1 MiB ignored padding reached token consumption; a valid-signature oversized webhook was accepted (200); the source guard listed all bypasses. No RSS/load/slowloris attack was run.

**Fix:** JSON sites use `readJsonCapped`; raw signature sites use `readBodyCapped` with the existing 1 MiB ceiling and return 413 on overflow. Original raw text is passed unchanged to signature validation; no JSON reserialization, auth bypass, secret fallback or signature weakening. JSON sites preserve existing validation/no-enumeration responses. Public voice parsing rejects a null parse rather than dereferencing it.

Affected POST handlers (`src/app/api/` prefix):

- `auth/{activate,forgot-password,login,resend-verification,reset-password,verify-email}/route.ts`
- `super-admin/{bootstrap,features,hotels,hotels/suspend,login,support}/route.ts` (the relevant mutation handlers, including PUT in features)
- `campaigns/[id]/send/route.ts`, `campaigns/run-engine/route.ts`, `lead-events/route.ts`
- `public/menu/[code]/voice/route.ts`, `v1/[...path]/route.ts` (two JSON sites)
- Raw bodies: `ai/whatsapp/webhook/route.ts`, `billing/webhook/[provider]/route.ts`, `campaigns/run-engine/route.ts`, `tracking/webhook/route.ts`, `webhooks/razorpay-restaurant/route.ts`, `webhooks/tracking/route.ts`

**After:** 5 pass / 0 fail. Oversized chunked reset does not consume a token; oversize signed webhook returns 413; streams are cancelled; normal reset and signed webhook behavior preserved. Coverage guard rejects new direct JSON/text/arrayBuffer readers across all route files. Provider payloads larger than 1 MiB now intentionally fail; validate production provider event sizes before rollout. Concurrent-request limits and slow-body timeouts remain infrastructure concerns.

### BUG-18 — checked-in lockfile prevents frozen fresh installation

Original `bun install --frozen-lockfile` failed: `lockfile had changes, but lockfile is frozen`. Workspace declarations omitted `@prisma/engines`, `@libsql/client`, `@prisma/adapter-libsql` and declared a different Prisma range. CI uses frozen installs, so it fails before tests/deployment.

**Before:** frozen install exit 1; the added workspace-declaration comparison run on `git show HEAD:{package.json,bun.lock}` exits 1 (`@prisma/engines` absent). This is separate from DEP-002's vulnerable resolved packages.

**Fix:** regenerate the lockfile consistently with the existing manifest, then apply the reviewed compatible dependency changes below. Preserve unchanged tarball URLs to minimize lockfile review noise. `tests/build-mode-contract.test.ts` now compares both dependency declaration maps.

**After:** build-mode contract 4 pass / 0 fail (one new regression); frozen `--ignore-scripts` installs pass with Bun **1.4.3 and deployment-pinned 1.3.14**. Normal installation's native Prisma postinstall is still network-blocked, distinct from lockfile correctness.

## Dependency investigation and changes (existing DEP-002)

Evidence: `audit/evidence/2026-10-18/`; reproducible production-inventory audit in `audit/tools/audit-production-lock.py`.

- Registry confirms `next@16.4.0` exists. Upgrade **16.4.0 → 16.4.2**, with matching `eslint-config-next`, `@next/env` and SWC artifacts. Same release line, unchanged React peer range, Node >=20.9; this runner is Node 22.22.3. Next's postcss dependency advances to patched 8.5.23.
- Actual installed/resolved React **19.2.3**, React DOM **19.2.3**, Sharp **0.35.5**, Prisma client/CLI/engines/LibSQL adapter **6.19.3** are retained. Do not mistake manifest ranges for installed versions. No major Prisma 7 / React 19.3 / chart-library migration.
- Baseline full-tree npm advisory response: **39 advisory records across 16 package names: 26 high, 12 moderate, 1 low**. Review `bun audit fix --dry-run` before applying; upgrades remain inside declared dependent ranges. No `--latest` / forced incompatible overrides.
- Reviewed transitive fixes: Babel core 7.29.6 (and its same-major dependency closure), humanfs/node 0.16.8, ajv 6.14.0, baseline-browser-mapping 2.11.0, brace-expansion 1.1.21, browserslist 4.28.7, defu 6.1.5, flatted 3.4.2, js-yaml 4.3.2, lodash 4.18.0, minimatch 3.1.4, nanoid 3.3.20 (PostCSS's resulting resolution), picomatch 2.3.2 and 4.0.4, postcss 8.5.23, source-map-js 1.2.2. Supporting Babel/browser-data patches are recorded in the lockfile. lodash is reached through Recharts; PostCSS through Next/Tailwind; defu through Prisma CLI configuration.
- `bun audit fix` updated the lock/install but exited nonzero when its postinstall tried the blocked native Prisma host. Subsequent audit, frozen-install, typecheck and regression results were obtained separately; its exit is not represented as success.
- Final full-tree `bun audit --audit-level=high`: **exit 1, one high remains**: [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), braces <=3.0.3 stack exhaustion, no published patched version reported by Bun. Path: dev `eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces`. Source glob patterns are local trusted tooling, not a demonstrated HTTP runtime path. Do not suppress the advisory globally; reconsider when a compatible patch is published. Build-tool exposure to untrusted repositories/patterns still matters.
- Separate npm bulk advisory request over **265 actual locked production-reachable package names**, conservatively including installed optional/peer dependencies and all locked platforms: **exit 0, `{}` advisories**. This audits the Bun resolutions, unlike generating a fresh npm lockfile that may resolve different versions. Vendor code bundled inside packages still depends on upstream advisories, not this graph alone.

### October 2026 upstream advisories checked

GitHub API query for `affects=next@16.4.0` returned `[]`. A separate package/date query (Oct 1–18) returned six October 7 advisories; all affected 16.x ranges stop at **<16.3.8** (15.x ranges where present stop at <15.5.27):

| Advisory | Area | Applicability to locked 16.4.0 / upgraded 16.4.2 |
|---|---|---|
| [GHSA-3w37-wq28-93x7](https://github.com/advisories/GHSA-3w37-wq28-93x7) | pending `use cache` / Draft Mode leakage | Outside affected range; no Cache Components enablement found in next.config |
| [GHSA-4jqv-mc3x-m676](https://github.com/advisories/GHSA-4jqv-mc3x-m676) | self-hosted SSG/ISR cache poisoning | Outside affected range |
| [GHSA-39w2-rjm5-chcv](https://github.com/advisories/GHSA-39w2-rjm5-chcv) | dev MCP disclosure | Outside affected range; do not expose dev tooling in production |
| [GHSA-f87g-xv8r-7p7x](https://github.com/advisories/GHSA-f87g-xv8r-7p7x) | metadata image dynamicParams bypass | Outside affected range |
| [GHSA-mcj8-r9mp-w47p](https://github.com/advisories/GHSA-mcj8-r9mp-w47p) | SSG/ISR content substitution / DoS | Outside affected range |
| [GHSA-cjq9-62q9-8jv4](https://github.com/advisories/GHSA-cjq9-62q9-8jv4) | image optimizer SSRF | Outside affected range |

Sharp's October 6 [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) (librsvg, <0.35.5) is patched by the already locked **0.35.5**; image processing exists but the installed version is not in the advisory range. October package queries for react, react-dom and @prisma/client returned no records. No invented Next 16.4.0 CVE is reported.

**Compatibility risks:** native Next/SWC/image artifacts still need real production packaging/build verification; same-major transitive API compatibility is supported by lint/typecheck/tests, not proof of every UI behavior. Bun lock format is accepted by 1.3.14. Production dependency audit alone is not a clean full-tree audit.

## Database review and rollout

- All 110 models and 55 enums compared across SQLite/PostgreSQL/test schemas: identical sorted model/enum field declarations after stripping comments (relation field order differs in Hotel). This is a declaration parity check, not live schema drift verification.
- Execute every migration 0001–0014 using `audit/tools/check-postgres-migrations.mjs` and externally installed PGlite 0.5.10: **PASS**, 110 tables. Engine reports PostgreSQL **18.6 WASM**, NOT PostgreSQL 16 / Neon. Existing active/cancelled reservation fixtures backfill correctly; reapplication of 0012/0013/0014 passes. Original/shared phone tombstone fails and fixed parameterized SQL works on PostgreSQL too.
- **No schema changes or new migrations in this patch.** Do not reset/seed/migrate production to apply these code fixes. Deploy through the existing production build/migration process only after gates below pass.
- Rollback: no DDL rollback required. Reverting code does not restore anonymized PII; privacy execution is intentionally irreversible at the application layer. Do not restore personal data or roll back dependencies to vulnerable versions without explicit operator/legal/security approval. Existing IN_PROGRESS privacy requests require case-by-case reconciliation.

## Commands and actual results

Run from repository root unless indicated. Logs/JSON summaries in `audit/evidence/2026-10-18/`; full runner logs were kept outside the repository to avoid checking in seeded token/PII diagnostic output.

| Command | Actual result |
|---|---|
| `npm install -g bun@1.4.3` | Installed toolchain (not a repository dependency) |
| `bun install --frozen-lockfile` on original tree | FAIL, lockfile drift |
| `bun install --ignore-scripts` | Installed original resolutions and reconciled manifest declarations; no production database access |
| `bun audit --json` before fixes | 39 records, including 26 high; raw JSON saved (Bun JSON mode returned exit 0 despite advisories) |
| `npm view next@16.4.0 version`, `npm view next@16.4.2 dependencies peerDependencies engines --json`; package version queries | Registry metadata retrieved |
| `gh api '/advisories?ecosystem=npm&affects=next%4016.4.0&per_page=100'` and package/date queries | Upstream applicability investigated as above |
| `bun add --exact next@16.4.2 --ignore-scripts`; `bun add --dev --exact eslint-config-next@16.4.2 --ignore-scripts` | PASS |
| `bun audit fix --dry-run`; `bun audit fix` | Plan reviewed; lock fixed; apply command ultimately FAILS at native Prisma postinstall, not at dependency resolution |
| `bun install --frozen-lockfile --ignore-scripts` | PASS (1.4.3) |
| `npx --yes --package=bun@1.3.14 bun install --frozen-lockfile --ignore-scripts` | PASS (deployment Bun version) |
| `python3 audit/tools/audit-production-lock.py` | PASS: 265 locked package names, no returned advisories |
| `bun audit --audit-level=high` | FAIL: one dev-tool braces advisory remains |
| `STAYLOOP_TEST=1 DATABASE_URL=file:<disposable-path> bun run db:generate` | PASS: real Prisma 6.19.3 WASM/client generation |
| New regression files, separately per file | Frame 10/10; balances 4/4; privacy 3/3; body cap 5/5; build-mode 4/4 (one new test) |
| `bun run typecheck` | PASS after correcting required AuthedUser fields in the new privacy test; earlier new-test type errors were real and fixed |
| `bun run lint` | PASS after documenting four existing intentional synchronous test-adapter require sites with line-scoped lint exceptions; no runtime/security control changed |
| `bun run scan:secrets` | PASS for tracked files, the scanner's stated scope |
| `rm -rf .next && bun run build` (after the test server stopped) | BLOCKED/FAIL before Next compilation: cannot fetch native schema engine/checksum from `binaries.prisma.sh`; clean production build NOT verified |
| `npm install --prefix /home/user/audit-tools --no-audit --no-fund @electric-sql/pglite@0.5.10`; `node audit/tools/check-postgres-migrations.mjs /home/user/audit-tools` | PASS: disposable PostgreSQL/WASM migration and constraint checks |
| `bun run test` initial run | FAIL: one functional-script suite crashed with ECONNRESET at login; do not treat this as all-green |
| `bun run test` final-code rerun | **PASS, exit 0: 587 Bun tests / 52 files; functional phase1 93/93, phase2 79/79, phase63 62/62** |
| `git diff --check` | PASS |

Privacy standalone invocation needs the existing test harness's preflight mechanism in restricted environments: create a temporary placeholder file and set `PRISMA_QUERY_ENGINE_LIBRARY` to it for `bun test --timeout 150000 tests/privacy-delete-atomicity.test.ts`. The placeholder is only a CLI existence check: actual schema/data operations run through the shipped WASM engine and real LibSQL adapter; no fake database results. `bun run test` already creates this preflight file in its disposable temp directory. Native production generation/build never uses that workaround.

## Remaining verification / exact release gates

1. On an approved runner with Prisma binary access, Node >=20.9 and the deployment Bun version: `bun install --frozen-lockfile`; `bun run lint`; `bun run typecheck`; `bun run test`; clean `.next` **only with no server using it**, then `bun run build` and `bun run build:standalone`. No production success claim until these succeed with the PostgreSQL-generated client. Do not use `--no-engine` or disable type/security checks to manufacture a pass.
2. Use only an explicitly disposable PostgreSQL 16 database URL: `DATABASE_URL="$DISPOSABLE_PG_URL" bunx prisma migrate deploy --schema prisma/schema.postgres.prisma`; then `DATABASE_URL="$DISPOSABLE_PG_URL" bunx prisma migrate diff --from-url "$DISPOSABLE_PG_URL" --to-schema-datamodel prisma/schema.postgres.prisma --exit-code`. Run the repository's PostgreSQL CI integration and backup/restore rehearsal. Do not point these commands at production.
3. Against that database, barrier two real connections after reading PARTIALLY_PAID (paid=100,total=1000), submit two distinct 200 manual/gateway allocations; require ledger sum=stored paid and loser rollback/retry. Repeat PARTIALLY_REFUNDED (paid=1000,refund=100), simultaneous 600 refunds; never commit both. Test gateway duplicate/out-of-order delivery and transient failure recovery with real sandbox credentials; reconcile provider captures rejected locally rather than charging again.
4. Privacy: execute/rollback multi-customer workflow on PostgreSQL; test concurrent execution/new customer creation, historical stuck requests and large tenant sizes. Review legal retention and PII outside Customer separately. Do not claim comprehensive GDPR/DPDP erasure.
5. Real Razorpay/Stripe/refund reconciliation, distributed Redis limits/queue, external email/WhatsApp opt-out delivery, private exports/downloads, support impersonation, and real browser accessibility/responsive/CSP/duplicate-submit flows remain unverified in this follow-up. Existing tests are not provider attestations.
6. Resolve or explicitly accept the remaining braces toolchain advisory. Preserve HTTPS/frame restrictions; use explicit trusted production iframe origins, never `*`.
