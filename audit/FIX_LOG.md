# Fix Log — StayLoop audit (2026-10-11)

Branch: `arena/4731a2f4-hotal`. Every fix is a small, root-cause change. No feature was removed, no check was weakened,
and no test was suppressed.

| Finding | Files changed | Change | Regression test | Result |
|---|---|---|---|---|
| SEC-001 | `src/lib/staff-guards.ts` (new), `src/app/api/staff/[id]/route.ts` | Pure rank guard `canActOnStaffTarget`; route returns 403 for an admin acting on the owner, before any mutation | `audit-2026-regressions` › SEC-001 (4 tests) | Fails on original (wiring test); passes with fix |
| SEC-002 | `src/lib/api-helpers.ts` (`requireSuperAdminSession`) | Select DB `role`; require `SUPER_ADMIN` in the database, not only in the token | Source-level only (behavioral test BLOCKED) | Code review; DB test pending |
| SEC-004 | `src/lib/config.ts` (`isTest`) | `isTest()` is false when `isProduction()` | `audit-2026-regressions` › SEC-004 | Fails on original; passes with fix |
| SEC-005 | `src/lib/body.ts` (new), `src/lib/api-helpers.ts` (`readJson` now aliases `readJsonCapped`) | Byte-counted streaming read with 1 MB cap; declared oversize rejected early; malformed JSON → null | `audit-2026-regressions` › SEC-005 (5 tests) | Passes (new module); original defect shown by source reading |
| SEC-006 | `src/app/api/auth/logout/route.ts` | `assertCsrf` before revoking sessions; client logout is best-effort, so no UX regression | `audit-2026-regressions` › SEC-006 (2 tests) | Passes |
| FIN-001 | `src/app/api/webhooks/razorpay-restaurant/route.ts` | Wrap `recordGatewayCapture`; on throw, delete the dedupe row and re-throw so the provider retries | `audit-2026-regressions` › FIN-001 (1 static test) | Fails on original; passes with fix |
| (tooling) | `audit/tools/generate_inventory.py` (new) | Generates `ROUTE_INVENTORY.md` and `ROLE_PERMISSION_MATRIX.md` from source | Run and checked by hand (202 routes, 11 roles, 88 permissions) | — |

## Test-file corrections made during the work
- The first regression file failed typecheck: `process.env.NODE_ENV` is read-only in TypeScript. Fixed with a typed cast in the test only; no production code changed.
- A first version of `readJson` also rejected JSON arrays. That would have changed behavior for any route that accepts an array, so it was reverted before commit.
- `src/lib/permissions.ts` got a stray one-line change while the helper was being moved; reverted with `git checkout`.
- Prettier: new files and `api-helpers.ts` (clean before the audit) were formatted. `staff/[id]/route.ts` and `razorpay-restaurant/route.ts` were already unformatted on `main`, so they were left alone to keep the diff focused.

## Verification after the fixes
| Check | Result |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun run lint` | exit 0 |
| `bun run scan:secrets` | exit 0 (tracked files) |
| `bun test tests/audit-2026-regressions.test.ts` | 13 pass, 0 fail |
| `bun test tests/deployment-config.test.ts` | 16 pass, 0 fail (unchanged) |
| `bun test tests/security-hardening.test.ts` | 10 pass, 0 fail (unchanged) |
| Fail-on-original check | 3 regression tests fail on original code, pass with fixes |

## Not fixed (see REMAINING_RISKS.md)
FUNC-001 (custom roles), SEC-007 (rate limits on payment-link routes), DB-001/DB-002 (Float and mixed money units), INT-001 to INT-004, DOC-001 (documentation).

## Rollback
Each fix is independent. To revert one, `git revert` the relevant hunk (the files are listed above). Nothing in this set changes the database schema or stored data.

---

# Fix Log — CI-001 (2026-10-19)

Branch: `arena/71c0dcb9-byato` (base `9c2f2cb`, main).

| Finding | Files changed | Change | Regression test | Result |
|---|---|---|---|---|
| CI-001 — unresolvable GitHub Actions ref silently disabled the docker release gate | `.github/workflows/ci.yml`, `tests/deployment-config.test.ts`, `LAUNCH_CHECKLIST.md`, `audit/REMAINING_BLOCKERS.md` | `aquasecurity/trivy-action@0.36.0` → `@v0.36.0` (upstream tags are `v`-prefixed); added A5 allowlist guard so any future unresolvable ref fails a test instead of a job | `deployment-config` › A5 (4 tests) | 3 of the 4 fail on the original ref, all 20 pass with the fix |

## Evidence

`gh run view` for runs `39142757093`, `39220571032`, `39235756453`, `39238304015`
(main pushes for PRs #18, #22, #23 and the PR pipelines themselves) all show the
same shape:

```
✓ quality-and-security   ✓ postgres-migrations   ✓ postgres-integration
X docker — X Set up job
   "Unable to resolve action `aquasecurity/trivy-action@0.36.0`,
    unable to find version `0.36.0`"
```

Upstream tag check via the GitHub API (2026-10-19):
`/repos/aquasecurity/trivy-action/git/ref/tags/v0.36.0` → **200**,
`/repos/aquasecurity/trivy-action/git/ref/tags/0.36.0` → **404**.

Consequence: the docker job died in ~3 s, before `docker build`, before both
Trivy scans, before compose startup/health checks, before the in-stack export
round-trip and before the pg_dump backup + restore. Those checks are listed as
release gates in `LAUNCH_CHECKLIST.md` §A but had **not** been executed by CI on
any recent commit. The three green jobs are unaffected — they do prove
frozen install, dependency audit (prod), secret scan, typecheck, lint, the full
SQLite test suite, the production build, PostgreSQL 16 migrations + drift and
the PostgreSQL integration suite.

## Verification in this sandbox (network-restricted: `binaries.prisma.sh` blocked)

| Check | Result |
|---|---|
| `bun install --frozen-lockfile --ignore-scripts` (Bun 1.4.3) | exit 0, 592 packages |
| `bun test tests/deployment-config.test.ts` (Prisma-free suite) | 20 pass, 0 fail |
| same test against the original broken ref | 17 pass, **3 fail** |
| `npx eslint .` (whole tree) | exit 0 |
| `prettier --check` on the changed files | exit 0 |
| `bun run scripts/scan-secrets.ts` | exit 0, clean |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| `npm audit --audit-level=high` (full tree) | 5 high — all the DEP-002 dev-only chain `braces * → micromatch → fast-glob → @next/eslint-plugin-next → eslint-config-next`; no patched `braces` exists upstream, `npm audit fix --force` would downgrade to eslint-config-next 14 |
| `prisma generate` / `bun run typecheck` / `bun run test` / `bun run build` | **NOT RUNNABLE HERE** — Prisma CLI downloads `libquery_engine.so.node` from the blocked host even with `engineType = "client"` and `--no-engine`. CI covers all four. |

## Rollback

`git revert` the single workflow hunk (`@v0.36.0` → `@0.36.0`) restores the
previous behaviour; the A5 tests then fail, which is the intended signal. No
schema, data, runtime code or dependency version changed.

---

# Fix Log — CI-002 (2026-10-19, same branch)

Repairing CI-001 let the `docker` job run its steps for the first time in weeks
— and it immediately failed in `Build production images` (run `39244641325`,
`Process completed with exit code 1` at log line 488). That step built **both**
targets in one command, so the step list could not say which one broke, and the
raw log archive is served from `results-receiver.actions.githubusercontent.com`
— a different host than `api.github.com` — so the cause was unreadable from
here.

| Finding | Files changed | Change | Regression test | Result |
|---|---|---|---|---|
| CI-002 — a docker build failure was undiagnosable from run metadata | `.github/workflows/ci.yml`, `tests/deployment-config.test.ts` | One named step per target (`Build web image (--target web)` / `Build worker image (--target worker)`), `--progress=plain`, log captured to `/tmp/build-<target>.log`, tail echoed to the step log **and** published as an `::error` check annotation. Each step still `exit "$status"`, so the gate is unchanged in strength | `deployment-config` › A6 (5 tests) | 4 of the 5 fail against the previous workflow; the file is now 25 pass / 0 fail (was 16 on `main`) |

Read the annotation with:

```bash
gh api repos/nehraankit9898-beep/Byato/check-runs/<docker-job-id>/annotations \
  --jq '.[] | select(.annotation_level=="failure") | .message'
```

The actual image-build defect this exposes is diagnosed and fixed in the commits
that follow on this branch.
