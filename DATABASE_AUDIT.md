# Database audit — 2026-10-17

## Discovery
- Prisma CLI/client 6.19.3; `prisma/schema.prisma` is SQLite (development/test), `prisma/schema.postgres.prisma` PostgreSQL (production).
- Both have 110 model definitions. A normalized comparison ignoring comments, whitespace and field ordering finds identical model fields/constraints; Hotel differs only in field order/comments. This does not prove physical database parity.
- Fourteen checked-in SQL migrations, `0001_init` through `0014_schema_drift_parity_fix`; migration lock selects PostgreSQL.
- Models cover tenant/user/auth tokens, CRM/visits/consent, marketing and deliveries, loyalty, SaaS billing, restaurant menu/orders/GST payments, operations, enterprise and AI records.
- `src/lib/db.ts` is a process singleton with SQLite URL normalization and single-connection dev pool. Production rejects file URLs. Both schemas share one generated client output: the last generation wins. Existing test harness regenerates SQLite; production scripts generate PostgreSQL.
- `src/lib/super-admin.ts` uses a persistent one-shot bootstrap claim. Activation/security tokens use conditional single-use mutation. Payments/orders/queue have explicit idempotency guards and transaction paths; existing payment boundary tests passed, but actual DB isolation/rollback was not tested here.

## Checks and changes
- Both schemas pass Prisma's schema validation (exit 0) using the installed WASM validation path with binary-path overrides. No binary was executed as a database engine.
- Engine-free PostgreSQL client generation and production TypeScript/Next compilation pass.
- No schema/migration edits were needed for these fixes. MFA confirmation and OTP changes tighten existing conditional updates only.
- `0014` contains FK re-creation and existing drift reconciliation. Its historical comments are not evidence that it has been applied to any deployment.

## Not verified / blocked
Native engine downloads are blocked at binaries.prisma.sh. No PostgreSQL server/client or Docker executable was available in PATH. The full SQLite harness stops at generation. Therefore migrations on a disposable PostgreSQL instance, migration/schema diff, upgrade compatibility, rollback, backup/restore, query plans, pool sizing under load, N+1 behavior and live database connectivity remain NOT VERIFIED. Schema validity is not connectivity.

## Safe next checks
On an authorized disposable PostgreSQL 16 + Redis instance, generate the native PostgreSQL client; run migrate deploy with the explicit production schema; diff migrations against that schema using a separate shadow DB; run scripts/test-pg-integration.ts after build:standalone. Exercise the new MFA/OTP interleavings against PostgreSQL. Test encrypted backup restoration into another disposable database. Do not reset or push schemas against production. Back up before operator-approved migrations; use a reviewed forward-fix for migration failures.
