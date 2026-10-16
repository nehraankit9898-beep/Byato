# StayLoop on Vercel + Neon PostgreSQL — deployment runbook

This runbook describes how to deploy the existing Next.js 16 app to **Vercel**
with **Neon PostgreSQL**, and how to bootstrap the first Super Admin safely.
Nothing in this document contains a secret value. Set every secret in the
platform dashboards or in your local shell, never in the repository.

> The repository also contains `netlify.toml` and Netlify-era guides
> (`DEPLOYMENT_GUIDE.md`, `docs/DEPLOYMENT.md`). They are **not used** when the
> project is deployed on Vercel and can be ignored for this target.

## 1. Vercel project settings

| Setting          | Value                                                                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository       | `nehraankit9898-beep/Byato`                                                                                                                                                                                      |
| Production branch | `main` (merge reviewed PRs only)                                                                                                                                                                                 |
| Framework        | Next.js (auto-detected)                                                                                                                                                                                          |
| Root directory   | repository root                                                                                                                                                                                                  |
| Node.js          | 22.x                                                                                                                                                                                                             |
| Install command  | `npm ci` (recommended, so the install is driven by `package-lock.json`. The repo also has `bun.lock`; keep both in sync when dependencies change)                                                                |
| Build command    | `npm run build` (runs `prisma generate --schema prisma/schema.postgres.prisma` and then `next build`)                                                                                                             |
| Output directory | default Next.js output. Do **not** set `STAYLOOP_STANDALONE=1` (that is for the Docker image only)                                                                                                               |

**Background worker:** StayLoop's queue (large campaigns, exports, backups,
scheduled journeys) runs in a separate long-lived process, `npm run worker`
(see `scripts/worker.ts` and `docker-compose.prod.yml`). A Vercel deployment
serves the web app only. Until the worker runs somewhere else, background jobs
do not execute, and `GET /api/health` reports the worker as not ready. Plan the
worker host before going live.

## 2. Environment variables

Set each variable separately for **Production** and **Preview** in
Vercel → Project → Settings → Environment Variables.

**Preview deployments run with `NODE_ENV=production`**, so every production
check applies to them. Preview must therefore use its own (non-production)
database. Never point Preview at the production Neon database.

| Variable | Production | Preview | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | required | required (a Neon **branch**, not production) | Runtime connection. Use the **pooled** Neon URL. See §3. |
| `AUTH_SECRET` | required | required | ≥ 32 chars, random (`openssl rand -hex 32`). Startup fails if missing or weak. |
| `INTEGRATION_ENCRYPTION_KEY` | required | required | 64 hex chars (32 bytes). Startup fails if missing or weak. |
| `TRACKING_WEBHOOK_SECRET` | optional | optional | ≥ 32 chars when set. |
| `APP_ORIGIN` | required | recommended | Public `https://` origin. Required when `REQUIRE_EMAIL_VERIFICATION=true`. |
| `ADMIN_BOOTSTRAP_SECRET` | **only while bootstrapping**, then remove | do not set | ≥ 32 chars, random. See §4. |
| `REDIS_URL` | recommended | optional | Shared rate limits across serverless instances. Without it, limits are per instance. |
| `EMAIL_PROVIDER` + `SMTP_URL` / `RESEND_API_KEY` / `SENDGRID_API_KEY` + `EMAIL_FROM` | recommended | optional | `mock` is rejected in production. |
| `STAYLOOP_TEST`, `NODE_ENV=test` | **never** | **never** | Startup fails if they are set in production. |

Startup validation (`src/instrumentation.ts` → `src/lib/env.ts`) refuses to
start a production deployment when `DATABASE_URL` is missing, is not a
`postgres(ql)://` URL, or is a SQLite `file:` URL. Its error text names the
variable but never prints its value.

## 3. Database URLs: which variable each operation needs

Neon provides two connection strings per branch: a **pooled** host (contains
`-pooler`) and a **direct** host (no `-pooler`).

| Operation | URL to use | How |
| --- | --- | --- |
| Runtime (Vercel functions) | Pooled | Vercel `DATABASE_URL`: `postgresql://…@ep-…-pooler…/neondb?sslmode=require&pgbouncer=true&connection_limit=1` |
| `prisma migrate deploy` (schema changes) | **Direct** | Run from your workstation or CI, passing the direct URL for that command only: `DATABASE_URL='<direct URL>' npm run db:migrate:deploy` |
| Worker process (if deployed) | Pooled, same as runtime | Its own `DATABASE_URL` |
| `db:push`, `db:push:force`, `db:reset`, `seed*`, `cleanup` | **Never against production** | Local SQLite only. The seed and dev scripts refuse PostgreSQL URLs (`scripts/dev-only-guard.ts`). |

Why two URLs: the Neon pooler runs PgBouncer in transaction mode, which
Prisma's migration engine does not support. `pgbouncer=true` is for the runtime
URL only. The schema has no `directUrl` setting, so the direct URL is supplied
as an explicit override for the migration command.

Before applying a migration to production:

1. Take a Neon branch snapshot or a `pg_dump` (see `docs/BACKUP_AND_RESTORE.md`).
2. Review `prisma/migrations/` for the new migration.
3. Run `npm run db:migrate:deploy` with the direct URL, as shown above.
4. Confirm `GET /api/health` returns ready.

## 4. First Super Admin (bootstrap)

The first Super Admin is created once, by calling the endpoint with a secret.
Bootstrap is fail-closed. It works only while `ADMIN_BOOTSTRAP_SECRET` is set to
a strong value and no Super Admin exists yet.

1. Generate a secret and keep it in a password manager: `openssl rand -hex 32`.
2. In Vercel → **Production** environment, add `ADMIN_BOOTSTRAP_SECRET` with that value. Then **redeploy**. Environment changes apply only to new deployments.
3. Call the **production** domain, with the secret in the header and not in the URL or body. Export the secret in your local shell only:

   ```bash
   curl -sS -X POST "https://<your-production-domain>/api/super-admin/bootstrap" \
     -H "Content-Type: application/json" \
     -H "x-bootstrap-secret: $ADMIN_BOOTSTRAP_SECRET" \
     -d '{"name":"Platform Admin","email":"nehraankit9898@gmail.com"}'
   ```

4. A `201` response contains `temporaryPassword` once. Copy it into your password manager and sign in at the Super Admin login. The platform forces a password change at first sign-in.
5. Remove `ADMIN_BOOTSTRAP_SECRET` from Vercel **Production** and redeploy. Afterwards the endpoint returns `403 BOOTSTRAP_DISABLED`. While the secret is still set, a repeat call returns `409 ALREADY_BOOTSTRAPPED`.

### Reading a bootstrap response

| HTTP | `error.code` | Meaning and fix |
| --- | --- | --- |
| 201 | — | Super Admin created. Save the one-time password. |
| 401 | `UNAUTHORIZED`, "Missing x-bootstrap-secret header" | The request did not send the header. Send the secret in the `x-bootstrap-secret` header, not in the body or an `Authorization` header. |
| 401 | `UNAUTHORIZED`, "Invalid bootstrap secret." | The header was sent but does not equal the **Production** value of `ADMIN_BOOTSTRAP_SECRET`. Check that you call the production domain, that the value was copied exactly, and that the deployment was redeployed after the variable was set. |
| 401 | (HTML page or Vercel's own error body) | Vercel Deployment Protection is intercepting the request before the app runs. Use the production domain, or configure protection bypass for automation. |
| 403 | `BOOTSTRAP_DISABLED` | `ADMIN_BOOTSTRAP_SECRET` is not set on this deployment. Set it in Production and redeploy. |
| 500 | `BOOTSTRAP_MISCONFIGURED` | The value is shorter than 32 characters, or it is a placeholder. Replace it with `openssl rand -hex 32` and redeploy. |
| 409 | `ALREADY_BOOTSTRAPPED` / `EMAIL_IN_USE` | A Super Admin already exists, or the email is taken. Bootstrap will not run again. |
| 429 | `RATE_LIMITED` | More than 5 attempts per minute from one IP. Wait a minute. |
| 500 | `INTERNAL` | Server error. The details are only in the Vercel function logs. |

## 5. Post-deploy verification

- `GET https://<domain>/` returns 200 and the login screen.
- `GET https://<domain>/api/health` returns 200 when the database and required services are ready. It returns 503 when the worker is not running (see §1).
- Super Admin signs in, is forced to change the password, and then reaches the Super Admin dashboard.
- A hotel owner account can sign in and sees only its own hotel's data.
- Vercel → Deployments → (latest) → Logs show no `[config]` / `StayLoop configuration is invalid` startup errors.
