# DEPLOYMENT_GUIDE.md — GitHub → Neon → Netlify (verified 2026-10-16)

**Architecture recap:** StayLoop is a full-stack Next.js 16 (App Router) application — server-rendered API routes + Node.js proxy middleware + Prisma 6 + PostgreSQL. It is **not** a static site and must be deployed with Netlify's Next.js runtime (`@netlify/plugin-nextjs`, already declared in `netlify.toml`). The production build command is `npm run build` (= `prisma generate --schema prisma/schema.postgres.prisma && next build`, default output). Docker/VPS deployment remains available via `DEPLOYMENT.md` + `docker-compose.prod.yml`.

---

## 1. Prerequisites

- GitHub account (repo + CI)
- Neon account (PostgreSQL database)
- Netlify account with the Next.js runtime available (standard on current plans; the plugin is configured in `netlify.toml` — no plugin setup needed in the UI, see §5 note)
- Secrets, generated once and stored in a password manager:
  ```bash
  openssl rand -hex 32   # AUTH_SECRET
  openssl rand -hex 32   # INTEGRATION_ENCRYPTION_KEY (64 hex chars)
  openssl rand -hex 32   # ADMIN_BOOTSTRAP_SECRET (optional, unset after first boot)
  ```

## 2. GitHub

1. Push this repository (branch `main`).
2. Enable branch protection on `main`: **require** the `CI` workflow before merge.
3. The CI workflow (`.github/workflows/ci.yml`) on every push/PR:
   - frozen-lockfile install + secret scan + `tsc` + `eslint`,
   - the full integration suite on SQLite (+ Redis service),
   - **applies every migration to a clean PostgreSQL 16 service and enforces an empty `migrate diff`** (the gate is real — it now fails on drift),
   - Docker build + Trivy HIGH/CRITICAL scan + full compose-stack startup, health, export, backup/restore round-trip.

> The migration drift gate previously could not fail (it grepped a human-readable diff). It is fixed in this revision; do not remove the `--script` flag.

## 3. Neon (PostgreSQL)

1. Create a Neon project (region closest to your users). Create the database, e.g. `stayloop`.
2. Copy the **pooled** connection string (Neon Dashboard → Connection Details → *Pooled connection*):
   ```
   postgresql://<user>:<password>@<ep-...-pooler>.<region>.aws.neon.tech/stayloop?sslmode=require
   ```
   The pooled endpoint (`-pooler`) is correct for serverless functions. Prisma + Neon guidance: keep `connection_limit` low (the app's `src/lib/db.ts` does not add pool params for PostgreSQL URLs; Neon's pooler manages this).
3. Apply migrations **once** from any machine with the repo (this is the only destructive-capable step — `migrate deploy` is forward-only and never resets data):
   ```bash
   bun install --frozen-lockfile          # or: npm ci
   export DATABASE_URL="postgresql://…pooler…/stayloop?sslmode=require"
   bunx prisma migrate deploy --schema prisma/schema.postgres.prisma
   ```
   Expected: `14 migrations found → 14 applied` (incl. `0014_schema_drift_parity_fix`, which reconciles older deployments **without data loss** — if your database was migrated with an earlier revision, this step is **required** to fix the franchise/branch runtime errors).
4. Keep the **direct (non-pooled) connection string** handy for future `prisma migrate` operations; use the pooled one for the app runtime.

## 4. Environment Variables (Netlify → Site configuration → Environment variables)

**Required (the deployment refuses to boot without them — by design, fail-closed):**

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon **pooled** connection string (§3.2). Must start with `postgresql://` — a `file:` value is rejected in production. |
| `AUTH_SECRET` | 64-hex-char random string (session-token HMAC key). |
| `INTEGRATION_ENCRYPTION_KEY` | 64-hex-char (32-byte) random string — AES-256-GCM key for integration credentials at rest. |
| `APP_ORIGIN` | `https://<your-domain>` (public origin for verification/reset links and QR URLs; must be https in production). |

**Conditionally required / recommended:**

| Variable | When |
|---|---|
| `EMAIL_PROVIDER` + (`SMTP_URL` or `RESEND_API_KEY` or `SENDGRID_API_KEY`) + `EMAIL_FROM` | Any transactional email (verification, password reset). Required if `REQUIRE_EMAIL_VERIFICATION=true`. |
| `REDIS_URL` | Multi-instance production (distributed rate limiting + queue coordination). Optional for a single instance. |
| `ADMIN_BOOTSTRAP_SECRET` | Only while creating the first Super Admin (§7); unset afterwards. |
| `TRUSTED_ORIGINS`, `EMBED_FRAME_ANCESTORS`, `BOOKING_LINK`, `COST_PER_MESSAGE` | Optional — see `.env.example` for the full annotated list. |

Full variable reference with safe placeholders: **`.env.example`** (never commit real values).

## 5. Netlify

1. **Import** the repository: Netlify → Add new site → Import an existing project → GitHub → select the repo.
2. Build settings are read from `netlify.toml` (command `npm run build`, publish `.next`, `NODE_VERSION=22`, plugin `@netlify/plugin-nextjs`). **Do not** change the build command to a static export and **do not** add `STAYLOOP_STANDALONE=1` (that output mode is for Docker only and breaks the Netlify runtime).
3. Add the environment variables from §4 **before the first deploy** (Site configuration → Environment variables). The build runs `prisma generate` against the PostgreSQL schema itself; no `DATABASE_URL` is needed at build time, but having it set is harmless.
4. Deploy. The first build takes a few minutes (`npm ci` → `prisma generate` → `next build` → function bundling).
5. If a deploy fails with "Failed to install the Next.js runtime plugin" or duplicate-plugin errors: ensure the Next.js plugin is NOT additionally installed in the Netlify UI Plugins tab (the `netlify.toml` `[[plugins]]` entry is the single source of truth).
6. Custom domain: Domain management → add domain → follow DNS instructions. Update `APP_ORIGIN` to the final domain.

### Why a previously deployed site returned HTTP 500 on every route

The app is **fail-closed**: with a missing/weak `AUTH_SECRET` or `INTEGRATION_ENCRYPTION_KEY`, or a non-PostgreSQL `DATABASE_URL`, the instrumentation hook refuses to boot and every request surfaces as 500. The function log shows the exact variable and the fix (`AUTH_SECRET is required in production. Generate one with: openssl rand -hex 32`). Check **Functions → recent invocations** (or `netlify logs --tail`) for that message before anything else. Additionally, deployments whose Neon database was migrated before migration `0014` return 500 specifically on franchise/branch routes — run §3.3 to fix.

## 6. Post-Deploy Smoke Test (10 minutes)

1. `GET https://<domain>/api/health` → expect `200 {"status":"ok","checks":{"database":"ok",…}}` (`worker` may read `unknown` until a worker is deployed — acceptable on day 0).
2. Open `https://<domain>/` → the landing page renders (200).
3. `POST /api/auth/login` with an empty body → expect **400** with a validation message (never 500).
4. Unauthenticated `GET /api/branches` → expect **401**.
5. Sign in as the bootstrapped Super Admin (§7) → dashboard renders; create a hotel; open a QR code → the QR resolves to the menu page.
6. Record a payment twice with the same idempotency key ( cashier view or API `Idempotency-Key` header) → the second response must be `ALREADY_RECORDED`, not a duplicate charge.
7. Response headers on `/` include `Content-Security-Policy` (nonce-based), `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Strict-Transport-Security`.

## 7. First Super Admin (one-time)

```bash
export ADMIN_BOOTSTRAP_SECRET="<the 64-hex secret from §1>"
export DATABASE_URL="<Neon pooled URL>"
bun run bootstrap:admin --name 'Platform Owner' --email owner@example.com
```
Follow the printed activation flow (set password, enable MFA), then **unset `ADMIN_BOOTSTRAP_SECRET`** everywhere it was set.

## 8. Background Worker (only if needed)

Required when using: campaigns > 25 recipients, CSV exports > 5000 rows, scheduled backups, retention sweeps. Deploy the `worker` Docker target (see `DEPLOYMENT_GUIDE` §Worker in `DEPLOYMENT.md` / `docker-compose.prod.yml`) with the same env vars as the web app; it idempotently claims jobs from the shared database. Health of the worker is observable at `/api/super-admin/health` (heartbeat).

## 9. Rollback & Safety

- **Deploy rollback:** Netlify → Deploys → *Published deploy* → rollback (instant, previous functions bundle).
- **Database:** migrations are forward-only. Neon's ** PITR / branch restore** is the database-level rollback; scheduled backups run via the worker (`pg_dump` → AES-256-GCM encrypted archive).
- Never run `prisma migrate reset` or `db push --accept-data-loss` against production.

## 10. Local Development (for completeness)

```bash
bun install --frozen-lockfile
bun run dev:setup   # SQLite dev DB + demo seed (schema via db push)
bun run dev         # auto-generates the SQLite client (scripts/prisma-generate.mjs)
bun run test        # full suite (SQLite, per-file isolation)
```
After `npm run build` (PostgreSQL client), `bun run dev` / `bun run test` automatically regenerate the SQLite client — the "last generate wins" conflict is fixed (see BUG_FIX_REPORT §4).
