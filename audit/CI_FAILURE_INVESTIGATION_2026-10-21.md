# CI failure investigation & fix — 2026-10-21

Branch: `arena/94a9b612-byato` · Repository: `nehraankit9898-beep/Byato`
Base commit: `1dabcf5` (merge of PR #28)

---

## 0. Repository scope — read this first

The CI run named in the task, **`39217538642`, belongs to `nehraankit9898-beep/hotal`**
(workflow job `quality-and-security`, job id `117944823058`, head `560f765a`).

This workspace is a checkout of **`nehraankit9898-beep/Byato`**, which is the same
product/codebase continued (Byato = the restaurant product that this repo's UI calls
"StayLoop" internally; `hotal` stops at PR #21, `Byato` continues through PR #28 and adds
57 test suites). All work in this session was done in **Byato**, on the branch above.
Nothing was committed to `main`, `hotal`, or any other branch.

Consequently there are **two different CI stories**:

| Repository | Run | Result |
|---|---|---|
| `hotal` | `39217538642` (the run in the task) | Tests failed; 4 suites are provable from check-run annotations; production build and all PostgreSQL jobs were skipped |
| `Byato` | `39567564092` (latest `main`, 2026-10-21) | **Also red** — but for a different reason: one stale dashboard regression assertion after the luxury redesign. Tests failing ⇒ build + PostgreSQL jobs skipped |

Both are covered below.

---

## A. Exact root cause of each previously failing suite

### A.1 What the check-run annotations prove (`hotal` run 39217538642)

The raw job log lives on `results-receiver.actions.githubusercontent.com` /
`productionresultssa*.blob.core.windows.net`, which this sandbox cannot reach (the
download fails with `EOF`). The check-run annotations **are** reachable through
`api.github.com` and give exact file/line/title/message. They show four failing test
files plus one unhandled crypto error:

| # | Suite | Recorded failure | Root cause |
|---|---|---|---|
| 1 | `tests/bugfix-regressions-2026-10.test.ts:233` | `expect(received).toEqual(expected)` — expected `[]`, received `["export-policy.test.ts"]` | `tests/export-policy.test.ts` existed on disk but was **missing from `TEST_FILES` in `scripts/run-tests.ts`**, so `bun run test` silently skipped it and the repository-hygiene guard failed. |
| 2 | `tests/recheck-fixes.test.ts:204` | Expected `"WHATSAPP_CLOUD"`, received `"BLOCKED"` | **Async dev/test secret-adoption race** in `src/lib/config.ts`. The first `getIntegrationEncryptionKey()` call returned a per-PID synchronous fallback; an async resolution replaced the cached key moments later. Credentials encrypted before the swap could no longer be decrypted (GCM auth failure), so provider resolution failed closed to `BLOCKED`. |
| 3 | `tests/ops-reliability.test.ts:61` | Expected `true`, received `false`; unhandled `Unsupported state or unable to authenticate data` at `src/lib/saas/backup.ts:414` | Same key swap: `verifyBackup()` decrypted an archive whose AES-256-GCM tag was produced with the pre-swap key. |
| 4 | `tests/phase10-saas.test.ts:573` | Expected `"SUCCESS"`, received `"FAILED"` | Same key swap, mid backup sweep. |
| 5 | `scripts/test-phase1.ts` (functional acceptance) | Login succeeds, next request → 401 "Your session has expired" | Same race on `AUTH_SECRET`: the token was signed with the pre-swap fallback. This failure is documented in the header of `tests/config-secret-stability.test.ts`, which names this exact symptom. |
| 6 | *(not recoverable)* | — | The run reported six failed suites, but only five can be evidenced (4 annotated test files + `test-phase1.ts`). The sixth is most likely `scripts/test-phase2.ts` (chained functional suite); **this is inference, not proof**, because the raw log archive is unreachable from this environment. |

The `src/lib/saas/backup.ts:414` crypto error is not a separate suite — it is the
failure inside suites 3/4.

### A.2 Root cause of the *current* `main` failure (Byato)

`Byato` run `39567564092` (job `119113432959`) failed **typecheck ✓, lint ✓, secret scan ✓,
dependency audit ✓, tests ✗** with exactly one annotation:

```
tests/dashboard-regressions.test.ts:168
Expected to contain: "aria-label=\"Restaurant summary\""
```

Cause: commit `bf8b571` ("design: app-wide luxury pass — primitives, dashboard KPI strip,
…") moved the KPI row out of `src/components/app/dashboard-view.tsx` into the shared
`<KpiStrip>` primitive in `src/components/app/shared-ui.tsx`. The accessible
`aria-label="Restaurant summary"` moved **with** the markup (it is present in `KpiStrip`),
and the four figures became `label` props instead of `title` attributes. The test was
asserting the old file layout, not a lost behaviour — but because it failed, the
production build and both PostgreSQL jobs were skipped.

### A.3 Intermittent failures found while investigating (real, now fixed)

Two other `main` runs on 2026-10-21 show a **second, independent** root cause — SQLite
lock contention in the test harness:

| Run | Failure |
|---|---|
| `39564794979` | `tests/super-admin-platform.test.ts:103` → `PrismaClientKnownRequestError: Operation has timed out` on `db.user.updateMany`. Because the throw happened **before** the module-level `saJar` was assigned, every later request in the file returned **401** — a misleading "auth" cascade across 8 assertions. |
| `39565955894` | `tests/audit-fixes.test.ts:746` → `Operation has timed out` on `db.customer.findFirst`. |

Reproduced locally: the harness leaves the temp SQLite database in
`journal_mode=delete` with `busy_timeout=0`. A second process gets
`SQLITE_BUSY: database is locked` **immediately** (0 ms) while another holds a write lock,
because each suite runs in its own process against the same file the dev server is
writing to. `PRAGMA busy_timeout=30000` is **not honoured** through the libsql native
binding (verified: still `SQLITE_BUSY` at 0 ms), so the mitigation must be WAL + a
JavaScript-side retry.

---

## B. Files changed and what was fixed

| File | Change |
|---|---|
| `tests/dashboard-regressions.test.ts` | Dashboard KPI assertions updated to the post-redesign structure: still asserts the labelled `Restaurant summary` landmark (now in `shared-ui.tsx`), the same four plain-language KPIs, the two quick actions, and the absence of the legacy "Unique Guests"/"Opted Out" wording. No guarantee removed. This is the fix for the **current red `main`**. |
| `scripts/run-tests.ts` | (a) Switch the disposable SQLite database to **WAL** immediately after `prisma db push`; (b) remove the **duplicate** registration of `tests/export-policy.test.ts` (the suite ran twice); (c) register the new concurrency regression suite. |
| `scripts/test-db-concurrency.ts` *(new)* | `enableSqliteWal()` (verifies the mode really changed), `isSqliteContentionError()` (P1008/P2010/P2024/P2028 + SQLITE_BUSY/database-locked/"Operation has timed out"), and bounded `retryOnSqliteContention()`. Test-only; no application code imports it. |
| `tests/helpers.ts` | Test Prisma client is wrapped with `$extends({ query: { $allOperations } })` so **only** transient contention errors are retried (10 attempts, 100→1000 ms). Non-contention errors are re-thrown on the first attempt. |
| `tests/bugfix-regressions-2026-10.test.ts` | New guard: **no suite may be registered twice** in `run-tests.ts` (the presence guard could not see the double entry). |
| `tests/test-db-concurrency.test.ts` *(new)* | Regression suite for WAL + retry semantics (details in §C). |

No application/runtime code, Prisma schema, migration, dependency version, Vercel
configuration, or security control was changed.

---

## C. Regression tests added

`tests/test-db-concurrency.test.ts` — 5 tests:

1. `enableSqliteWal` switches the file to `wal`, and a **fresh connection** observes it
   (proves persistence, not just a client setting).
2. A reader is **not blocked** while another connection holds `BEGIN IMMEDIATE` — this is
   the exact shape of the `findFirst` timeout; it fails if WAL is removed.
3. `retryOnSqliteContention` rides out a transient writer lock (asserts `attempts > 1`,
   so a single-attempt implementation fails).
4. A `UNIQUE` violation is **never retried** (`attempts === 1`) — the retry cannot mask a
   genuine defect.
5. Contention classification matches the CI signatures and rejects unrelated errors.

`tests/bugfix-regressions-2026-10.test.ts` — new "no suite is registered twice" test.
Against the original file (which listed `export-policy.test.ts` twice) this test fails;
after the change it passes.

`tests/dashboard-regressions.test.ts` — the existing test was **not weakened**: it still
checks the accessible name and all four KPI labels, now at the component that actually
renders them. Removing the `aria-label` from `KpiStrip` or renaming a KPI fails it.

---

## D. Commands executed and actual results

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | exit 0 (the `postinstall` Prisma download fails in this sandbox, which is why the harness regenerates the test client itself) |
| `bun run typecheck` | **exit 0** (before and after the last edit) |
| `bun run lint` (`eslint .`) | **exit 0** (before and after the last edit) |
| `bun run scan:secrets` | **clean, exit 0** |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities, exit 0** |
| `bun test tests/dashboard-regressions.test.ts` | 16 pass / 0 fail |
| `bun test tests/test-db-concurrency.test.ts tests/bugfix-regressions-2026-10.test.ts` | 30 pass / 0 fail |
| `bun run test` (full harness: 57 suites + 3 functional suites) | **ALL TEST SUITES PASSED**, exit 0 — **57/57 suites, 682 bun tests, 0 failures; 234 ✅ / 0 ❌ functional acceptance checks** |
| `bunx prisma validate --schema prisma/schema.prisma` (test mode) | **valid** |
| `bunx prisma generate --schema prisma/schema.postgres.prisma` | **exit 0** — the PostgreSQL schema parses and generates (schema-engine download stubbed in this sandbox) |
| `bun run build` (`prisma generate` + `next build`, `DATABASE_URL=file:../db/ci.db`) | **exit 0** in 53 s — every route compiled |
| `prisma validate` (PostgreSQL schema) | blocked — CLI insists on downloading the native schema engine from `binaries.prisma.sh` |
| `prisma migrate deploy` / drift / PG integration | **blocked locally** — no PostgreSQL server and no Docker in this sandbox |

Previously failing suites, individually, on the final run:

| Suite | Result |
|---|---|
| `tests/bugfix-regressions-2026-10.test.ts` | **25 pass / 0 fail** |
| `tests/recheck-fixes.test.ts` | **9 pass / 0 fail** |
| `tests/ops-reliability.test.ts` | **10 pass / 0 fail** |
| `tests/phase10-saas.test.ts` | **29 pass / 0 fail** |
| `tests/dashboard-regressions.test.ts` (current-main failure) | **16 pass / 0 fail** |
| `tests/super-admin-platform.test.ts` (401-cascade flake) | **13 pass / 0 fail** |
| `tests/audit-fixes.test.ts` (P1008 flake) | **18 pass / 0 fail** |
| `tests/config-secret-stability.test.ts` | **5 pass / 0 fail** |
| `scripts/test-phase1.ts` / `test-phase2.ts` / `test-phase63.ts` | **all ✅, 0 failures** |

Workflow coverage in the same run (the product paths named in the task):

| Workflow | Suites | Result |
|---|---|---|
| Digital menu → QR scan → cart → order → kitchen status | `phase12-menu` (10), `phase13-orders` (16), `qr-injection-regression` (16) | all pass |
| Customer creation → visit → dashboard metrics | `customers-crm` (63), `dashboard-regressions` (16), `api-v1-visits-regression` (1), acceptance suites §2/§3 | all pass |
| Authorization + cross-tenant isolation | `rbac-security-master` (26), `rbac-tenant` (13), `navigation-rbac` (12), `security` (18), acceptance §4 (Hotel B cannot read/write Hotel A) | all pass |

---

## E. CI status, production build status, PostgreSQL integration status

| Gate | Status |
|---|---|
| `main` quality-and-security (pre-fix) | **FAIL** — `tests/dashboard-regressions.test.ts:168` (runs 39567564092 / 39567394841) |
| This branch (local verification) | typecheck ✓, lint ✓, secret scan ✓, dependency audit ✓, 57/57 suites ✓, functional ✓, production build ✓ |
| Production build (CI) | skipped on the failing runs; **locally exit 0** (see D); the PR run will re-verify it in CI |
| PostgreSQL migrations (CI) | green on the last run where tests passed (`39566066559`: 50 s); skipped on the red runs; **not runnable locally** |
| PostgreSQL integration (CI) | green on `39566066559` (2 m 0 s); skipped on the red runs; **not runnable locally** |
| Docker / Trivy job | **still red, separately**: on `main` the action ref `aquasecurity/trivy-action@0.36.0` does not resolve (tags are `v`-prefixed). Open **PR #24** fixes the ref, but its docker job now fails at the actual Trivy scan (`Trivy vulnerability scan (web)` step, HIGH/CRITICAL findings). That is a different problem from the test failures and is **not** addressed here. |

---

## F. Tests that remain blocked or unverified, and why

1. **Raw logs of `hotal` run 39217538642** — the archive is served from a host outside
   this sandbox's network allowlist. Four suites are proven by check-run annotations;
   `test-phase1.ts` is documented in-repo; the **sixth suite cannot be named with
   evidence**.
2. **PostgreSQL migration/drift/integration locally** — no `postgres`, `initdb`, `psql`
   or `docker` binaries in the sandbox. Not claimed as run. CI evidence from
   `39566066559` is cited instead.
3. **Docker build + Trivy** — no Docker daemon locally; the Trivy database host is also
   unreachable.
4. **Vercel deployment** — not triggered from this session.

---

## G. Branch and pull request

- Branch: `arena/94a9b612-byato` (session branch; a separate `fix/ci-test-failures`
  branch cannot be created because the session is pinned to this branch).
- Pull request: **https://github.com/nehraankit9898-beep/Byato/pull/29**
  (open, **not** merged).

---

## H. Remaining production risks and next recommended step

1. **The docker gate is still red.** Merging PR #24 alone will not make CI green: it
   converts "action cannot resolve" into "Trivy found HIGH/CRITICAL in the web image".
   Next step: rebuild on an updated base image, and either patch the affected packages or
   record an explicit, reviewed exception. Do not lower `severity`/`exit-code`.
2. **SQLite test harness ≠ production PostgreSQL.** The WAL/retry fix makes the SQLite
   harness deterministic; it cannot prove PostgreSQL concurrency behaviour. The PG
   migration + integration jobs remain the authority and must stay required.
3. **Retry masking.** The retry is bounded, test-only, and restricted to contention
   signatures; a persistent lock still fails the test. Kept that way deliberately.
4. **PR #11 collision.** `prisma/migrations/0015_bill_job_dedupe_key` (open PR #11)
   collides with the merged `0015_fssai_number`. When #11 is rebased it needs a new
   migration number; silently reusing `0015` would break `migrate deploy`.
5. **hotal vs Byato drift.** Any fix merged here does not automatically reach `hotal`.
   Decide which repository is the source of truth before more work is split across both.
