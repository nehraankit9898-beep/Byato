# Role and sensitive-operation matrix — 2026-10-17

Extracted from current `src/lib/permissions.ts` ROLE_PERMISSIONS, not UI labels.
11 system roles, 88 permission identifiers. Customers are records/public OTP actors,
not an authenticated CUSTOMER role in UserRole. There is no generic ADMIN role.

## Enforcement and evidence
- `requireAuth` verifies signed session, current DB user/hotel status, tokenVersion,
  password-change restriction, MFA setup restriction, subscription/maintenance state;
  it resolves active same-tenant custom grants per request. Custom grants are additive
  and reserved administrative/financial permissions are excluded.
- `requirePermission` is server-side; tenant IDs must come from the authenticated user,
  not client input. A permission matrix alone does not prove every query has ownership checks.
- `requireSuperAdminSession` checks both signed claim and authoritative database role/status,
  tokenVersion and restricted-session flags. SUPER_ADMIN has a small explicit platform set,
  not an automatic tenant-write bypass. Platform endpoints manage hotels separately.
- Bootstrap API requires configured strong ADMIN_BOOTSTRAP_SECRET, constant-time comparison,
  rate limit and no existing Super Admin; helper uses a persistent atomic one-shot claim.
  No real account was bootstrapped. Mocked endpoint suite: 26 pass; actual DB claim race blocked.
- Staff management is tenant scoped and owner accounts have a hierarchy guard; invitations,
  role/status/session-revocation operations require staff-management authorization. Actual
  role mutation/suspension/deletion against live accounts was NOT tested.
- `logAudit` scrubs sensitive metadata and records sensitive actions; logging is best-effort
  outside transactions. Durable log availability/retention is not verified.

Allowed/denied evidence: 27 unit tests (includes hasPermission), 3 custom-role-resolution tests,
26 bootstrap endpoint tests, and 13 audit regressions (includes staff-owner protection) pass.
These cover boundary behavior/static assertions, NOT direct authorized requests to all 204 routes.
Actual cross-tenant and full role-by-route HTTP tests are BLOCKED by native Prisma availability.
See `audit/CURRENT_ROUTE_INVENTORY.md` for route-to-permission references (heuristic).

## Complete static permission catalog
✓ = default grant; — = denied by the base permission table. Additional endpoint rules,
state restrictions, plan entitlements and tenant ownership may further deny a default grant.
Custom roles can add only the non-reserved grants approved by an authorized owner/admin.

| Sensitive operation / permission | SUPER_ADMIN | HOTEL_OWNER | HOTEL_ADMIN | HOTEL_MANAGER | MARKETING_MANAGER | RESTAURANT_MANAGER | FRONT_DESK | HOTEL_STAFF | CASHIER | KITCHEN_STAFF | WAITER |
|---|---|---|---|---|---|---|---|---|---|---|---|
| AB_EXPERIMENT_MANAGE | — | ✓ | ✓ | — | — | — | — | — | — | — | — |
| AI_MANAGE | — | ✓ | ✓ | — | ✓ | — | — | — | — | — | — |
| AI_READ | — | ✓ | ✓ | — | ✓ | ✓ | — | — | — | — | — |
| ANALYTICS_READ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| ATTENDANCE_MANAGE | — | ✓ | ✓ | ✓ | — | ✓ | — | — | — | — | — |
| ATTENDANCE_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| AUDIT_LOG_READ | ✓ | ✓ | ✓ | ✓ | — | — | — | — | — | — | — |
| AUTOMATION_CREATE | — | ✓ | ✓ | — | ✓ | — | — | — | — | — | — |
| AUTOMATION_DELETE | — | ✓ | ✓ | — | ✓ | — | — | — | — | — | — |
| AUTOMATION_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| AUTOMATION_UPDATE | — | ✓ | ✓ | — | ✓ | — | — | — | — | — | — |
| BENCHMARK_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| BILL_CREATE | — | ✓ | ✓ | ✓ | — | ✓ | — | — | ✓ | — | — |
| BILL_PAY | — | ✓ | ✓ | ✓ | — | ✓ | — | — | ✓ | — | — |
| BILL_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| BILL_REFUND | — | ✓ | ✓ | ✓ | — | ✓ | — | — | — | — | — |
| BILL_VOID | — | ✓ | ✓ | — | — | — | — | — | — | — | — |
| BRANCH_MANAGE | — | ✓ | ✓ | — | — | — | — | — | — | — | — |
| CAMPAIGN_CREATE | — | ✓ | ✓ | — | ✓ | — | — | — | — | — | — |
| CAMPAIGN_DELETE | — | ✓ | ✓ | — | ✓ | — | — | — | — | — | — |
| CAMPAIGN_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| CAMPAIGN_SEND | — | ✓ | ✓ | — | ✓ | — | — | — | — | — | — |
| CAMPAIGN_UPDATE | — | ✓ | ✓ | — | ✓ | — | — | — | — | — | — |
| CASH_SESSION_MANAGE | — | ✓ | ✓ | ✓ | — | ✓ | — | — | ✓ | — | — |
| COUPON_CREATE | — | ✓ | ✓ | — | ✓ | — | — | — | — | — | — |
| COUPON_DELETE | — | ✓ | ✓ | — | ✓ | — | — | — | — | — | — |
| COUPON_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| COUPON_REDEEM | — | ✓ | ✓ | ✓ | — | ✓ | ✓ | — | ✓ | — | — |
| COUPON_UPDATE | — | ✓ | ✓ | — | ✓ | — | — | — | — | — | — |
| CUSTOMER_CREATE | — | ✓ | ✓ | ✓ | — | ✓ | ✓ | — | — | — | — |
| CUSTOMER_DELETE | — | ✓ | ✓ | — | — | — | — | — | — | — | — |
| CUSTOMER_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | ✓ |
| CUSTOMER_UPDATE | — | ✓ | ✓ | ✓ | — | ✓ | ✓ | — | — | — | — |
| CUSTOM_ROLE_MANAGE | — | ✓ | ✓ | — | — | — | — | — | — | — | — |
| ENTERPRISE_API_MANAGE | — | ✓ | ✓ | — | — | — | — | — | — | — | — |
| FEEDBACK_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| FRANCHISE_MANAGE | — | ✓ | ✓ | — | — | — | — | — | — | — | — |
| INTEGRATION_MANAGE | — | ✓ | ✓ | — | — | — | — | — | — | — | — |
| INTEGRATION_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | — |
| INVENTORY_MANAGE | — | ✓ | ✓ | ✓ | — | ✓ | — | — | — | — | — |
| INVENTORY_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | — |
| KDS_ACCESS | — | ✓ | ✓ | ✓ | — | ✓ | — | — | — | ✓ | — |
| LEAD_CREATE | — | ✓ | ✓ | — | ✓ | — | — | — | — | — | — |
| LEAD_DELETE | — | ✓ | ✓ | — | ✓ | — | — | — | — | — | — |
| LEAD_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| LEAD_UPDATE | — | ✓ | ✓ | — | ✓ | — | — | — | — | — | — |
| LOYALTY_MANAGE | — | ✓ | ✓ | — | — | ✓ | — | — | — | — | — |
| LOYALTY_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| MENU_AVAILABILITY | — | ✓ | ✓ | ✓ | — | ✓ | — | — | — | ✓ | — |
| MENU_MANAGE | — | ✓ | ✓ | ✓ | — | ✓ | — | — | — | — | — |
| MENU_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ORDER_CANCEL | — | ✓ | ✓ | ✓ | — | ✓ | — | — | — | — | ✓ |
| ORDER_CREATE | — | ✓ | ✓ | ✓ | — | ✓ | — | — | — | — | ✓ |
| ORDER_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ORDER_SERVE | — | ✓ | ✓ | ✓ | — | ✓ | — | — | — | — | ✓ |
| ORDER_UPDATE | — | ✓ | ✓ | ✓ | — | ✓ | — | — | — | ✓ | ✓ |
| PAYMENT_LINK_MANAGE | — | ✓ | ✓ | ✓ | — | ✓ | — | — | — | — | — |
| PRIVACY_REQUEST_MANAGE | — | ✓ | ✓ | — | — | — | — | — | — | — | — |
| PROFILE_MANAGE | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| PROMOTION_MANAGE | — | ✓ | ✓ | ✓ | ✓ | — | — | — | — | — | — |
| QR_MANAGE | — | ✓ | ✓ | — | — | ✓ | — | — | — | — | — |
| QR_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| REFERRAL_MANAGE | — | ✓ | ✓ | ✓ | ✓ | — | — | — | — | — | — |
| REPORT_MANAGE | — | ✓ | ✓ | ✓ | ✓ | — | — | — | — | — | — |
| RESERVATION_MANAGE | — | ✓ | ✓ | ✓ | — | ✓ | — | — | — | — | ✓ |
| RESERVATION_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| RESTAURANT_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| RESTAURANT_WRITE | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | — |
| SEGMENT_CREATE | — | ✓ | ✓ | — | ✓ | — | — | — | — | — | — |
| SEGMENT_DELETE | — | ✓ | ✓ | — | ✓ | — | — | — | — | — | — |
| SEGMENT_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| SEGMENT_UPDATE | — | ✓ | ✓ | — | ✓ | — | — | — | — | — | — |
| SESSION_MANAGE | — | ✓ | ✓ | ✓ | — | ✓ | — | — | — | — | ✓ |
| SETTINGS_MANAGE | — | ✓ | ✓ | — | — | — | — | — | — | — | — |
| STAFF_MANAGE | — | ✓ | ✓ | — | — | — | — | — | — | — | — |
| STAFF_READ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | — |
| SUPER_ADMIN_ACCESS | ✓ | — | — | — | — | — | — | — | — | — | — |
| TABLE_MANAGE | — | ✓ | ✓ | ✓ | — | ✓ | — | — | — | — | — |
| TABLE_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| TAX_MANAGE | — | ✓ | ✓ | — | — | — | — | — | — | — | — |
| TEMPLATE_MANAGE | — | ✓ | ✓ | — | — | — | — | — | — | — | — |
| TEMPLATE_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| VISIT_CREATE | — | ✓ | ✓ | ✓ | — | ✓ | ✓ | — | — | — | — |
| VISIT_DELETE | — | ✓ | ✓ | — | — | — | — | — | — | — | — |
| VISIT_READ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| VISIT_UPDATE | — | ✓ | ✓ | ✓ | — | ✓ | ✓ | — | — | — | — |
| WEBHOOK_MANAGE | — | ✓ | ✓ | — | — | — | — | — | — | — | — |
| WHITE_LABEL_MANAGE | — | ✓ | ✓ | — | — | — | — | — | — | — | — |
