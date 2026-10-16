# BUG_FIX_REPORT.md — StayLoop Full Bug-Fix & Production-Readiness Pass

**Date:** 2026-10-16 · **Input:** `stayloop-merged.zip` · **Method:** reproduce → diagnose from evidence → fix root cause → re-verify (no symptom-masking, no feature removal).

---

## 1. Executive Summary

The merged repository was re-audited end to end. Three **critical, reproducible bugs** were found and fixed:

| # | Bug | Impact | Status |
|---|-----|--------|--------|
| 1 | **Prisma schema ↔ migration drift** — `BranchMembership.orgId` in migrations vs `franchiseOrganizationId` in schema/code, missing unique index on `Reservation.publicToken`, 20 FK constraints with wrong referential actions, 3 index discrepancies | **Production HTTP 500** on franchise/branch routes on any Neon database deployed with `prisma migrate deploy` (Prisma P2021/P2022 at runtime); no uniqueness fence on reservation tokens | **FIXED** — migration `0014_schema_drift_parity_fix` (data-preserving, idempotent); drift now verifiably **empty** |
| 2 | **CI migration-drift gate could never fail** — `migrate diff` ran without `--script`, so the gate grepped for SQL keywords in a human-readable summary | Real drift (bug #1) shipped to production because the designed safety gate was structurally blind | **FIXED** — `.github/workflows/ci.yml` now diffs with `--script` and fails on any DDL |
| 3 | **"Last generate wins" Prisma client conflict** — both schemas generate into `node_modules/@prisma/client`; after the Netlify `build` script (PostgreSQL client) any dev/test run with SQLite `DATABASE_URL` fails | Reproduced: `PrismaClientInitializationError: the URL must start with the protocol postgresql://` in `scripts/seed.ts` — the whole test/CI harness breaks after every build | **FIXED** — `scripts/prisma-generate.mjs` picks the schema from the `DATABASE_URL` protocol; wired into `postinstall`, `dev`, and the test harness |

Additionally, two duplicate-code consolidations were made (see `CLEANUP_REPORT.md`), and the **complete verification matrix** (41/41 test files, 234 acceptance assertions, production build, production boot against a real PostgreSQL 16/18 database, migration parity, fail-closed configuration gates) now passes — see `TEST_REPORT.md`.

---

## 2. Bug #1 (CRITICAL) — Schema ↔ Migration Drift

### 2.1 Symptom & Discovery

The prior merge reports claimed "migrations match schema (empty diff)". Re-running the check **with the `--script` flag** (the only mode that emits SQL) against a live PostgreSQL database proved the claim false — `prisma migrate diff` produced **145 lines of DDL**:

```
ALTER TABLE "BranchMembership" DROP COLUMN "orgId",
ADD COLUMN     "franchiseOrganizationId" TEXT;          ← destructive as generated
CREATE UNIQUE INDEX "Reservation_publicToken_key" …     ← missing in every deployed DB
… 20 DROP CONSTRAINT + 17 ADD CONSTRAINT (FK actions) …
```

### 2.2 Root Cause

Migrations `0004`–`0010` were **hand-written SQL** that drifted from `schema.postgres.prisma` in six ways:

1. **Column name** — migration `0009_phase17_enterprise` line 165 added `"orgId"` to `BranchMembership`; the schema (and `src/lib/franchise.ts:120,124`) use `franchiseOrganizationId`. Dev/test never noticed because they use `prisma db push` (schema-direct), which creates the correct column. **Production** (`migrate deploy`) got the wrong one.
2. **Missing unique index** — `Reservation.publicToken` is `@unique` in the schema (line 2412); migration `0007` created the column with no unique index.
3. **Missing indexes** — `ABExperiment_active_idx`, `WhiteLabelConfig_customDomain_idx` never created.
4. **Extra index** — `Campaign_messageTemplateId_idx` exists in migration `0004` but not in the schema.
5. **FK referential actions** — 20 constraints were created with `ON DELETE …` only; the schema also requires `ON UPDATE CASCADE` (Prisma default). Same constraint names → invisible until diffed, and permanently blocking a clean `migrate dev` baseline.
6. **Identifier truncation** — migration `0005` created `JourneyStepDelivery_…_occurrenceKey_key` (64 chars) which PostgreSQL truncates to `…_ke`; Prisma's own truncation is `…_occurrenceKe_key`.

### 2.3 Production Impact (why this caused HTTP 500)

On any PostgreSQL database deployed via `prisma migrate deploy` (the documented Neon path):

- Every franchise/branch query through the Prisma client (which is generated from the schema and knows `franchiseOrganizationId`) fails at runtime with **P2021/P2022 "column does not exist"** → `serverError()` → **HTTP 500** on `/api/branches`, franchise listing, and branch-add flows. This was reproduced by inspection of the deployed schema (`stayloop_prod`): the column in the database was `orgId`.
- No database-level uniqueness on `Reservation.publicToken` (relied upon by future public-tracking flows; `upsert`s by that key would fail with "no unique or exclusion constraint matching the ON CONFLICT specification").

### 2.4 Fix — `prisma/migrations/0014_schema_drift_parity_fix/migration.sql`

A **safe, forward-only, data-preserving** reconciliation migration:

- `RENAME COLUMN "orgId" TO "franchiseOrganizationId"` (guarded by an `information_schema` probe — **no data is ever dropped**; the drift-generated `DROP COLUMN` was deliberately NOT used).
- `CREATE UNIQUE INDEX IF NOT EXISTS "Reservation_publicToken_key"`, `ABExperiment_active_idx`, `WhiteLabelConfig_customDomain_idx`.
- `DROP INDEX IF EXISTS "Campaign_messageTemplateId_idx"`.
- `ALTER INDEX IF EXISTS … RENAME` for the truncated JourneyStepDelivery name.
- Drop + re-add the 20 FK constraints with the schema's exact `ON DELETE … ON UPDATE` actions, each inside a `DO $$ … EXCEPTION WHEN duplicate_object THEN NULL $$` block.
- **Every statement is idempotent** (`IF EXISTS` / `IF NOT EXISTS` / guarded DO blocks) — verified by re-running the full SQL against an already-migrated database (no errors).

### 2.5 Verification (all executed, all passed)

| Check | Command | Result |
|---|---|---|
| Apply to drifted DB (0001–0013 applied) | `prisma migrate deploy` vs PG 18 | 14/14 applied |
| Drift after fix | `prisma migrate diff --from-migrations --to-schema-datamodel --script` | **empty** ("This is an empty migration.") |
| Fresh-DB path (new Neon scenario) | fresh database → `migrate deploy` | 14/14 applied; column is `franchiseOrganizationId`; correct indexes present; FK actions `del=n,upd=c` / `del=r,upd=c` verified via `pg_constraint` |
| Idempotency | re-execute 0014 SQL directly | no errors |
| Production runtime | `next start` vs migrated PG + `/api/health` | `{"status":"ok","database":"ok"}` |

---

## 3. Bug #2 (HIGH) — CI Drift Gate That Could Never Fail

### 3.1 Root Cause

`.github/workflows/ci.yml` ran:

```yaml
bunx prisma migrate diff --from-migrations … --to-schema-datamodel … > /tmp/drift.sql
if [ -s /tmp/drift.sql ] && grep -qE "^(CREATE|ALTER|DROP)" /tmp/drift.sql; then exit 1; fi
```

Without `--script`, `prisma migrate diff` prints a **human-readable summary** (`[*] Changed the X table / [-] Removed foreign key…`) — never a line starting with `CREATE`/`ALTER`/`DROP`. The gate was **structurally incapable of failing**, which is exactly why bug #1 reached production despite CI being "green". (This is the same class of defect as the old `migrate diff || true` the workflow itself claims to have fixed.)

### 3.2 Fix

`--script` added (emits executable SQL; an empty diff prints only `-- This is an empty migration.`), and the grep widened to `^(CREATE|ALTER|DROP|GRANT|REVOKE|COMMENT)` with the `[ -s ]` short-circuit removed. Verified against the real drift: the fixed gate **fails** on the pre-0014 migrations and **passes** with 0014 present.

---

## 4. Bug #3 (HIGH) — "Last Generate Wins" Prisma Client Conflict

### 4.1 Reproduction (evidence, not assumption)

`npm run build` (the Netlify command) generates the **PostgreSQL** client. Immediately afterwards `bun run test` failed:

```
PrismaClientInitializationError:
Invalid `db.auditLog.deleteMany()` invocation in scripts/seed.ts:39
error: Error validating datasource `db`: the URL must start with the protocol `postgresql://` or `postgres://`.
```

Both `prisma/schema.prisma` (SQLite, dev/test) and `prisma/schema.postgres.prisma` (PostgreSQL, production) use the default generator output — one overwrites the other. The schema files even carry a comment acknowledging the hazard and requiring a **manual** regeneration step — a foot-gun the automated paths kept stepping on.

### 4.2 Fix

- **New `scripts/prisma-generate.mjs`** — picks the schema from the `DATABASE_URL` protocol (`postgres://`|`postgresql://` → PostgreSQL schema; anything else → SQLite dev schema) and generates the matching client.
- Wired into:
  - `package.json` → `postinstall` (fresh clones, CI, Netlify `npm ci`),
  - `package.json` → `dev` (dev server always boots with the correct client),
  - `scripts/run-tests.ts` → explicit generation step before `db push`/seed,
  - `package.json` → `db:generate` (now the smart script).
- The Netlify `build` script stays explicit (`prisma generate --schema prisma/schema.postgres.prisma && next build`) — the authoritative production path — and the Dockerfile's explicit generate step is unaffected.

### 4.3 Verification

- `bun run test` after `npm run build`: **41/41 files pass** (previously failed in seed).
- `DATABASE_URL="" node scripts/prisma-generate.mjs` → SQLite client; with a `postgresql://` URL → PostgreSQL client (both observed via generate output).
- `npm ci --dry-run` (lockfile/scripts consistency): passes.

---

## 5. The Netlify HTTP 500 — Complete Root-Cause Picture

The build itself is healthy (`npm run build` → exit 0, default output, all routes dynamic, proxy/middleware on the Node.js runtime — see `functions-config-manifest.json`). The all-routes-500 symptom has exactly three verified contributors, in order of likelihood:

| Cause | Evidence | Resolution |
|---|---|---|
| **(a) Runtime environment misconfiguration** — missing/weak `AUTH_SECRET` / `INTEGRATION_ENCRYPTION_KEY`, or a `file:`/missing `DATABASE_URL` in production | Reproduced: booting with `NODE_ENV=production` and no `AUTH_SECRET` logs `StayLoop configuration is invalid: AUTH_SECRET is required in production. Generate one with: openssl rand -hex 32` and refuses to serve — every request 500s on Netlify. **This is by design (fail-closed) — the fix is configuration, not code.** | Exact required variables + where to set them: `DEPLOYMENT_GUIDE.md` §3–4. The error is loud and actionable in Netlify function logs. |
| **(b) Schema drift (Bug #1)** — franchise/branch routes 500 on Neon databases migrated with the pre-0014 migrations | 145-line drift SQL reproduced against a live PG database | Migration `0014` (above). **Any existing Neon database must run `prisma migrate deploy` once more** — forward-only, data-preserving. |
| **(c) Legacy `output: "standalone"`** — broke every Netlify deploy before the merge | Already fixed in the merged tree (conditional `STAYLOOP_STANDALONE=1`); re-verified: default output for Netlify, standalone still works for Docker (`build:standalone`) | No action. Re-verified in this pass. |

**Not causes** (verified): Next.js 16.4 + `@netlify/plugin-nextjs` 5.16.2 is a supported combination (Netlify announced Next.js 16 support Oct 2025); `NODE_VERSION=22` pin is correct for Next 16; Prisma + Neon serverless functions work with the pooled connection string; `sharp` is a regular dependency; the proxy middleware runs on the Node.js runtime (no Edge/Buffer issues — `functions-config-manifest.json` shows `"/_middleware": {"runtime": "nodejs"}`).

**Live-deploy verification is BLOCKED** from this environment (no Netlify account/credentials). Exact manual smoke-test steps: `DEPLOYMENT_GUIDE.md` §6.

---

## 6. Fix List (complete diff summary)

| File | Change | Type |
|---|---|---|
| `prisma/migrations/0014_schema_drift_parity_fix/migration.sql` | **new** — data-preserving drift reconciliation (Bug #1) | migration |
| `.github/workflows/ci.yml` | `migrate diff` gate uses `--script`; grep widened (Bug #2) | CI fix |
| `scripts/prisma-generate.mjs` | **new** — environment-aware client generation (Bug #3) | build fix |
| `package.json` | `postinstall` + `dev` + `db:generate` wired to the smart generator (Bug #3) | build fix |
| `scripts/run-tests.ts` | explicit client-generation step before `db push` (Bug #3) | test-infra fix |
| `src/lib/auth.ts` | `CSRF_COOKIE` re-exported from `lib/csrf.ts` (single definition) | cleanup |
| `src/lib/scoring.ts` | `tierForScore`/`TIER_LABELS` consolidated into `lib/lead-scoring.ts` (re-exported) | cleanup |

No application behavior was changed by the cleanup edits (identical constants/thresholds — verified by `tsc`, `eslint`, and the full test suite). No files were deleted. No dependencies were added, removed, or upgraded. No existing migration was edited.

---

## 7. Verification Matrix (executed in this pass — details in TEST_REPORT.md)

| Verification | Result |
|---|---|
| `bun install --frozen-lockfile` (560 packages) | ✅ PASS |
| `npm ci --dry-run` (Netlify install path consistency) | ✅ PASS |
| `tsc --noEmit` | ✅ 0 errors (before **and** after changes) |
| `eslint .` | ✅ 0 errors (before **and** after changes) |
| `prisma validate` — SQLite + PostgreSQL schemas | ✅ both valid |
| `prisma migrate deploy` vs real PostgreSQL (18.x, embedded) — 14 migrations, existing + fresh DB | ✅ 14/14, data-preserving |
| `prisma migrate diff --script` (migrations ↔ schema) | ✅ **empty** after 0014 |
| Migration idempotency (re-run 0014 SQL) | ✅ no errors |
| Full integration suite — 41 files / ~482 assertions | ✅ 41/41 files, 0 failures |
| Acceptance suites — phase1 / phase2 / phase63 | ✅ 93/0 · 79/0 · 62/0 |
| Production build (`npm run build`, the Netlify command) | ✅ exit 0, default output |
| Production boot vs real PostgreSQL + health/auth/CSRF/security-header probes | ✅ health `ok`, DB `ok`, 4xx (not 500) on bad input/unauth, headers present |
| Fail-closed configuration gate (missing `AUTH_SECRET`) | ✅ refuses to boot with actionable message |
| Payment idempotency suite (`phase14-billing`) | ✅ 22/22 (replay, 422 conflict, concurrent P2002, partial refunds) |
| QR injection suite | ✅ 16/16 |
| Tenant isolation / RBAC suites | ✅ all pass |
| Live Netlify deploy, live Neon, live Razorpay/Twilio/SMTP | ⛔ **BLOCKED** (no credentials) — manual steps in DEPLOYMENT_GUIDE.md §6 |

---

## 8. Remaining Blockers to "Production-Ready"

1. **Apply migration 0014 to the production Neon database** (`bunx prisma migrate deploy --schema prisma/schema.postgres.prisma` with the production `DATABASE_URL`) — forward-only and data-preserving; no manual SQL needed.
2. **Set the production environment variables in Netlify** (`DATABASE_URL` Neon pooled, `AUTH_SECRET`, `INTEGRATION_ENCRYPTION_KEY`, `APP_ORIGIN`, …) — see DEPLOYMENT_GUIDE.md §4. Without them the app **intentionally** refuses to serve (fail-closed).
3. **Netlify account capability** — the app is a full-stack Node server (Prisma + Node proxy). Standard static/edge-only Netlify cannot run it; Hybrid Web Runtime / Next.js runtime must be available for the site (the `@netlify/plugin-nextjs` plugin in `netlify.toml` handles this automatically on current Netlify plans).
4. **One background worker** (`scripts/worker.ts` via the Docker `worker` target or any scheduled-job host) if campaigns > 25 recipients, CSV exports > 5000 rows, scheduled backups, or retention sweeps are used.
5. **Optional hardening:** set `REDIS_URL` when running more than one instance (rate limiting/queue coordination are per-instance without it); set `APP_ORIGIN` so QR codes and email links always embed the public origin.

With 1–3 done and the smoke test in DEPLOYMENT_GUIDE.md §6 passing, the deployment is production-ready per the checks that can be executed without external credentials.
