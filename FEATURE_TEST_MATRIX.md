# Feature-by-feature verification — 2026-10-17

Each row has exactly one status. A passing unit/contract test does not establish an end-to-end workflow.
Full server/DB/browser testing is blocked at native Prisma download. No real provider credentials were supplied.

| Feature discovered in source | Status | Evidence this session / next complete check |
|---|---|---|
| Session crypto, CSRF, basic RBAC primitives | WORKING | 27 unit tests pass; this row is primitives only, not full login |
| MFA enrollment guards and single-winner confirmation | WORKING | Five behavioral tests pass with mocked Prisma boundary; HTTP/DB still required |
| Outbound webhook subscription matcher | WORKING | Matcher regressions pass for namespace/exact/global/invalid/inactive cases |
| Registration/login/logout/session expiry | BLOCKED | auth routes + login/register screens exist; run auth.test.ts on isolated server, valid/invalid/duplicate/revoked sessions |
| Password recovery and email verification | BLOCKED | hashed one-time security tokens + email adapters; run phase7 and email delivery/link expiry tests |
| Tenant onboarding/owner activation | BLOCKED | super-admin tenant APIs and activate page; test invitation, duplicate email, suspended tenant, expired token |
| Super Admin bootstrap/management | BLOCKED | 26 mocked endpoint tests pass, five hotel error tests pass; real DB one-shot race, forced change, MFA and dashboard not exercised |
| Staff/custom roles and cross-tenant authorization | BLOCKED | custom role boundary tests pass; HTTP allowed/denied/foreign-ID/session revocation suites need live DB |
| Customer registration/contact/consent | BLOCKED | customer routes + public QR/OTP flows; test phone normalization, duplicate, ownership proof, opt-out and foreign tenant |
| Customer visit and repeat history | BLOCKED | visits/restaurant/timeline modules; test insert/update/delete, tenant boundaries and historical totals |
| Loyalty points/offers/discount rules | BLOCKED | loyalty/coupons/promotions services; test accrual, replay, redemption, concurrency, expiry and arithmetic |
| Campaigns/segments/automations/journeys | BLOCKED | real queue/scheduler pipeline; test consent, retries, due-time windows, deduplication, worker outage and cancellation |
| Messaging without configured credentials | MOCK | explicitly labeled SIMULATION/MockEmailProvider exists for dev/test; no live delivery claim |
| Real email/SMS/WhatsApp integrations | BLOCKED | SMTP/Resend/SendGrid, Twilio and Meta adapters; credentials and provider domains unavailable here |
| Public QR menu/items/availability | BLOCKED | /menu/[code], menu/tables/public APIs; test availability, invalid code, kitchen authorization and mobile rendering |
| Orders/KDS/table sessions/offline replay | BLOCKED | order state machine and offline outbox present; test duplicate submit/replay, pricing, prep/serve/cancel role separation and disconnection |
| POS/GST bills/split payments/refunds/cash sessions | BLOCKED | billing/pay routes; callback boundary tests pass but live settlement/arithmetic/rollback/refunds unverified |
| SaaS subscriptions/plans/coupons/payment gateways | BLOCKED | platform billing + Razorpay/Stripe/manual adapters; test sandbox order/capture/signature/idempotency/expiry/refund stages |
| Reservations/inventory/attendance/shifts/branches | BLOCKED | corresponding routes/views/services; run phase16 with stock races, reservation conflicts and branch ownership |
| Dashboard/reports/analytics/export | BLOCKED | analytics/export/report scheduler and views; test DB totals/time zones, CSV permissions, quotas and download tokens |
| Enterprise API keys/franchise/custom domains/privacy/AB tests | BLOCKED | implementations and route inventory exist; test API scopes, domain verification, consent erasure and tenant boundaries |
| AI chatbot/recommendations/forecasting/voice | NOT VERIFIED | source contains governance/intent/forecast/parser implementations; no complete runtime AI/voice workflow tested here |
| Apple/Google wallet signing/distribution | PARTIAL | pass records/update HMAC are implemented; source explicitly reports BLOCKED_PROVIDER_ACCESS, not actual signed wallet delivery |
| Backups/restore/worker health/secret rotation | BLOCKED | crypto/restore-argument tests pass; native PG/Redis/worker/pg_dump and disposable restore remain unavailable |
| Standard vs standalone build contract | WORKING | three configuration tests pass, direct engine-free Next compile passes; deploy/runtime not included |
| Browser accessibility/responsive/error-recovery workflows | NOT VERIFIED | UI source mapped; no browser E2E or assistive-technology pass was executed |

## Common acceptance plan for every workflow
For each BLOCKED/NOT VERIFIED workflow: test realistic success, malformed/oversized input,
missing/expired session, denied role, foreign-tenant identifiers, duplicate submission,
empty state, provider/network failure and recovery. For financial/stock/loyalty paths also
run concurrent retries and verify persistent balances/side effects exactly once. Exercise
Asia/Kolkata and UTC date boundaries plus DST tenants. Browser tests must include keyboard,
focus recovery, screen-reader labels, mobile widths and visible loading/error/empty states.
Historical test files are useful test plans but their existence is not a fresh PASS.
