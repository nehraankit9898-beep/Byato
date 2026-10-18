> 2026-10-18 recheck: **204 route files**, no route additions/removals in this patch. The full disposable-SQLite suite now executes (see `DEEP_BUG_HUNT_2026-10-18.md`); the older "runtime access tests blocked" statement below is historical, not the current suite result. Real PostgreSQL/provider/browser authorization coverage is still not universal.

# Current route discovery — 2026-10-17

204 route files. Static discovery only: a guard name is not proof of authorization, and hotelId text is not proof of isolation. Delegated guards must be read in their helpers. Runtime access tests remain blocked. Historical audit files are not fresh evidence.

| File | Methods | Guard references (heuristic) | Permission literals |
|---|---|---|---|
| `src/app/api/ab-experiments/[id]/kill/route.ts` | POST | requireAuth | AB_EXPERIMENT_MANAGE |
| `src/app/api/ab-experiments/route.ts` | GET,POST | requireAuth | AB_EXPERIMENT_MANAGE |
| `src/app/api/ai/conversations/route.ts` | GET | requireAuth | AI_READ |
| `src/app/api/ai/forecast/route.ts` | GET,POST | requireAuth | AI_MANAGE,AI_READ |
| `src/app/api/ai/interactions/route.ts` | GET | requireAuth | AI_READ |
| `src/app/api/ai/recommendations/[id]/approve/route.ts` | POST | requireAuth | AI_MANAGE |
| `src/app/api/ai/recommendations/[id]/dismiss/route.ts` | POST | requireAuth | AI_MANAGE |
| `src/app/api/ai/recommendations/route.ts` | GET,POST | requireAuth | AI_MANAGE,AI_READ |
| `src/app/api/ai/settings/route.ts` | GET,PATCH | requireAuth | AI_READ |
| `src/app/api/ai/sustainability/route.ts` | GET,POST,PATCH | requireAuth | AI_MANAGE,AI_READ |
| `src/app/api/ai/voice/parse/route.ts` | POST | requireAuth | ORDER_CREATE |
| `src/app/api/ai/whatsapp/webhook/route.ts` | GET,POST | delegated/public — review source | — |
| `src/app/api/analytics/overview/route.ts` | GET | requireAuth | ANALYTICS_READ |
| `src/app/api/api-keys/[id]/route.ts` | DELETE | requireAuth | SETTINGS_MANAGE |
| `src/app/api/api-keys/route.ts` | GET,POST | requireAuth | SETTINGS_MANAGE |
| `src/app/api/attendance/route.ts` | GET,POST | requireAuth | ATTENDANCE_MANAGE,ATTENDANCE_READ |
| `src/app/api/audit-logs/route.ts` | GET | requireAuth | AUDIT_LOG_READ |
| `src/app/api/auth/activate/route.ts` | POST | delegated/public — review source | — |
| `src/app/api/auth/forgot-password/route.ts` | POST | delegated/public — review source | — |
| `src/app/api/auth/login/route.ts` | POST | delegated/public — review source | — |
| `src/app/api/auth/logout/route.ts` | POST | delegated/public — review source | — |
| `src/app/api/auth/me/route.ts` | GET | requireAuth | — |
| `src/app/api/auth/mfa/verify/route.ts` | POST | delegated/public — review source | — |
| `src/app/api/auth/resend-verification/route.ts` | POST | delegated/public — review source | — |
| `src/app/api/auth/reset-password/route.ts` | POST | delegated/public — review source | — |
| `src/app/api/auth/verify-email/route.ts` | POST | delegated/public — review source | — |
| `src/app/api/automations/route.ts` | GET,POST | requireAuth | AUTOMATION_CREATE,AUTOMATION_READ |
| `src/app/api/automations/run/route.ts` | POST,PUT | requireAuth | AUTOMATION_UPDATE |
| `src/app/api/benchmarking/route.ts` | GET,POST | requireAuth | BENCHMARK_READ |
| `src/app/api/billing/checkout/[paymentId]/route.ts` | GET | requireAuth | — |
| `src/app/api/billing/checkout/route.ts` | POST | requireAuth | — |
| `src/app/api/billing/checkout/verify/route.ts` | POST | requireAuth | — |
| `src/app/api/billing/webhook/[provider]/route.ts` | POST | delegated/public — review source | — |
| `src/app/api/bills/[id]/pay/route.ts` | POST | requireAuth | BILL_PAY |
| `src/app/api/bills/[id]/receipt/route.ts` | GET | requireAuth | BILL_READ |
| `src/app/api/bills/[id]/refund/route.ts` | POST | requireAuth | BILL_REFUND,BILL_VOID |
| `src/app/api/bills/[id]/route.ts` | GET | requireAuth | BILL_READ |
| `src/app/api/bills/route.ts` | GET,POST | requireAuth | BILL_CREATE,BILL_READ,RESTAURANT_WRITE |
| `src/app/api/branches/route.ts` | GET,POST | requireAuth | BRANCH_MANAGE |
| `src/app/api/campaigns/[id]/analytics/route.ts` | GET | requireAuth | CAMPAIGN_READ |
| `src/app/api/campaigns/[id]/attribute-booking/route.ts` | POST | requireAuth | CAMPAIGN_UPDATE |
| `src/app/api/campaigns/[id]/retry/route.ts` | POST | requireAuth | CAMPAIGN_SEND |
| `src/app/api/campaigns/[id]/route.ts` | GET,PATCH,DELETE | requireAuth | CAMPAIGN_DELETE,CAMPAIGN_READ,CAMPAIGN_UPDATE |
| `src/app/api/campaigns/[id]/send/route.ts` | POST | requireAuth | CAMPAIGN_SEND |
| `src/app/api/campaigns/[id]/test/route.ts` | POST | requireAuth | CAMPAIGN_SEND |
| `src/app/api/campaigns/route.ts` | GET,POST | requireAuth | CAMPAIGN_CREATE,CAMPAIGN_READ |
| `src/app/api/campaigns/run-engine/route.ts` | GET,POST | requireAuth | CAMPAIGN_READ,CAMPAIGN_SEND |
| `src/app/api/cash-sessions/[id]/route.ts` | PATCH | requireAuth | CASH_SESSION_MANAGE |
| `src/app/api/cash-sessions/route.ts` | GET,POST | requireAuth | CASH_SESSION_MANAGE |
| `src/app/api/coupons/redeem/route.ts` | POST | requireAuth | COUPON_REDEEM |
| `src/app/api/coupons/route.ts` | GET,POST | requireAuth | COUPON_CREATE,COUPON_READ |
| `src/app/api/coupons/validate/route.ts` | POST | requireAuth | COUPON_READ |
| `src/app/api/custom-roles/[id]/assign/route.ts` | POST,DELETE | requireAuth | CUSTOM_ROLE_MANAGE |
| `src/app/api/custom-roles/[id]/route.ts` | PATCH | requireAuth | CUSTOM_ROLE_MANAGE |
| `src/app/api/custom-roles/route.ts` | GET,POST | requireAuth | CUSTOM_ROLE_MANAGE |
| `src/app/api/customers/[id]/consent/route.ts` | POST | requireAuth | CUSTOMER_UPDATE |
| `src/app/api/customers/[id]/opt-out/route.ts` | POST | requireAuth | CUSTOMER_UPDATE |
| `src/app/api/customers/[id]/route.ts` | GET,PATCH,DELETE | requireAuth | CUSTOMER_DELETE,CUSTOMER_READ,CUSTOMER_UPDATE |
| `src/app/api/customers/[id]/visits/route.ts` | GET,POST | requireAuth | VISIT_CREATE,VISIT_READ |
| `src/app/api/customers/route.ts` | GET,POST | requireAuth | CUSTOMER_CREATE,CUSTOMER_READ |
| `src/app/api/dashboard/stats/route.ts` | GET | requireAuth | ANALYTICS_READ |
| `src/app/api/export/customers/route.ts` | GET | requireAuth | CUSTOMER_READ |
| `src/app/api/feedback/route.ts` | GET | requireAuth | FEEDBACK_READ |
| `src/app/api/follow-ups/route.ts` | GET,PUT | requireAuth | CAMPAIGN_READ,CAMPAIGN_UPDATE |
| `src/app/api/franchise/[id]/branches/route.ts` | POST | requireAuth | FRANCHISE_MANAGE |
| `src/app/api/franchise/[id]/route.ts` | GET | requireAuth | FRANCHISE_MANAGE |
| `src/app/api/franchise/route.ts` | GET,POST | requireAuth | FRANCHISE_MANAGE |
| `src/app/api/health/live/route.ts` | GET | delegated/public — review source | — |
| `src/app/api/health/route.ts` | GET | delegated/public — review source | — |
| `src/app/api/hotels/route.ts` | POST | delegated/public — review source | — |
| `src/app/api/imports/customers/preview/route.ts` | POST | requireAuth | CUSTOMER_CREATE |
| `src/app/api/imports/customers/route.ts` | POST | requireAuth | CUSTOMER_CREATE |
| `src/app/api/imports/visits/preview/route.ts` | POST | requireAuth | VISIT_CREATE |
| `src/app/api/imports/visits/route.ts` | POST | requireAuth | VISIT_CREATE |
| `src/app/api/integrations/route.ts` | GET,POST,PATCH,DELETE | requireAuth | INTEGRATION_MANAGE,INTEGRATION_READ |
| `src/app/api/integrations/verify/route.ts` | POST | requireAuth | INTEGRATION_MANAGE |
| `src/app/api/inventory/counts/route.ts` | GET,POST,PATCH | requireAuth | INVENTORY_MANAGE,INVENTORY_READ |
| `src/app/api/inventory/ingredients/route.ts` | GET,POST,PATCH | requireAuth | INVENTORY_MANAGE,INVENTORY_READ |
| `src/app/api/inventory/ledger/route.ts` | GET,POST | requireAuth | INVENTORY_MANAGE,INVENTORY_READ |
| `src/app/api/inventory/purchase-orders/route.ts` | GET,POST,PATCH | requireAuth | INVENTORY_MANAGE,INVENTORY_READ |
| `src/app/api/inventory/recipes/route.ts` | GET,POST,DELETE | requireAuth | INVENTORY_MANAGE,INVENTORY_READ |
| `src/app/api/jobs/[id]/download/route.ts` | GET | requireAuth | CUSTOMER_READ |
| `src/app/api/jobs/[id]/route.ts` | GET | requireAuth | — |
| `src/app/api/journeys/[id]/enroll/route.ts` | POST | requireAuth | CAMPAIGN_SEND |
| `src/app/api/journeys/[id]/enrollments/[enrollmentId]/route.ts` | PATCH | requireAuth | CAMPAIGN_UPDATE |
| `src/app/api/journeys/route.ts` | GET,POST | requireAuth | CAMPAIGN_CREATE,CAMPAIGN_READ |
| `src/app/api/kds/route.ts` | GET | requireAuth | KDS_ACCESS |
| `src/app/api/lead-events/route.ts` | GET,POST | requireAuth | LEAD_CREATE,LEAD_READ |
| `src/app/api/loyalty/adjust/route.ts` | POST | requireAuth | LOYALTY_MANAGE |
| `src/app/api/loyalty/reconcile/route.ts` | POST | requireAuth | LOYALTY_MANAGE |
| `src/app/api/loyalty/redeem/route.ts` | POST | requireAuth | LOYALTY_MANAGE |
| `src/app/api/loyalty/route.ts` | GET,PUT | requireAuth | LOYALTY_MANAGE,LOYALTY_READ |
| `src/app/api/loyalty/transactions/route.ts` | GET | requireAuth | LOYALTY_READ |
| `src/app/api/menu/categories/[id]/route.ts` | PATCH,DELETE | requireAuth | MENU_MANAGE |
| `src/app/api/menu/categories/route.ts` | GET,POST | requireAuth | MENU_MANAGE,MENU_READ |
| `src/app/api/menu/items/[id]/availability/route.ts` | PATCH | requireAuth | MENU_AVAILABILITY,MENU_MANAGE |
| `src/app/api/menu/items/[id]/options/route.ts` | GET,PUT | requireAuth | MENU_MANAGE,MENU_READ |
| `src/app/api/menu/items/[id]/route.ts` | GET,PATCH,DELETE | requireAuth | MENU_MANAGE,MENU_READ |
| `src/app/api/menu/items/route.ts` | GET,POST | requireAuth | MENU_MANAGE,MENU_READ |
| `src/app/api/mfa/backup-codes/route.ts` | POST | requireAuth | — |
| `src/app/api/mfa/disable/route.ts` | POST | requireAuth | — |
| `src/app/api/mfa/enable/route.ts` | POST | requireAuth | — |
| `src/app/api/mfa/route.ts` | GET | requireAuth | — |
| `src/app/api/mfa/setup/route.ts` | POST | requireAuth | — |
| `src/app/api/notifications/route.ts` | GET,PUT,DELETE | requireAuth | — |
| `src/app/api/offline/sync/route.ts` | POST | requireAuth | ORDER_CREATE |
| `src/app/api/orders/[id]/items/[itemId]/route.ts` | PATCH | requireAuth | ORDER_READ |
| `src/app/api/orders/[id]/route.ts` | GET,PATCH | requireAuth | ORDER_READ |
| `src/app/api/orders/route.ts` | GET,POST | requireAuth | ORDER_CREATE,ORDER_READ |
| `src/app/api/pay/[token]/checkout/route.ts` | POST | limitPaymentLinkRequest | — |
| `src/app/api/pay/[token]/route.ts` | GET | limitPaymentLinkRequest | — |
| `src/app/api/pay/[token]/verify/route.ts` | POST | limitPaymentLinkRequest,verifyGatewaySignature | — |
| `src/app/api/payment-links/route.ts` | GET,POST,PATCH | requireAuth | BILL_READ,PAYMENT_LINK_MANAGE |
| `src/app/api/pricing/route.ts` | GET | delegated/public — review source | — |
| `src/app/api/privacy-requests/[id]/approve/route.ts` | POST | requireAuth | PRIVACY_REQUEST_MANAGE |
| `src/app/api/privacy-requests/[id]/execute/route.ts` | POST | requireAuth | PRIVACY_REQUEST_MANAGE |
| `src/app/api/privacy-requests/route.ts` | GET,POST | requireAuth | PRIVACY_REQUEST_MANAGE |
| `src/app/api/profile/route.ts` | PATCH | requireAuth | — |
| `src/app/api/promotions/[id]/route.ts` | PATCH,DELETE | requireAuth | PROMOTION_MANAGE |
| `src/app/api/promotions/route.ts` | GET,POST | requireAuth | BILL_READ,PROMOTION_MANAGE |
| `src/app/api/public/feedback/route.ts` | POST | delegated/public — review source | — |
| `src/app/api/public/join/route.ts` | POST | delegated/public — review source | — |
| `src/app/api/public/menu/[code]/route.ts` | GET | delegated/public — review source | — |
| `src/app/api/public/menu/[code]/voice/route.ts` | POST | delegated/public — review source | — |
| `src/app/api/public/orders/[token]/route.ts` | GET | delegated/public — review source | — |
| `src/app/api/public/orders/route.ts` | POST | delegated/public — review source | — |
| `src/app/api/public/qr/[code]/route.ts` | GET | delegated/public — review source | — |
| `src/app/api/qr-codes/[id]/route.ts` | PATCH,DELETE | requireAuth | QR_MANAGE |
| `src/app/api/qr-codes/route.ts` | GET,POST | requireAuth | QR_MANAGE,QR_READ |
| `src/app/api/referrals/route.ts` | GET,PUT,POST | requireAuth | CUSTOMER_READ,REFERRAL_MANAGE |
| `src/app/api/report-schedule/route.ts` | GET,PUT | requireAuth | REPORT_MANAGE |
| `src/app/api/reports/sales/route.ts` | GET | requireAuth | BILL_READ |
| `src/app/api/reservations/route.ts` | GET,POST,PATCH | requireAuth | RESERVATION_MANAGE,RESERVATION_READ |
| `src/app/api/restaurant/leaderboard/route.ts` | GET | requireAuth | RESTAURANT_READ |
| `src/app/api/restaurant/segments/refresh/route.ts` | PUT | requireAuth | RESTAURANT_WRITE |
| `src/app/api/restaurant/segments/route.ts` | GET | requireAuth | RESTAURANT_READ |
| `src/app/api/restaurant/visits/[id]/route.ts` | PATCH,DELETE | requireAuth | RESTAURANT_WRITE |
| `src/app/api/restaurant/visits/route.ts` | GET,POST | requireAuth | RESTAURANT_READ,RESTAURANT_WRITE |
| `src/app/api/restaurant-payments/order/route.ts` | POST | requireAuth | BILL_PAY |
| `src/app/api/restaurant-payments/verify/route.ts` | POST | requireAuth,verifyGatewaySignature | BILL_PAY |
| `src/app/api/route.ts` | GET | delegated/public — review source | — |
| `src/app/api/scoring/route.ts` | GET,POST | requireAuth | LEAD_READ,LEAD_UPDATE |
| `src/app/api/segments/[id]/members/route.ts` | POST,DELETE | requireAuth | SEGMENT_UPDATE |
| `src/app/api/segments/[id]/route.ts` | GET,PATCH,DELETE | requireAuth | SEGMENT_DELETE,SEGMENT_READ,SEGMENT_UPDATE |
| `src/app/api/segments/route.ts` | GET,POST,PUT | requireAuth | SEGMENT_CREATE,SEGMENT_READ |
| `src/app/api/sessions/[id]/route.ts` | PATCH | requireAuth | SESSION_MANAGE |
| `src/app/api/sessions/route.ts` | GET,POST | requireAuth | SESSION_MANAGE,TABLE_READ |
| `src/app/api/settings/route.ts` | GET,PUT | requireAuth | LOYALTY_READ,SETTINGS_MANAGE |
| `src/app/api/shifts/route.ts` | GET,POST,DELETE | requireAuth | ATTENDANCE_MANAGE,ATTENDANCE_READ |
| `src/app/api/staff/[id]/route.ts` | PATCH | requireAuth | STAFF_MANAGE |
| `src/app/api/staff/route.ts` | GET,POST | requireAuth | STAFF_MANAGE,STAFF_READ |
| `src/app/api/subscription/route.ts` | GET | requireAuth | — |
| `src/app/api/super-admin/announcements/route.ts` | POST | requireSuperAdminSession | — |
| `src/app/api/super-admin/audit/route.ts` | GET | requireSuperAdminSession | — |
| `src/app/api/super-admin/backups/route.ts` | GET,POST | requireSuperAdminSession | — |
| `src/app/api/super-admin/billing/route.ts` | GET,PUT,POST | requireSuperAdminSession | — |
| `src/app/api/super-admin/bootstrap/route.ts` | POST | delegated/public — review source | — |
| `src/app/api/super-admin/coupons/[id]/route.ts` | PUT,DELETE | requireSuperAdminSession | — |
| `src/app/api/super-admin/coupons/route.ts` | GET,POST | requireSuperAdminSession | — |
| `src/app/api/super-admin/feature-flags/route.ts` | GET,PUT | requireSuperAdminSession | — |
| `src/app/api/super-admin/features/route.ts` | GET,PUT | requireSuperAdminSession | — |
| `src/app/api/super-admin/health/route.ts` | GET | requireSuperAdminSession | — |
| `src/app/api/super-admin/hotels/activate/route.ts` | POST | requireSuperAdminSession | — |
| `src/app/api/super-admin/hotels/route.ts` | GET,POST | requireSuperAdminSession | — |
| `src/app/api/super-admin/hotels/suspend/route.ts` | POST | requireAuth,requireSuperAdminSession | — |
| `src/app/api/super-admin/login/route.ts` | POST | delegated/public — review source | — |
| `src/app/api/super-admin/plans/[id]/route.ts` | PUT,DELETE | requireSuperAdminSession | — |
| `src/app/api/super-admin/plans/route.ts` | GET,POST | requireSuperAdminSession | — |
| `src/app/api/super-admin/refunds/[id]/reconcile/route.ts` | POST | requireSuperAdminSession | — |
| `src/app/api/super-admin/refunds/route.ts` | GET,POST | requireSuperAdminSession | — |
| `src/app/api/super-admin/saas-kpis/route.ts` | GET | requireSuperAdminSession | — |
| `src/app/api/super-admin/secret-rotations/route.ts` | GET,POST | requireSuperAdminSession | — |
| `src/app/api/super-admin/security/route.ts` | GET,POST | requireSuperAdminSession | — |
| `src/app/api/super-admin/settings/route.ts` | GET,PUT | requireSuperAdminSession | — |
| `src/app/api/super-admin/stats/route.ts` | GET | requireSuperAdminSession | — |
| `src/app/api/super-admin/subscriptions/action/route.ts` | POST | requireSuperAdminSession | — |
| `src/app/api/super-admin/subscriptions/route.ts` | GET | requireSuperAdminSession | — |
| `src/app/api/super-admin/support/route.ts` | GET,POST | requireSuperAdminSession | — |
| `src/app/api/super-admin/templates/route.ts` | GET,PUT | requireSuperAdminSession | — |
| `src/app/api/super-admin/usage/route.ts` | GET | requireSuperAdminSession | — |
| `src/app/api/tables/[id]/route.ts` | PATCH,DELETE | requireAuth | TABLE_MANAGE |
| `src/app/api/tables/route.ts` | GET,POST | requireAuth | TABLE_MANAGE,TABLE_READ |
| `src/app/api/tax-rules/[id]/route.ts` | PATCH | requireAuth | TAX_MANAGE |
| `src/app/api/tax-rules/route.ts` | GET,POST | requireAuth | BILL_READ,TAX_MANAGE |
| `src/app/api/templates/[id]/route.ts` | PATCH,DELETE | requireAuth | TEMPLATE_MANAGE |
| `src/app/api/templates/route.ts` | GET,POST | requireAuth | TEMPLATE_MANAGE,TEMPLATE_READ |
| `src/app/api/test/mock-emails/route.ts` | GET | delegated/public — review source | — |
| `src/app/api/timeline/route.ts` | GET,POST | requireAuth | CUSTOMER_READ |
| `src/app/api/tracking/webhook/route.ts` | POST | verifyWebhookSignature | — |
| `src/app/api/v1/[...path]/route.ts` |  | authenticateApiKey | — |
| `src/app/api/v1/route.ts` | GET | authenticateApiKey | — |
| `src/app/api/visits/[id]/route.ts` | PATCH,DELETE | requireAuth | VISIT_DELETE,VISIT_UPDATE |
| `src/app/api/visits/route.ts` | GET | requireAuth | VISIT_READ |
| `src/app/api/wallet/pass/[serial]/route.ts` | GET | verifyPassUpdate | — |
| `src/app/api/wallet/passes/[id]/revoke/route.ts` | POST | requireAuth | AI_MANAGE |
| `src/app/api/wallet/passes/route.ts` | GET,POST | requireAuth | AI_MANAGE,AI_READ |
| `src/app/api/webhooks/[id]/replay/route.ts` | POST | requireAuth | WEBHOOK_MANAGE |
| `src/app/api/webhooks/[id]/route.ts` | GET,DELETE | requireAuth | WEBHOOK_MANAGE |
| `src/app/api/webhooks/razorpay-restaurant/route.ts` | POST | delegated/public — review source | — |
| `src/app/api/webhooks/route.ts` | GET,POST | requireAuth | WEBHOOK_MANAGE |
| `src/app/api/webhooks/tracking/route.ts` | POST | verifyWebhookSignature | — |
| `src/app/api/white-label/domain/route.ts` | POST | requireAuth | WHITE_LABEL_MANAGE |
| `src/app/api/white-label/route.ts` | GET,PATCH | requireAuth | WHITE_LABEL_MANAGE |
| `src/app/api/white-label/verify/route.ts` | POST | requireAuth | WHITE_LABEL_MANAGE |
