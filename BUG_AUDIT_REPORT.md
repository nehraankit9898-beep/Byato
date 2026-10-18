# Byato Bug Audit Report (Evidence-based, preliminary)

- Repository: `nehraankit9898-beep/Byato`
- Branch audited: `main` (snapshot inspected 2026-10-18)
- Scope status: **PRELIMINARY — not a complete repository audit**
- Execution status: GitHub source inspection only; no local checkout, runtime, database, or CI execution was performed in this audit pass.
- Safety: no production data, credentials, or accounts were modified.

## Confirmed observations

### BYA-OPS-001 — Destructive database commands are exposed as ordinary package scripts
- Category: Operations / Data integrity
- Severity: **Medium (risk; exploitability depends on operator environment)**
- Evidence: `package.json` defines `db:push:force` as `prisma db push --accept-data-loss` and `db:reset` as `prisma migrate reset --schema prisma/schema.postgres.prisma`.
- Reproduction: inspect `scripts` in package.json; an operator can run these commands while production database environment variables are set.
- Expected: destructive commands should require an explicit safe environment/confirmation and deployment guidance should clearly prohibit production use.
- Actual: command aliases directly invoke data-loss-capable Prisma operations; no safety guard is visible in these package scripts.
- Impact: accidental schema/data loss if run with production credentials.
- Recommendation: add a wrapper that refuses production and requires explicit confirmation; keep production migration deploy separate. Do not run either destructive command against production.
- Regression test: run wrapper tests with NODE_ENV=production and a PostgreSQL DATABASE_URL; assert refusal before Prisma is invoked.
- Owner: DevOps / Database.

### BYA-OPS-002 — Prisma SQLite and PostgreSQL schemas share the default generated-client output
- Category: Build / Developer experience
- Severity: **Low (workflow risk; not by itself a production vulnerability)**
- Evidence: `prisma/schema.prisma` and `prisma/schema.postgres.prisma` both declare `generator client { provider = "prisma-client-js" }` without distinct output paths. Both schema comments explicitly note that the last generation overwrites the other generated client. CI explicitly generates the SQLite client for tests; package build explicitly generates PostgreSQL client.
- Expected: scripts should make schema/client selection deterministic for every command and document when generation is required.
- Actual: correctness depends on which schema was generated most recently; mixing local test/dev and production build commands can leave a mismatched generated client.
- Impact: local runtime/test failures or confusing schema-specific errors.
- Recommendation: evaluate separate generator output paths or enforce schema-specific generation in every script; verify compatibility before changing generated-client paths.
- Regression test: clean install followed by dev/test and production build in both orders; verify each uses the intended provider.
- Owner: Backend / DevOps.

## Areas not yet verified
- Full API/server-action authorization and tenant isolation
- Role-to-permission enforcement for every role
- Authentication, session revocation, password reset and bootstrap endpoint behavior
- Every API request/response contract and state transition
- XSS/CSRF/SSRF/CORS/upload/payment security
- All Prisma models, migrations, indexes, constraints and tenant ownership
- UI interactions, responsive behavior, accessibility and hydration
- Full dependency tree, production build, automated tests and deployment health

No issue in these areas should be interpreted as confirmed safe or confirmed vulnerable without additional inspection and tests.

## Evidence reviewed
- `package.json`
- `README.md`
- `prisma/schema.prisma`
- `prisma/schema.postgres.prisma`
- `src/lib/auth.ts` (partial)
- `src/lib/config.ts` (partial)
- `src/lib/db.ts` (partial)
- `src/proxy.ts` (partial)
- `src/instrumentation.ts`
- `scripts/bootstrap-admin.ts` (partial)
- `scripts/run-tests.ts` (partial)
- `.github/workflows/ci.yml` (partial)
- `.env.example` (partial)

## Release recommendation
**Not certified for production by this preliminary review.** This is not a finding that the app is definitely unsafe; it means full code-path review and executable verification have not been completed. Do not claim all bugs are fixed based on this report.
