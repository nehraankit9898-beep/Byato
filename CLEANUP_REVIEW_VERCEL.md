# Byato Repository Cleanup Review — Vercel Primary

Date: 2026-10-18
Branch: `chore/source-cleanup`
Base: `main`

## Scope and safety rules

This pass treats Vercel + Neon PostgreSQL as the primary production deployment.
The cleanup must preserve restaurant workflows, authentication/session handling,
RBAC and tenant isolation, Prisma schemas and migrations, background jobs,
security controls, tests, and the secondary self-hosted Docker deployment path.

No file or dependency is removed solely because its name looks old or because
it is not directly imported by a page. Runtime-loaded modules, scripts,
configuration references, generated-code requirements, and deployment usage
must be checked before removal.

## Findings

- The repository has 916 tracked tree entries at the time of inspection, with
  217 files under `src/app`, 106 under `src/components`, and 98 under
  `src/lib`. These counts are indicators of review scope, not evidence that
  files are unused.
- `package.json` defines both Bun-based test/development workflows and npm
  scripts used by deployment integrations. `bun.lock` and
  `package-lock.json` are both present. Do not delete either until Vercel's
  actual install command and any supported secondary deployment are verified.
- `prisma/schema.postgres.prisma`, the migration history, and database scripts
  are production-critical. Do not remove or regenerate migrations as a cleanup
  shortcut.
- `scripts/worker.ts` and queue/email/provider code are operationally
  significant even when they are not imported by a Next.js page.
- `netlify.toml` is Netlify-specific, but it is retained for compatibility in
  this pass because the request sets Vercel as the *primary* target rather than
  explicitly removing all secondary deployment support.
- The existing `CLEANUP_REPORT.md` records a prior exact-duplicate scan and
  dependency review, including why several dependencies and deployment files
  were retained. This pass does not treat that historical report as fresh
  runtime/test evidence.

## Changes in this pass

- Updated the README production-deployment section to identify Vercel + Neon
  PostgreSQL as the primary path.
- Kept Docker/VPS as a secondary self-hosted path and explicitly documented
  that Netlify configuration is not the primary target.
- No application source, authentication, RBAC, database schema, migration,
  test, dependency, or deployment configuration files were deleted or changed.

## Verification status

- Repository tree and key configuration files inspected through GitHub.
- No local install, lint, typecheck, test suite, production build, Vercel deploy,
  or runtime smoke test was executed by this review.
- CI must run on the proposed branch/PR. A green CI run is still not proof of
  all production integrations (for example, real email/WhatsApp provider
  credentials or scheduled worker execution).
- No claim is made that the application is fully working or production-ready.

## Next safe cleanup gate

Run the repository's CI against this branch. Then use a full local checkout to
perform import/reference analysis and confirm candidates with lint, typecheck,
tests, and production build. Remove only candidates whose lack of runtime,
script, configuration, migration, test, and deployment references is proven.
