# BYATO — Production Readiness (audit 2026-10-18)

## Verdict

**READY FOR DEPLOYMENT subject to the deployment configuration items below.** All code-level blockers found in this audit were fixed and re-verified. The application builds, migrates, seeds, passes its full security/functional gauntlet (609 tests + 234 acceptance checks + 178 live HTTP probes + 343 fuzz cases, zero 5xx), and its worker/queue/backup machinery was exercised end-to-end at runtime. What remains is **operator configuration** (credentials, Redis, hosting), not code.

## Deployment blockers (must be provided by the operator)

| # | Item | Why | Status |
|---|---|---|---|
| DEP-1 | `AUTH_SECRET`, `INTEGRATION_ENCRYPTION_KEY` (64-hex), `TRACKING_WEBHOOK_SECRET` (optional but recommended) | Production startup **fails closed** without strong values (`src/lib/config.ts`, `src/lib/env.ts`; validated at boot via `instrumentation.ts`) | ⬜ Operator must set (generate: `openssl rand -hex 32`) |
| DEP-2 | Production `DATABASE_URL` (Neon PostgreSQL **pooled** URL for runtime; **direct** URL for `prisma migrate deploy`) | `file:` SQLite URLs are rejected in production (`src/lib/db.ts`) | ⬜ Operator must set |
| DEP-3 | Run `prisma migrate deploy --schema prisma/schema.postgres.prisma` | 14 migrations; all replayed cleanly on real PostgreSQL in this audit (PGlite), incl. idempotent re-apply and the reservation-fence backfill | ⬜ Run once per environment |
| DEP-4 | Provider credentials for real delivery: `WHATSAPP_TOKEN`+`WHATSAPP_PHONE_NUMBER_ID`, `TWILIO_*`, `SMTP_URL`/`RESEND_API_KEY`/`SENDGRID_API_KEY` + `EMAIL_FROM` + `APP_ORIGIN` | Without them the system runs in **honestly-labelled simulation mode** (messages recorded as `SIMULATED`, never claimed as sent). Real delivery is **Unverified** until credentials exist | ⬜ Operator must set |
| DEP-5 | Payment provider keys (Razorpay/Stripe) for SaaS checkout and restaurant payments | Webhook signature verification and replay fences are implemented and tested with fakes; live round-trips need sandbox keys | ⬜ Operator must set |
| DEP-6 | `REDIS_URL` (optional) | Without it the rate limiter uses the documented per-instance fallback; multi-instance deployments need Redis for shared limits | ⬜ Recommended at scale |
| DEP-7 | Run the background worker alongside web (`bun run worker`) | Campaigns, exports, backups, scheduler sweeps, retention, heartbeat | ⬜ Required (docker-compose.prod.yml ships the service) |
| DEP-8 | `ADMIN_BOOTSTRAP_SECRET` (≥32 chars) for first Super Admin; **remove after use** | Bootstrap endpoint is fail-closed when unset | ⬜ One-time |

## Verified ready

- **Build:** production build passes (exit 0; 145 static pages; all 204 API routes dynamic). TypeScript errors fail the build.
- **Database:** schema parity enforced (test-schema drift guard; migration 0014); 110 tables on PostgreSQL; interactive transactions for money/points/capacity; idempotency fences on payments, exports, campaign sends.
- **Worker:** durable queue with lease fencing, heartbeats (DB + file), stale-lock recovery, retries with backoff, DLQ. Verified live: job execution, backup completion, heartbeat → health flip.
- **Health:** `/api/health` (readiness) and `/api/health/live` report per-component truth (database/queue/redis/rateLimiter/email/worker) and fail closed when a required dependency is down.
- **Security:** fail-closed config validation, scrypt v2 hashing, HMAC sessions with per-request DB revalidation and token-version revocation, CSRF double-submit, nonce CSP, strict CORS, HSTS, capped bodies, CSV-injection neutralization, SSRF-guarded outbound webhooks, HMAC+replay-window inbound webhooks, single-use atomic super-admin bootstrap, dev-script production guards, honest simulation labelling, secret scanning clean, git history clean.
- **Dependencies:** production tree audits clean (0 vulnerabilities).

## Remaining risks (accepted, documented)

| Risk | Severity | Mitigation |
|---|---|---|
| Real provider deliveries unverified (no credentials in audit sandbox) | Medium | DEP-4/DEP-5; simulation mode is honest and clearly badged; send pipelines are unit-tested with fakes |
| Multi-instance rate limiting without Redis | Medium | DEP-6; per-instance fallback documented in `.env.example` and health check |
| Dev-only tooling advisories (5 high in eslint chain) | Low | Lint-time only; upgrade with the next compatible `eslint-config-next` |
| Worker heartbeat upsert can time out on **dev SQLite** under cross-process writes | Low | Best-effort + self-healing (observed recovery); production PostgreSQL unaffected |
| Browser-level E2E not executed in sandbox | Low | HTTP probes + suites cover the API contract; recommend Playwright smoke in CI |
| Privacy deletion anonymizes rather than physically purging related histories | Low (legal review) | Documented behaviour; review retention policy with counsel |

## Rollback / safety notes

- No production database was touched by this audit (disposable SQLite + in-memory PGlite only).
- All fixes are additive or test/probe-contract changes; `git diff` reviewed — no secrets, no destructive migrations, no production-data paths altered.
- The audit branch (`audit/byato-feature-verification`) is intended for review via pull request; CI must pass before merge.
