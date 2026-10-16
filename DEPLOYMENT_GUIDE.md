# DEPLOYMENT_GUIDE.md — StayLoop (Merged Repository)

**Date:** 2026-10-16

StayLoop is a **full-stack Next.js 16 (App Router) application** requiring a Node.js runtime — Prisma ORM, dynamic API routes (200+), and Node middleware (`src/proxy.ts`). It is **not** a static site and cannot run on Edge/ISR-only hosting. Two production paths are supported:

| Path | Runtime | Database | Guide |
|---|---|---|---|
| **A. Netlify** (from GitHub) | Netlify Hybrid Node servers + `@netlify/plugin-nextjs` | PostgreSQL (Neon recommended) | §2 |
| **B. Docker / VPS** | docker-compose (web + worker + Caddy + PostgreSQL 16 + Redis 7) | PostgreSQL (bundled or external) | §3 (full copy-paste guide: `DEPLOYMENT.md`) |

Local development uses SQLite (§1). The **background worker** (§4) is required for campaigns, CSV exports, scheduled backups, and retention sweeps.

---

## 1. Local Development (SQLite)

```bash
bun install                 # bun 1.3.x; npm install also works for dev
bun run dev:setup           # prisma db push (SQLite schema) + demo seed
bun run dev                 # http://localhost:3000
```

- Dev secrets auto-generate (`.auth-secret.dev`, gitignored). No `.env` needed for local dev.
- Demo data is reproducible via seeding — **never restore a database from an archive** (the merged repo deliberately ships none).
- Run the full test suite: `bun run test` (boots its own throwaway DB + server on :3100; nothing external needed).

## 2. Netlify Deployment (GitHub → Netlify)

### 2.1 Prerequisites

1. **GitHub repo** containing this merged code.
2. **Netlify account** with the **Hybrid Node servers** feature (Netlify Runners) — required because the app needs a Node runtime for Prisma + API routes. (Standard static/edge-only Netlify will not work.)
3. **Neon (or any serverless-friendly PostgreSQL 16) database** — create a project and copy the connection string.
4. Node 22 is pinned by `netlify.toml` (`NODE_VERSION=22` in `[build.environment]`; Next 16 requires ≥ 20.9).

### 2.2 Build configuration (already in `netlify.toml`)

```toml
[build]
  command = "npm run build"        # prisma generate (postgres schema) + next build
  publish = ".next"

[[plugins]]
  package = "@netlify/plugin-nextjs"
```

- The `npm run build` script runs `prisma generate --schema prisma/schema.postgres.prisma && next build` — the Prisma client is generated at build time against the production schema, so no generated client is committed.
- **Do not** set `output: "standalone"` for Netlify — the merged `next.config.ts` makes standalone opt-in via `STAYLOOP_STANDALONE=1`, used only by the Docker path (`build:standalone`). Netlify needs the default output; unconditional standalone output previously broke every Netlify deploy.
- No catch-all rewrites to `/index.html` — API routes must reach the Next runtime untouched (the runtime handles SPA/API pass-through).

### 2.3 Environment variables (Netlify UI → Site settings → Environment variables)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | **yes** | `postgresql://…` (Neon pooled connection string). The production startup **fails closed** if this is not PostgreSQL. Append `?connection_limit=…` per your plan (Neon's pooled endpoint handles serverless fan-out; e.g. `connection_limit=5` for small Starter plans). |
| `AUTH_SECRET` | **yes** | ≥ 32 chars — `openssl rand -hex 32` |
| `INTEGRATION_ENCRYPTION_KEY` | **yes** | 64 hex chars (AES-256-GCM key for stored integration credentials) |
| `APP_ORIGIN` | **yes (recommended)** | Your public origin, e.g. `https://app.stayloop.example` — used for verification/reset links and QR URLs (validated to http/https in this merge). Setting it avoids request-origin QR generation. |
| `TRACKING_WEBHOOK_SECRET` | for webhooks | ≥ 32 chars; webhooks return 503 in production without it |
| `ADMIN_BOOTSTRAP_SECRET` | once | Required only to create the first super admin; leave unset afterwards to disable bootstrap entirely |
| `EMAIL_PROVIDER` / `SMTP_URL` / `RESEND_API_KEY` / `EMAIL_FROM` | for email | See `.env.example` §Phase 7 |
| `REDIS_URL` | recommended | Distributed rate limiting + queue coordination across instances; without it an in-process fallback applies (documented limitation for multi-instance deployments) |
| `FOLLOWUP_ENGINE_SECRET`, `WHATSAPP_*`, `TWILIO_*`, `TRUSTED_ORIGINS`, `EMBED_FRAME_ANCESTORS`, `LOG_LEVEL` | optional | See `.env.example` for the full annotated reference |

**Never** put real secrets in `.env.example` (it contains placeholders only) or commit `.env` (gitignored, verified).

### 2.4 Deploy steps

1. Push the merged repo to GitHub (all branches: `main`).
2. Netlify → **Add new site → Import an existing project** → pick the repo.
3. Build settings are read from `netlify.toml` (no manual override needed).
4. Add the environment variables above (at minimum `DATABASE_URL`, `AUTH_SECRET`, `INTEGRATION_ENCRYPTION_KEY`, `APP_ORIGIN`).
5. **Apply database migrations once** before/with the first deploy (see §5): from a machine with `DATABASE_URL` set to the production database:
   ```bash
   bun install
   bun run db:migrate:deploy   # prisma migrate deploy --schema prisma/schema.postgres.prisma
   ```
   (Or run it as a one-off Netlify job / CI step with the same env.) The migration set includes `0013_bill_payment_idempotency` (restored in this merge) — it is idempotent (`IF NOT EXISTS`) and safe on databases that already applied it.
6. Deploy. Verify: `GET /api/health` returns healthy; create the first super admin via `bun run bootstrap:admin --name '<name>' --email <email>` with `ADMIN_BOOTSTRAP_SECRET` set (one-time, then unset).
7. Recommended: enable branch deploys for staging with a separate Neon database.

### 2.5 What Netlify does and does not run

- Server-rendered pages, all `/api/*` routes, middleware (nonce CSP, security headers) — ✅ via the Next runtime plugin.
- **The background worker is NOT a Netlify feature** — see §4. Without a worker: campaign sends above `INLINE_SEND_THRESHOLD` (25) and CSV exports above `EXPORT_INLINE_MAX_ROWS` (5000) are queued but not processed; scheduled backups/retention sweeps do not run. Options: run the worker container from §3 next to Neon (any small VPS), or a scheduled job platform, or keep audiences below the inline thresholds.

## 3. Docker / VPS Deployment

The repository root contains **`DEPLOYMENT.md` — a verified, copy-paste guide** taking a fresh Ubuntu 22.04/24.04 VPS to a fully running HTTPS installation (Caddy + web + worker + PostgreSQL 16 + Redis 7, with health checks, logs, monitoring, backup/restore and secret rotation references). Use it verbatim. Summary of the stack:

```
caddy (80/443, TLS) → web (Next.js standalone, port 3000)
                      worker (background jobs, backups)
                      migrate (one-shot schema setup)
postgres:16 (internal)   redis:7 (internal)
```

- The image builds **without production secrets** (`bun run build:standalone` inside the Dockerfile; `STAYLOOP_STANDALONE=1` produces `.next/standalone/server.js` — verified in this merge's test run).
- `docker-compose.prod.yml` runs the migration service automatically on startup; `Caddyfile` enforces HSTS, `nosniff`, and CSP-compliant framing.
- Full operational reference (scaling, logging, rollback, non-Docker notes): `docs/DEPLOYMENT.md`.

## 4. The Background Worker (required for full functionality)

`bun run worker` (or the `worker` compose service) executes: campaign/CSV-export jobs (with lease fencing so multiple workers cooperate), scheduled + on-demand backups, token/audit-retention purges, and heartbeat-based health. It validates production configuration before consuming any job and shuts down gracefully. Deploy at least one worker alongside any production web tier (§2.5 / §3).

## 5. Database & Migrations

**Two-schema workflow (by design):**

| Environment | Schema | Mechanism |
|---|---|---|
| Dev / test | `prisma/schema.prisma` (SQLite) | `bun run dev:setup` / the test harness — throwaway files via `prisma db push` |
| Production | `prisma/schema.postgres.prisma` (PostgreSQL, Neon-compatible) | `bun run db:migrate:deploy` (forward-only `prisma migrate deploy`) |

- **Never** run `migrate reset` or `db push --accept-data-loss` against production.
- CI (`.github/workflows/ci.yml`) applies the full migration set to a clean PostgreSQL 16 service and enforces `migrations == schema` (empty `migrate diff`) on every push — the restored `0013` keeps that gate green.
- Both schemas are model-for-model mirrors (the merge preserves the parity fixes: `User.abAssignments` naming and the `FranchiseOrganizationAdmin.user` relation on the Postgres side — relation-field changes with no SQL footprint).
- Connection notes: the Prisma pool is sized explicitly; for Neon use the **pooled** connection string and set a modest `connection_limit` (serverless fan-out is bounded by the Next runtime's concurrent lambdas — see `.env.example` `DATABASE_URL` comment). SSL is enforced by the provider's connection string parameters.
- Backups: worker-executed `pg_dump` with AES encryption; restore via `bun run restore:backup` (see `docs/BACKUP_AND_RESTORE.md`).

## 6. Verification After Deploying

1. `GET /api/health` (liveness) and `GET /api/health?ready=1`-style readiness (DB + queue + worker heartbeat + email policy) return healthy.
2. Super-admin bootstrap done and `ADMIN_BOOTSTRAP_SECRET` unset afterwards.
3. Create a test hotel, staff user, menu item and QR code; scan the QR — it must resolve to `/r/<code>` on your domain.
4. Record a manual bill payment twice with the same idempotency key — the second call must return the same payment (this merge's core guarantee).
5. Check `/api` security headers: nonce CSP present, `X-Content-Type-Options: nosniff`.
6. Confirm the worker heartbeat is fresh if a worker is deployed.

## 7. CI/CD Pipeline (GitHub Actions)

`.github/workflows/ci.yml` runs on every push/PR: frozen bun install, Prisma generation (both schemas), dependency audit (high/critical gate), lint/typecheck, migration parity on PostgreSQL 16 + full integration suite (web + worker + export + backup + restore), Docker build + startup + health + Trivy scans. **Branch protection should require this workflow to pass before production deploys.**

## 8. Rollback

- Netlify: instant rollback to any previous deploy in the UI (build artifacts retained). Migrations are forward-only; the two deploy-blocking migrations in this set (`0012`, `0013`) are additive and non-breaking for previous code (new nullable column + unique index), so an application rollback across them is safe.
- Docker: `docker compose ... up` the previous image tag; database rollbacks follow `docs/DISASTER_RECOVERY.md` (point-in-time restore from encrypted backups).
