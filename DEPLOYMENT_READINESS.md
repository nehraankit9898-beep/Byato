# Deployment readiness — 2026-10-17

**NOT approved as production-ready. No deployment was attempted or verified.**

## Actual targets found
- Docker/Compose on a VPS: PostgreSQL 16, Redis 7, Caddy TLS, separate web/worker/migrate/bootstrap targets; non-root runtime and liveness probes; export/backup shared volumes.
- Netlify: `netlify.toml`, Node 22, @netlify/plugin-nextjs, standard Next output. Netlify configuration comments also discuss hybrid runners; the actual linked site/runtime configuration is unavailable and must be checked by the operator.
- Vercel/Neon deployment documentation exists; no linked production configuration or verified account access was supplied. Persistent worker/storage cannot be assumed on serverless hosting.
- CI includes quality/security, PostgreSQL migration/drift and integration checks, Docker/Compose and Trivy. We corrected the PostgreSQL integration build mode; the actual GitHub workflow was not triggered.

## Build commands
- Standard/Netlify: `npm ci`, `npm run build`; self-hosted standard output starts with `npm start` (0.0.0.0).
- Standalone: `npm run build:standalone`, `npm run start:standalone`.
- Docker: explicit `--target web` / worker / migrate / admin-bootstrap. Last target is not web; do not build without the intended target.
- Engine-free diagnostic client + direct `next build` compiled successfully. This diagnostic artifact is NOT a deployable native-DB verification. Regenerate normally before use.
- Normal `npm run build` fails in this sandbox at blocked native-engine download. Full test harness is blocked for the same reason.

## Variable NAMES still needed (no values collected)
No project `.env` was supplied. Operator must confirm environment presence, not infer production absence from this checkout:
- Core: DATABASE_URL, AUTH_SECRET, INTEGRATION_ENCRYPTION_KEY, APP_ORIGIN.
- Distributed operations: REDIS_URL; Compose provisioning: DATABASE_PASSWORD, POSTGRES_USER, POSTGRES_DB, DOMAIN, ACME_EMAIL.
- One-time bootstrap only: ADMIN_BOOTSTRAP_SECRET; remove/disable after controlled provisioning.
- Email: EMAIL_PROVIDER, EMAIL_FROM and one of SMTP_URL / RESEND_API_KEY / SENDGRID_API_KEY; REQUIRE_EMAIL_VERIFICATION as required by policy.
- Messaging/payment credentials may be encrypted tenant/platform settings rather than global env; configure approved Meta/Twilio/Razorpay/Stripe credentials via the actual provider settings.
- Storage/embedding as required: EXPORT_DIR, BACKUP_DIR, TRUSTED_ORIGINS, EMBED_FRAME_ANCESTORS.
Consult `.env.example`, src/lib/config.ts and src/lib/env.ts for exact validation. Never place actual secrets in these reports.

## Release gates
1. Resolve or explicitly accept AUD-006 tooling advisory under an approved security policy.
2. Restore native engine availability; clean install and rerun full tests and production builds.
3. Disposable PG migrations/drift, native web/worker health, export/download and backup/restore all must pass.
4. Test real staging auth/onboarding, all role denied/allowed paths, tenant isolation, restaurant billing and payment callback idempotency.
5. Verify provider delivery/payment sandboxes, public DNS/TLS, exact CORS/frame origins, upload/persistent storage requirements, worker timeouts and storage retention on the chosen host.
6. Verify alerts, logs/PII handling, health readiness versus liveness, database backups and tested recovery. Never log secrets; keep LOG_PRISMA_QUERIES off in production unless tightly controlled.
7. Operator approves deployment and migrations; then smoke-test production. No such approval/action occurred here.
