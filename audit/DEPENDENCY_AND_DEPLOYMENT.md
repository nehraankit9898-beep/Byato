# Dependency follow-up — 2026-10-18

Evidence and compatibility details: [DEEP_BUG_HUNT_2026-10-18.md](DEEP_BUG_HUNT_2026-10-18.md), `audit/evidence/2026-10-18/`. Next/eslint-config-next 16.4.0 → 16.4.2; reviewed in-range transitive security fixes; synchronized Bun workspace declarations (BUG-18). React/React DOM remain resolved 19.2.3, Sharp 0.35.5, Prisma components 6.19.3. Six October Next advisories stop below 16.3.8, so neither 16.4.0 nor 16.4.2 is in those ranges; Sharp's October advisory is patched by the existing 0.35.5.

Full-tree audit: 26 high → one high (dev-tool braces, no published fix reported). `python3 audit/tools/audit-production-lock.py` audits the actual Bun graph: 265 production-reachable package names, no advisories. `bun install --frozen-lockfile --ignore-scripts` passes with Bun 1.3.14 and 1.4.3. Normal native Prisma postinstall/production build remains blocked by binary-host egress; no deployment success is claimed.

---

# Dependency and deployment — 2026-10-12

`bun install --frozen-lockfile` PASS after installing Bun 1.3.14. `bun run lint` PASS; `bun run scan:secrets` PASS on tracked files. `bun run typecheck` FAIL (16 errors because pinned Prisma 6.19.3 engine download unavailable, generated client missing). Build before repair FAIL Google Fonts; after vendoring Geist 1.7.2 SIL OFL from npm (`src/app/fonts/*`), webpack/Turbopack compile PASS, TypeScript stage FAIL with same 16 errors; NOT a production build PASS. `bun run test` FAIL at disposable DB setup because engine download unavailable. No Docker daemon, PostgreSQL instance, restore target, provider credentials, or browser runtime verified. CI is configured in `.github/workflows/ci.yml`, not run here. No deployment attempted.

`bun audit --audit-level=high`: **26 high** advisories; includes runtime lodash/recharts, nanoid/Next/PostCSS, source-map-js, and dev-tooling dependencies. Result FAIL. The historical `audit/INTEGRATION_AND_DEPLOYMENT_AUDIT.md` reports an earlier `npm audit` zero result; it is not a current scan and does not override this result. Pinpoint compatible remediations and re-run production-only scan before deployment; no arbitrary lockfile upgrade performed.

Config reference: `.env.example` and `docs/ENVIRONMENT.md` list actual variables: `DATABASE_URL` (PostgreSQL production), `AUTH_SECRET`, `INTEGRATION_ENCRYPTION_KEY` required; `REDIS_URL` required operationally for distributed limiter; `APP_ORIGIN`, `EMAIL_PROVIDER`, `SMTP_URL`/`RESEND_API_KEY`/`SENDGRID_API_KEY`, Razorpay tenant integration, `TRACKING_WEBHOOK_SECRET` conditional. Never put secrets in reports. Runtime validation in `src/lib/env.ts` and `src/instrumentation.ts` exists but was not exercised this pass. No secret rotation was performed.
