# SECURITY_AUDIT.md — StayLoop Merged Repository

**Date:** 2026-10-16
**Scope:** merged repository (base: `stayloop-fixed-repo`, restored: `hotal-main (2)` payment-idempotency stack), cross-checked against the repository's own audit trail (`audit/SECURITY_FINDINGS.md`, `audit/REMAINING_RISKS.md`, `audit/REPAIR_CHANGELOG.md`).
**Verification basis:** source review + executed test evidence (`bun run test` equivalent: 711 assertions green — see TEST_REPORT.md). No dynamic penetration testing was performed; no real customer data or payment transactions were used.

Legend: **[CONFIRMED-FIXED]** = fixed and covered by an executing regression test. **[VERIFIED-SAFE]** = reviewed, no finding. **[POTENTIAL]** = plausible risk that requires investigation beyond this merge. **[ACCEPTED]** = documented design decision.

---

## 1. Authentication & Session Management — VERIFIED-SAFE

- **Password hashing:** scrypt, N=2^17, r=8, p=1, per-hash random 16-byte salt (OWASP baseline). Legacy v1 hashes (N=16384) transparently rehash on next successful login.
- **Session tokens:** HMAC-SHA256 over the token body, verified with `timingSafeEqual`; expiry checked; malformed cookies rejected without a 500.
- **Revocation:** per-user `tokenVersion` bumped on logout, password reset/change, staff deactivation, custom-role assignment, and force-logout. `requireAuth` re-reads the user from the DB on **every** request (status, tenant status, token version, forced password change, MFA policy, subscription state, maintenance mode) — no stale-trust windows.
- **Lockout:** login rate limiting + account lockout with cooldown (`tests/lockout.test.ts` green).
- **MFA:** TOTP support with enrollment flow; dev-only enrollment helper gated out of production.
- **Bootstrap:** super-admin bootstrap is one-time (409 once a superadmin exists), secret-gated with timing-safe comparison, rate-limited, and disabled entirely when `ADMIN_BOOTSTRAP_SECRET` is unset.

## 2. Authorization & Tenant Isolation — CONFIRMED-FIXED / VERIFIED-SAFE

- **Route guards:** every API route calls `requireAuth` (+ `requirePermission` for role checks); the test suite exercises role matrices across 41 suites, including dedicated `rbac-tenant.test.ts` (cross-tenant customer access denied), `navigation-rbac.test.ts`, and `super-admin-platform.test.ts` (hotel users + anonymous callers rejected from platform APIs) — all green in this merge run.
- **Super-admin vs hotel-admin:** SUPER_ADMIN carries no hotel tenant; tenant-scoped handlers always filter by `auth.user.hotelId`, and hotel users cannot reach super-admin management endpoints (tested).
- **Cross-tenant object references:** 205 `hotelId`-scoped query patterns across the API tree; sampling plus the dedicated cross-tenant test (customer list/update/delete, visits/coupons/segments/campaigns/integrations/audit logs, cross-tenant bill ID → 404) verified green.
- **Custom roles (FUNC-001, historical):** repaired in a prior pass — `requireAuth` resolves active same-hotel role assignments per request; super-admin and high-risk permissions excluded from custom grants. `custom-role-resolution.test.ts` (3) and `custom-role-api.test.ts` (1) green in this merge run.
- **IDOR on wallets:** wallet pass updates require the HMAC pass token bound to the serial (`wallet/pass/[serial]` route), now sourced from the canonical `getAuthSecret()` accessor (merge fix retained).

## 3. Payment Security — CONFIRMED-FIXED (this merge's core restore)

- **Duplicate-payment protection:** `BillPayment.idempotencyKey String? @unique` (both schemas) + migration `0013` + `recordManualPayment` with:
  - SHA-256-scoped key hashing (raw tokens never stored, no substring bugs);
  - **conflict rejection** — reusing a key with a different amount/method/reference/cash-session returns 422, never a silent success (tested: `phase14-billing.test.ts` "same key does not double-allocate", 22/22 green);
  - **P2002 concurrent-winner handling** — the unique index is the authoritative fence; concurrent retries replay the committed result instead of double-charging;
  - **legacy pre-column rows** readable via JSON-escaped `meta` fallback (compatibility only, never the primary fence);
  - replays resolved **before** terminal-state checks (a retry after a later void/refund still identifies the original payment).
- **Gateway captures:** fenced by `gatewayPaymentId @unique`; webhook signature (raw-body HMAC, constant-time compare, 5-minute replay window) is verified **before** allocation; amounts are bound to the stored intent, never client-supplied. FIN-001 (dedupe-row leak on allocation error, causing dropped captures) was fixed in a prior pass and is pinned by `payment-callback-routes.test.ts` (10/10 green) + `payment-link-settle.test.ts` (4/4) + `billing-outbox.test.ts` (10/10).
- **Refund integrity:** partial vs full refund states computed inside the DB transaction (`PARTIALLY_REFUNDED` restored in this merge); refund caps enforced against paid totals (tested).
- **No raw payment credentials stored** — only provider references/UTRs; integration secrets are AES-256-GCM encrypted at rest with key rotation support (`crypto-rotation.test.ts` 11/11 green).
- **Public payment links:** amount frozen on the link (client cannot alter); rate-limited per IP per action (read 60/min, checkout 10/min, verify 30/min) — SEC-007 closed by the prior repair pass, verified present in this merge; `payment-link-limit.test.ts` green.

## 4. Injection-Class Vulnerabilities — CONFIRMED-FIXED

- **QR print window (XSS/markup injection):** staff-editable label and dynamic URL are HTML-escaped before `document.write()` into the print window (fixed-fork fix retained and **consolidated** into the shared, unit-tested `src/lib/html-escape.ts` — 16 regression tests green in `tests/qr-injection-regression.test.ts`).
- **Bill receipts:** server-rendered HTML escapes every dynamic value through the same shared helper; the only script is hash-pinned by the response CSP (`script-src 'sha256-…'`); `frame-ancestors 'none'`, `no-store`.
- **Transactional email:** templates escape through the shared helper — the previously missing single-quote escaping in the email copy is now fixed (latent attribute-breakout closed).
- **SQL injection:** the only raw SQL in the codebase (`src/lib/saas/limits.ts`, `api/health`) uses Prisma tagged templates — parameterized. No string-concatenated queries found.
- **URL schemes (QR):** `buildPublicUrl` now validates http/https origins — `javascript:`, `data:`, `vbscript:`, `file:`, and malformed origins degrade to a relative URL and can never be embedded into a customer-scanned QR (new in this merge; tested).
- **CSP:** nonce-based script CSP per request (`src/proxy.ts`); `unsafe-eval` only in development; `object-src 'none'`; explicit `frame-ancestors`; no inline event handlers. The chart component's single `dangerouslySetInnerHTML` (shadcn `ChartStyle`) interpolates only `useId()`-derived IDs and developer-defined theme colors — no user input reaches it. **[VERIFIED-SAFE]**

## 5. CSRF & Session Cookie Security — VERIFIED-SAFE / ACCEPTED

- CSRF checked **first** in `requireAuth` for state-changing requests: Origin/Referer host match plus double-submit cookie for cookie sessions.
- Session cookies: `httpOnly`, `Secure` (HTTPS detected via the proxy chain), `SameSite=None; Partitioned` in production to support the embedded-preview deployment, `SameSite=Lax` locally. **[ACCEPTED]** — the `SameSite=None` requirement is the documented cost of the embedded iframe product mode; bearer-token alternative documented as SEC-008.
- Logout requires CSRF (SEC-006 fixed in a prior pass).

## 6. Secrets & Environment Handling — VERIFIED-SAFE

- Production is fail-closed: `AUTH_SECRET`, `INTEGRATION_ENCRYPTION_KEY` required (placeholder values rejected); `TRACKING_WEBHOOK_SECRET` gates webhooks to 503; `ADMIN_BOOTSTRAP_SECRET` gates bootstrap. `STAYLOOP_TEST` in production is blocked (SEC-004 fix).
- Dev secrets auto-generate to a gitignored file; test mode uses deterministic in-code material (never production).
- `.env.example` contains names + safe placeholders only; `.env*` gitignored with explicit allowlist for example files; `scripts/scan-secrets.ts` runs in CI; the committed 2.2 MB demo database with known-password accounts (present in the original ZIP) was **excluded** from the merge and its path gitignored.
- Webhook/QR/cron secrets are never accepted from query strings (tested).

## 7. Rate Limiting & Input Validation — CONFIRMED-FIXED

- Login, login-security, public feedback, public QR join, payment links (read/checkout/verify), and bootstrap are rate-limited. Distributed limiting via Redis when `REDIS_URL` is set; documented in-process fallback per instance otherwise (accepted multi-instance limitation).
- Request bodies are size-capped (Content-Length + streaming cap — SEC-005 fix), JSON-validated via shared Zod schemas, and trimmed/sliced at handler boundaries.
- QR labels: trimmed, max 80 chars, escaped at every render point; QR codes: server-generated 24-byte `base64url` (unpredictable, URL-safe — tested).

## 8. Privacy & Data Exposure — VERIFIED-SAFE

- Customer phone numbers masked in staff-facing lists and analytics (`privacy-phone.test.ts` 14/14 green); full numbers only where operationally required.
- Payment-link status endpoint exposes only restaurant name, amount, currency, and payability — never other bills or personal data.
- Public QR resolution exposes restaurant-level data only (no tenant internals); inactive/unknown codes return generic reasons.
- Privacy/data-subject-request workflow (`src/lib/privacy.ts`) is role-gated (owner/admin only), stateful, and audit-logged. **Note:** it is a technical scaffold — the module itself disclaims blanket GDPR/DPDP certification and defers to the operator's documented procedure. **[ACCEPTED]**
- Test-mode mock email endpoint is production-gated.

## 9. Logging & Error Responses — VERIFIED-SAFE

- Central `serverError` handlers return generic messages (no stack traces, no internals); detailed errors are logged server-side only via the structured logger with secret redaction.
- Audit log covers security-relevant mutations (QR create, role changes, exports, payments, privacy actions) with metadata that never includes credentials.

## 10. Findings Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| M-1 | Payment-idempotency regression in the fixed fork (double-charge on concurrent retry; silent success on key reuse with different amount) | **Critical (if deployed)** | **Fixed in this merge** — schema constraint + migration + logic + tests restored; 22/22 billing suite green |
| M-2 | Deleted regression assertions hiding M-1 | High | **Fixed** — original assertions restored; suite enforces registration of all test files |
| M-3 | Committed dev database with known-password accounts (original ZIP) | High (if deployed) | **Fixed** — excluded from merge; `prisma/db/` gitignored |
| M-4 | QR print-window markup injection | High | **Fixed (fixed fork) + consolidated + 16 new regression tests** |
| M-5 | `buildPublicUrl` accepted non-http(s) origins | Medium | **Fixed in this merge** — scheme validation + tests |
| M-6 | `escapeHtml` divergence — email copy missed `'` | Low | **Fixed** — single shared implementation |
| M-7 | Wallet-pass route bypassed canonical secret accessor | Medium (dev/test) | **Fixed (fixed fork)** — `getAuthSecret()`, 503 fail-closed |
| M-8 | Test-infrastructure secret-adoption race | Medium (test reliability) | **Fixed (fixed fork)** — deterministic test secrets + regression suite |
| SEC-007 | Payment-link rate limiting (historical) | Low | Closed in a prior pass — verified present |
| SEC-008 | Bearer tokens on every route | Informational | **[ACCEPTED]** documented design (iframe fallback), mitigated by nonce CSP |
| — | `SameSite=None; Partitioned` production cookies | Informational | **[ACCEPTED]** embedded-preview requirement |

## 11. Potential Risks — Require Investigation Beyond This Merge

1. **Per-handler tenant-isolation review is not 100% line-by-line.** 205 scoped query patterns + the tenant-isolation suites provide strong coverage, but ~200 handlers were audited by pattern and targeted review, not exhaustively read line-by-line. Residual risk: an unscoped `findUnique` on an `[id]` route. Recommendation: continue the route-by-route review in `audit/ROUTE_INVENTORY.md` order.
2. **QR URL uses request origin when `APP_ORIGIN` is unset.** For single-domain deployments this is correct; a Host-header-poisoned staff request could mint QRs pointing at an attacker origin (QRs resolve tenant server-side, so impact is phishing-adjacent, not data leakage). Recommendation: set `APP_ORIGIN` in production and consider rejecting QR creation when no explicit origin is configured.
3. **Distributed rate limiting requires Redis**; without `REDIS_URL` each instance counts independently (documented). Multi-instance Netlify/cluster deployments should provision Redis.
4. **Third-party integrations (Razorpay, Twilio, WhatsApp, SMTP) were reviewed statically, not exercised** against provider sandboxes — no credentials available in this environment (BLOCKED, see TEST_REPORT.md).
5. **Browser-level XSS/CSP regression testing** (e.g., via headless-browser suite) is not part of this run; the CSP nonce pipeline is enforced in `src/proxy.ts` and covered by route tests, but DOM-level regression automation would add depth.

## 12. Least-Privilege Confirmation

Each hotel/restaurant tenant can access only its own data ( enforced by `hotelId` scoping + suite tests). SUPER_ADMIN can manage platform-wide resources through dedicated `/api/super-admin/*` routes that reject hotel users and anonymous callers (tested). Staff sub-roles (HOTEL_STAFF, KITCHEN, CASHIER etc.) are restricted per the RBAC matrix — the kitchens cannot pay bills, cashiers cannot refund or create tax rules (all pinned by passing tests). No authorization was weakened to make any test pass.
