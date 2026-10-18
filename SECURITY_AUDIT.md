# SECURITY_AUDIT.md — StayLoop Security Audit (2026-10-16 pass)

**Scope:** full re-audit of the merged repository — authentication, authorization, tenant isolation, payments, injection surfaces, cookies/CSRF, secrets, rate limiting, QR/wallet surfaces, data exposure. **Method:** code inspection + executed regression suites (43 test files) + targeted greps/scans + production-boot probes.

**Verdict:** no new exploitable vulnerabilities found in this pass; the critical **operational** security bug fixed (schema drift, which also removed a missing uniqueness fence) is documented below. Prior accepted/potential items were re-verified and remain accurate.

---

## 1. Confirmed Issues Fixed in This Pass

| ID | Severity | Issue | Fix & Verification |
|---|---|---|---|
| **SEC-DB-01** | **High (integrity)** | `Reservation.publicToken` declared `@unique` in both Prisma schemas but **no unique index existed in any PostgreSQL database deployed via migrations** — no database-level fence against duplicate public tracking tokens (and any future `upsert` by that key would 500 with "no unique or exclusion constraint matching the ON CONFLICT specification"). | Migration `0014` creates `Reservation_publicToken_key`; verified present on both the upgraded and fresh-database paths via `pg_indexes`. |
| **SEC-DB-02** | **High (availability/intenant data)** | Schema↔migration drift made franchise/branch routes fail at runtime (P2021/P2022 → HTTP 500) on production PostgreSQL — tenant-facing outage surface. | Migration `0014` (see BUG_FIX_REPORT §2); production boot verified against a real PostgreSQL database. |
| **SEC-CI-01** | **Medium (process)** | The CI "migrations match schema" gate could never fail — a designed security/integrity control that silently did nothing. | Gate rewritten with `--script`; verified it fails on the pre-fix migrations and passes after. |
| **SEC-BUILD-01** | **Medium (supply chain / build integrity)** | "Last generate wins" Prisma client generation could silently bundle the wrong database adapter (e.g., a production build carrying the SQLite client), turning every DB-backed route into a 500 and masking configuration errors. | Environment-aware generation (`scripts/prisma-generate.mjs`) on `postinstall`/`dev`/test; build path stays explicitly PostgreSQL. Reproduced-then-fixed with the full suite passing. |

## 2. Verified-Secure Areas (evidence from this pass)

| Area | Findings |
|---|---|
| **Authentication** | scrypt (N=2^17, OWASP baseline) with legacy-hash transparent rehash; HMAC-signed session tokens with constant-time compare; per-user `tokenVersion` revocation; **DB re-validation of role/status/hotel on every request** (`requireAuth`); timing-equalized unknown-email logins; account lockout after 5 failures (suite-verified). |
| **Authorization / RBAC** | Roles resolved server-side only (never trusted from the client); custom roles resolved per-request from the DB; `requireSuperAdminSession` re-checks the DB role (SEC-002 fixed); mustChangePassword and MFA-enrolment sessions are server-side restricted to self-service routes. Guard audit across **~200 route files**: only 3 files without an inline guard — all three verified legitimate (HMAC-signed webhook; rate-limited public resend-verification; test-gated mock endpoint that 404s outside test env). |
| **Tenant isolation** | Every hotel-owned query scopes by `hotelId` (`getTenantCustomer`, `findFirst({where:{id, hotelId}})`); cross-tenant reads are indistinguishable from 404; suites (`rbac-tenant`, `phase17-enterprise`, `audit-2026-regressions`) cover cross-hotel denial incl. super-admin management boundaries. |
| **Payments & billing** | SHA-256-scoped idempotency keys on a **DB unique column** (`BillPayment.idempotencyKey`); 422 on key reuse with conflicting amount/method/reference/cash-session; P2002 concurrent-winner replay; `gatewayPaymentId @unique` replay fence; refunds distinguish `PARTIALLY_REFUNDED`; transactional outbox for bill-paid side effects; **no real payment transactions in any test** (Razorpay flows are simulated/verified at signature level only). 22/22 billing suite. |
| **SQL injection** | Only two raw statements exist (`src/lib/saas/limits.ts`) — both tagged-template `$executeRaw` with bound parameters. **Zero** `queryRawUnsafe`/`executeRawUnsafe` in `src/`. |
| **XSS** | No `dangerouslySetInnerHTML` outside the shadcn chart theme-CSS block (developer-controlled config, standard pattern); QR print window escapes via shared `escapeHtml` (16/16 injection suite); email templates escape via the same shared helper (single-quote breakout fixed pre-merge, re-verified). |
| **CSRF / cookies** | Double-submit CSRF token enforced centrally in `requireAuth` for cookie-authenticated state-changing requests (forged-origin and missing-header cases suite-verified → 403); session cookie `HttpOnly`, `Secure`, `SameSite=None; Partitioned` only over HTTPS (CHIPS for embedded preview; documented trade-off), `Lax` fallback on plain HTTP. |
| **Security headers / CSP** | Per-request nonce CSP from `src/proxy.ts` (no `unsafe-inline` for scripts in production, no `unsafe-eval` in production); `X-Content-Type-Options`, `Referrer-Policy`, `HSTS`, `Permissions-Policy` verified present on a live production boot. |
| **Secrets** | `scripts/scan-secrets.ts` clean; no secrets in either lockfile or repo; production fails closed without strong `AUTH_SECRET` / `INTEGRATION_ENCRYPTION_KEY` (**re-verified by refusing to boot**); integration credentials AES-256-GCM encrypted at rest and never returned (suite-verified); placeholder secret values rejected in every environment. |
| **Rate limiting** | Login, lockout, registration, password reset, resend-verification, MFA verify, health probe all rate-limited (in-process, or Redis-distributed when `REDIS_URL` is set). |
| **QR codes** | Server-generated 24-byte `base64url` ids, `^[A-Za-z0-9_-]{8,64}$` validation, label trim/slice to 80 chars, `buildPublicUrl` rejects non-http(s) origins (`javascript:`/`data:` never embedded); creation requires auth + `QR_MANAGE`. |
| **Webhooks** | HMAC-SHA256 signature + timestamp replay window for tracking webhooks; Razorpay restaurant webhook verifies signatures; WhatsApp webhook verifies `X-Hub-Signature-256` and fail-closes (503) in production when unconfigured. |
| **Data exposure** | Customer phone numbers masked in dashboards/APIs (privacy-phone suite); staff-facing exports tokenize; audit metadata contains no password material (acceptance-verified); error responses carry codes + safe messages only — no stack traces (verified on live boot: login with empty body → 400 with a zod message, `/api/branches` unauthenticated → 401). |

## 3. Remaining Concerns (accepted / potential — none critical)

1. **[POTENTIAL] Per-handler tenant-isolation review** — RBAC/isolation is pattern-verified across ~200 handlers and suite-verified on the critical paths; the route-by-route review backlog (`audit/ROUTE_INVENTORY.md`) should continue. *Mitigation:* any regression in the covered paths fails CI.
2. **[POTENTIAL] `APP_ORIGIN` unset in production** — QR links fall back to the request origin (phishing-adjacent only; QR resolution stays server-side). *Mitigation:* set `APP_ORIGIN` (now called out twice in DEPLOYMENT_GUIDE.md).
3. **[ACCEPTED] `SameSite=None; Partitioned` session cookie** — required for the embedded-preview product feature; mitigated by the nonce CSP, HttpOnly, Secure, and CSRF double-submit.
4. **[ACCEPTED] Bearer-token sessions** (SEC-008, informational) — token in `Authorization` header bypasses CSRF by design (no ambient cookie); tokens are HMAC-signed, revocable via `tokenVersion`, and never logged.
5. **[ACCEPTED] Per-instance rate limiting/queue coordination without `REDIS_URL`** — documented; warns at production boot (env.ts). Set `REDIS_URL` for multi-instance deployments.
6. **[ACCEPTED] Dev-only mock email provider** — selecting `EMAIL_PROVIDER=mock` in production is a startup **error** (env.ts); mock endpoint 404s outside test env.
7. **[OPERATIONAL] Live third-party surfaces** (Razorpay webhooks, Twilio/WhatsApp, SMTP) — signature-verification code is suite-tested with synthetic secrets; live-provider verification remains BLOCKED without credentials (TEST_REPORT §3).

## 4. Recommendation Priorities

1. Deploy with the exact environment matrix in `DEPLOYMENT_GUIDE.md` §4 (fail-closed means misconfiguration = visible outage, not a silent breach).
2. Run the §6 smoke test after the first deploy (health, QR scan, idempotent payment replay, security headers).
3. Keep CI branch protection requiring the (now effective) drift gate and the full suite.
4. Continue the per-handler isolation review; enable `REDIS_URL` when scaling past one web instance.


---

# Current defensive audit addendum — 2026-10-17

This addendum supersedes historical verification claims only for this session's scope.
**No whole-application security certification is given.** See BUGS_FOUND.md for exact locations,
reproductions, severity, fixes and verification. AUD-001/AUD-002 (High MFA issues) and AUD-003
(Medium OTP race) were reproduced with mocked persistence and fixed. AUD-004 is a webhook
routing defect; AUD-005 fixes deployment contracts. AUD-006 remains an upstream High-rated
development-tool dependency advisory (five package entries, one underlying braces advisory).
Runtime-only npm audit reports zero current advisories, not immunity from vulnerabilities.

## Control-by-control assessment
| Area | Observed implementation / evidence | Verification limit |
|---|---|---|
| Passwords and sessions | scrypt password hashing, HMAC sessions, httpOnly cookies, tokenVersion revocation | Unit tests pass; end-to-end auth blocked |
| Password reset/email verification | hashed expiring single-use tokens and email adapters | Actual delivery, resets and expiry not tested |
| MFA | TOTP replay-step claims, backup hashes, setup and confirmation guards now conditional | New regression tests pass; complete HTTP/PG flow not tested |
| RBAC/IDOR/tenancy | central DB-backed guards, 11-role permission catalog, tenant-scoped lookups and reserved custom grants | Selected unit/static tests pass; every operation/tenant query not exhaustively verified |
| Super Admin | strong-secret bootstrap, constant-time check, one-shot claim, forced password/MFA restrictions | Mocked endpoint tests pass; real DB bootstrap/role mutation not performed |
| SQL injection | Prisma query layer and parameterized paths used; raw SQL needs continued per-call review | No live injection test or exhaustive raw-query proof |
| XSS | React escaping, consolidated HTML escaping and per-request nonce CSP | 16 QR regressions + security-hardening tests pass; full browser CSP/XSS not tested |
| CSRF/CORS/cookies | cookie double-submit/origin checks, bearer-mode distinction, exact trusted-origin CORS, Secure cookie logic | Unit/proxy tests pass; real proxy/browser/session integration unverified |
| SSRF/redirects | outbound webhook HTTPS/private-host/DNS checks and redirect handling exist | DNS rebinding/egress remains an untested risk; no external probes |
| Validation/request sizes | Zod, shared streaming JSON cap, provider-specific signature handlers | 13 audit regressions include capped-body tests; not all raw-body endpoints uniformly capped |
| Rate limit/brute force | Redis-or-local limiters, lockout, phone OTP ceiling | New OTP predicate test passes; distributed/multi-worker behavior blocked |
| Uploads/path traversal | CSV/import, export/download and backup filesystem paths exist; no general upload service established by this review | Full path/CSV size/provider storage review incomplete |
| Secrets/logging | fail-closed production configuration, encrypted integration secrets, scrubbed audit metadata | Tracked-file secret scanner exit 0; external logs/history/secrets not certified |
| Payments/webhooks | gateway HMAC/order correlation/idempotency, outbound signing and retry queue | Ten callback-route and four settlement boundary tests pass; live gateways not tested |
| Dependencies | npm full audit exit 1; runtime-only audit exit 0 | AUD-006 unresolved; no forced tooling downgrade |
| Production configuration | startup validation, headers, liveness/readiness split, separate worker | Direct Next compile only; real startup/TLS/storage/deployment not verified |

No exploit was attempted outside the repository. No secrets were copied into reports, no
production accounts changed and no external service calls were used to send messages or money.
Urgent next step: validate these MFA fixes against disposable PostgreSQL and real session-bound
HTTP requests before a release, then run the full denied/allowed cross-tenant regression suite.

---

# Master RBAC / tenant-isolation review — 2026-10-17 (addendum)

Companion report: **SECURITY_MASTER_AUDIT_2026-10.md** (findings table, route→role→permission
matrix, test results, deploy steps, remaining risks, branch refs).

Defects found, fixed, and regression-tested in this pass:

- **FRANCH-01 (P1, cross-tenant read):** `src/lib/franchise.ts → addBranchToFranchise` accepted a
  client-supplied `hotelId` without verifying it against the caller's tenant scope. A franchise
  org-admin could attach ANY hotel on the platform and then read that tenant's aggregated
  sales/customer/low-stock data via `GET /api/franchise/[id]`. Fixed: add allowed only for the
  caller's own hotel, an already-shared `BranchGroup` sibling, or an idempotent re-attach to the
  same org; `409` if the hotel is bound to a different org; `403` otherwise.
- **FRANCH-02 (P3, error disclosure):** `createFranchise` leaked raw ORM error text to API
  callers. Fixed: generic 500 + server-side `console.error`.
- **TEST-INFRA-01 (P2, CI reliability):** 14/47 security suites never executed — test code built a
  raw `new PrismaClient()` with no driver adapter under the harness's pure-JS client-engine
  config (P2038 at module load), so 13 suites crashed before any test ran and 1 failed a real
  assertion. App code was not implicated. Fixed via a shared `tests/helpers.ts → testDb()`
  (adapter-wired under `STAYLOOP_TEST`+SQLite, plain client otherwise).
- **TEST-INFRA-02 (P3, CI reliability):** the batch migration misplaced `testDb` into the
  `bun:test` import in 6 suites (caught loudly by the per-file harness isolation); corrected to a
  `./helpers` import.
- **BUILD-01 (P2, production build):** a prior `db.ts` change passed `adapter: undefined` on the
  classic-engine path; Prisma 6.19 rejects that (`"adapter" property must not be undefined`),
  which broke `next build` (page-data collection) and non-test dev. Fixed by omitting the key
  when no adapter applies. Both paths verified: test (adapter) and production (classic, PG).

New coverage: **tests/rbac-security-master.test.ts** (26 tests, ~102 assertions) — custom-role
mass-assignment, all 15 reserved permissions, unknown identifiers, inactive-role + deactivation
revocation, cross-hotel both directions, self-assignment no-escalation (incl. a non-admin
baseline delta check), staff owner-boundary (demote/suspend/revoke/re-invite the owner denied),
self-privilege-escalation denied, no SUPER_ADMIN/HOTEL_OWNER minting (invite + PATCH), manager
cannot mint admins, super-admin boundary (public registration ⇒ HOTEL_ADMIN only; platform
endpoints 401 anon / 403 hotel), `revokeSessions` + tampered-token 401, cross-tenant nested
visits/bill-refund/job-status denied with data untouched, and the FRANCH-01 capture regression.

Verification (disposable SQLite DB via driver adapter; live dev server): full `bun run test`
harness — 48 bun suites + 3 acceptance scripts, all passing; `bun run typecheck` clean;
`bun run build` succeeds (with a Postgres `DATABASE_URL`, as on the deploy target).

Verification limits carried over from the prior addendum still apply: no live PostgreSQL/Neon
run, no live payment providers, no real browser CSP/XSS. Recommend one full harness run against a
disposable Neon DB before release.
