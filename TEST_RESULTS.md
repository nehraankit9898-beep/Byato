# Byato Test Results

Date: 2026-10-18  
Status: **Not executed in this audit pass.**

| Check | Command / evidence needed | Result |
|---|---|---|
| Install | `bun install --frozen-lockfile` in clean checkout | Not run |
| TypeScript | `bun run typecheck` | Not run |
| Lint | `bun run lint` | Not run |
| Automated tests | `bun run test` | Not run |
| Prisma SQLite validation | `bunx prisma validate --schema prisma/schema.prisma` | Not run |
| Prisma PostgreSQL validation | `bunx prisma validate --schema prisma/schema.postgres.prisma` | Not run |
| Production build | `bun run build` with isolated test configuration | Not run |
| CI | GitHub Actions run status for the audit commit/PR | Not checked |
| RBAC/tenant tests | isolated fixtures for each role and cross-tenant IDs | Not run |

Do not infer a pass from scripts existing in the repository. Execute checks in a clean local/CI environment. Never point destructive test commands at production. Record exact exit codes, logs with secrets redacted, and commit SHA after execution.
