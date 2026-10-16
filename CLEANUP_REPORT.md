# CLEANUP_REPORT.md — Deduplication, Consolidation & Removal Log

**Date:** 2026-10-16
**Scope:** the merged StayLoop repository.
**Principle applied:** *no deletion based on absence of grep matches alone* — every removal or consolidation below was verified against the full reference graph (imports, test registration, build scripts, Prisma requirements, deployment files, and the CI pipeline) before execution.

---

## 1. Files Removed

| File | Why removed | Safety verification |
|---|---|---|
| `prisma/db/custom.db` (from the original repo) | 2.2 MB stale demo SQLite database committed to VCS. Contains 3 seed accounts with **known passwords**. Demo data is reproducible via `bun run seed`. Never restored into the merge. | `.gitignore` covers `db/*.db` **and** `prisma/db/`. `dev:setup` script regenerates it via `prisma db push` + seed. No source path reads a committed DB file (the runtime creates it on demand from `DATABASE_URL`). |

**Nothing else was deleted.** In particular, all 13 migrations, all 48 test files, both lockfiles' candidates (see §4), every route, and all `audit/` + `docs/` files were retained after verification.

---

## 2. Duplicate Code Consolidated

### 2.1 `escapeHtml` — four implementations → one shared module

| Previous location | Behavior before | Status |
|---|---|---|
| `src/components/app/qr-codes-view.tsx` | escaped `& < > " '` (local function) | replaced by import |
| `src/app/api/bills/[id]/receipt/route.ts` | escaped all 5 + null-safe (local function) | replaced by import |
| `src/lib/retention.ts` | escaped all 5 (local function) | replaced by import |
| `src/lib/providers/email.ts` | escaped only `& < > "` — **missing `'`** (local function) | replaced by import — **behavior change (bug fix): single quotes are now escaped in transactional email**, closing a latent attribute-breakout inconsistency with the other three copies |

**New shared module:** `src/lib/html-escape.ts` — null-safe, escapes `& < > " '`, ampersand-first ordering. **Unit-tested** in `tests/qr-injection-regression.test.ts` (8 dedicated cases: script payloads, event-handler attributes, single-quote breakout, double-escape ordering, null/undefined/empty).

Risk assessment: identical output for the two all-5 copies; strictly safer for email; the QR view and receipt route had no other consumers of their local functions (verified: no exports, no external references).

### 2.2 No other true duplicates found

The codebase is deliberately factored (`src/lib/*` services, `api-helpers` wrappers, shared Zod schemas in `validation.ts`). Repeated patterns that *look* duplicated are deliberate platform boundaries (e.g., per-domain validation schemas). Candidates inspected and **kept as-is**:

- `requireAuth` + `requirePermission` preamble across ~200 API routes — this is the framework's required per-route guard pattern, not copy-paste logic; centralizing it further would change route signatures project-wide (out of scope for a merge).
- Per-suite `import "./queue-test-env"` lines — test-environment ordering contract of the harness.
- `docs/` vs `audit/` documentation overlap — `docs/` is the operator reference, `audit/` is the historical verification trail; both are referenced from README/DEPLOYMENT.md.

---

## 3. Stale Artifacts & Generated Files

| Item | Status | Notes |
|---|---|---|
| `node_modules/`, `.next/`, build outputs | absent from both inputs | `.gitignore` verified to exclude all. |
| `*.log`, `backups/`, `var/` | absent | `.gitignore` covers (`/backups/` is anchored so the super-admin backups *route* is not ignored — verified historical bug stays fixed). |
| `.env`, `.auth-secret.dev`, `.dev-mfa-secret` | absent from both inputs | ignored via `.gitignore`; `.env.example` uses placeholders only. |
| Prisma generated client | not committed | generated at build time (`prisma generate` in `build` script, Dockerfile, CI, Netlify flow). |
| `worklog.md` | ignored by `.gitignore` | platform-side merge log; kept out of the shipped repo. |

---

## 4. Dependency & Lockfile Decisions

**No packages added, removed, or upgraded.** `package.json` is byte-identical between the two inputs (only script entries differ, per the Netlify fix), and `bun install --frozen-lockfile` confirms zero drift.

| File | Decision | Rationale |
|---|---|---|
| `bun.lock` | **Authoritative lockfile** | CI installs with `bun install --frozen-lockfile` (Bun 1.3.14 pinned); the test harness, Docker build, and all repo scripts run under bun; `bun test` is the test runner. |
| `package-lock.json` | **Kept — deliberately** (documented exception) | This is the input for the **Netlify production build** (`npm ci` with the committed lockfile = reproducible dependency tree) and the basis of CI's `npm audit --omit=dev` gate. Netlify's npm-based runtime cannot consume `bun.lock`; deleting it would make production deploys resolve fresh versions untested by CI. Both lockfiles were byte-identical in both input repos (no drift), and neither fork regenerated them. |

---

## 5. Structural Cleanliness Checks Performed

1. **Test registration gate** — `scripts/run-tests.ts` fails the run if any `tests/*.test.ts` is missing from its `TEST_FILES` registry (prevents silently skipped suites). The new `tests/qr-injection-regression.test.ts` is registered.
2. **`.gitignore` review** — covers: `node_modules/`, `.env*` (with `!.env.example` allowlist), `.auth-secret.dev`, local databases (`db/*.db`, `db/*.db-journal`, `prisma/db/`, `*.sqlite`, `*.sqlite3`), runtime artifacts, logs, `/backups/` (anchored), `.next/`, `next-env.d.ts`, `worklog.md`, `skills/`. **No local customer database or secret can be committed under these rules.**
3. **`.env.example` review** — variable names + safe placeholders/comments only; no real values; documents every production-fail-closed secret. Unchanged from inputs (already correct in both).
4. **Import graph integrity** — after the escapeHtml consolidation, `tsc --noEmit` passes (0 errors) and `eslint .` passes (0 errors), proving no dangling references to the removed local functions.

---

## 6. Items Considered For Removal But Kept (with justification)

| Candidate | Reason kept |
|---|---|
| `Caddyfile`, `docker-compose.prod.yml`, `Dockerfile` | Load-bearing for the supported VPS deployment path (`DEPLOYMENT.md` verified flow). |
| `audit/` directory (29 files) | Verification trail referenced by CI docs and the platform's own history; removing it would destroy the documented evidence chain for prior security work. |
| Both Prisma schemas (not merged into one) | Deliberate two-database workflow: SQLite dev/test (throwaway) + PostgreSQL production. CI enforces model/enum parity; the Postgres schema's parity fixes from the fixed fork are part of this merge. |
| `scripts/verify/`, `tests/helpers.ts` | Referenced by the harness and multiple suites. |
| `z-ai-web-dev-sdk` dependency | Used by AI features (`src/lib/ai/`); verified imports exist. |
