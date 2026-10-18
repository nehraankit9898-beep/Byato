# Byato RBAC Permission Matrix

Status: **Not yet verified end-to-end.** Role names below are taken from the PostgreSQL Prisma schema; the matrix records the evidence status, not assumed permissions.

| Role | Intended scope from schema comments | Server-side enforcement | Cross-tenant isolation | Status |
|---|---|---|---|---|
| SUPER_ADMIN | Platform-wide administration | Not fully traced | Not tested | Unverified |
| HOTEL_OWNER | Full access to own hotel | Not fully traced | Not tested | Unverified |
| HOTEL_ADMIN | Hotel administration | Not fully traced | Not tested | Unverified |
| HOTEL_MANAGER | Operational + marketing access | Not fully traced | Not tested | Unverified |
| MARKETING_MANAGER | Role exists; exact permissions require code review | Not fully traced | Not tested | Unverified |
| RESTAURANT_MANAGER | Role exists; exact permissions require code review | Not fully traced | Not tested | Unverified |
| FRONT_DESK | Role exists; exact permissions require code review | Not fully traced | Not tested | Unverified |
| HOTEL_STAFF | Role exists; exact permissions require code review | Not fully traced | Not tested | Unverified |
| CASHIER | POS billing view / order payment context (schema comment) | Not fully traced | Not tested | Unverified |
| KITCHEN_STAFF | KDS queue + item availability only (schema comment) | Not fully traced | Not tested | Unverified |
| WAITER | Floor/table overview, order taking, serve (schema comment) | Not fully traced | Not tested | Unverified |
| Customer | Application-specific access not represented in this enum | Not traced | Not tested | Unverified |

## Required verification before marking a permission as enforced
1. Enumerate all API routes and server actions.
2. Trace authentication to a server-derived role and tenant/hotel identifier.
3. Verify every read, update, delete, export and bulk operation scopes its query to authorized tenant ownership.
4. Test allowed and denied cases for each role, including forged IDs and role changes during active sessions.
5. Record test evidence and route/file/line references here.

Do not treat hidden UI links or client-side role checks as authorization.
