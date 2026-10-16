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
