# CLEANUP_REPORT.md — Duplicate Code & Safe Removals (2026-10-16 pass)

**Principle applied:** remove/consolidate only what is *provably* redundant (identical behavior, no dynamic references, verified by imports + build + full test suite). No broad rewrites. Every change re-verified with `tsc --noEmit` (0 errors), `eslint .` (0 errors), and the full test suite (41/41 files, 234 acceptance assertions).

---

## 1. Consolidations Performed in This Pass

### 1.1 `CSRF_COOKIE` — single source of truth

- **Before:** `export const CSRF_COOKIE = "stayloop_csrf"` was independently defined in `src/lib/auth.ts` **and** `src/lib/csrf.ts` (same value, two places to drift during a future rename).
- **After:** `lib/csrf.ts` keeps the only definition; `lib/auth.ts` re-exports it (`export { CSRF_COOKIE } from "@/lib/csrf"`) so the five auth routes importing it from `@/lib/auth` are untouched.
- **Safety:** no import cycle (`csrf.ts` imports only `crypto` + `lib/proxy.ts`; `lib/proxy.ts` imports nothing); typecheck/lint/suite green.

### 1.2 `tierForScore` / `TIER_LABELS` — duplicated scoring tiers

- **Before:** identical logic duplicated in `src/lib/lead-scoring.ts` (Phase 4) and `src/lib/scoring.ts` (Phase 3) — same thresholds (≥81 VERY_HOT, ≥61 HOT, ≥31 WARM, else COLD), same labels.
- **After:** `scoring.ts` imports them from `lead-scoring.ts` (which holds the named `TIER_THRESHOLDS` constant) and re-exports both for any existing importer. **Behavior is byte-identical** (thresholds verified equal before consolidating).
- **Safety:** no external importer of `scoring.ts`'s tier symbols exists (checked: only `recomputeCustomerScores` is imported elsewhere); suites green.

---

## 2. Verified NOT Duplicates (deliberately left in place)

| Candidate | Why it is not a duplicate |
|---|---|
| `lib/coupons.ts` (`validateCoupon`/`redeemCoupon`/`computeDiscount`) vs `lib/saas/coupons.ts` (same export names) | **Different domains**: tenant restaurant/marketing coupons vs platform SaaS checkout coupons — different models, guards, and callers. Consolidating would couple unrelated billing domains. Renaming the shared symbol names was considered and rejected (churn without behavior benefit). |
| `lib/lead-scoring.ts` vs `lib/scoring.ts` (remaining code) | Different scoring systems (engagement/lead scoring vs RFM value scoring); only the shared tier vocabulary was duplicated (consolidated, §1.2). |
| `CSRF`/cookie option helpers in `auth.ts` vs `csrf.ts` | Complementary (cookie attributes vs token assertion), not overlapping. |
| Multiple `export const dynamic`/`runtime` segment configs across routes | Next.js route convention, not duplication. |
| Exact-duplicate file scan (SHA-256 of every `src/**/*.{ts,tsx}`) | **Zero** identical files found. |
| `bun.lock` + `package-lock.json` (two lockfiles) | **Deliberate dual toolchain**: `bun.lock` is authoritative for local dev/tests/CI (bun scripts, `bun install --frozen-lockfile` — verified drift-free), `package-lock.json` is required by Netlify's `npm ci`-based build (verified consistent via `npm ci --dry-run`). Removing either breaks a supported path; both are in sync with `package.json` (no dependency changes were made in this pass). |

## 3. Removals Performed in This Pass

**None.** No dead code, no obsolete files, and no dependencies qualified for removal under the safety bar:

- No exact-duplicate files (SHA-256 scan).
- No unused dependencies found (`z-ai-web-dev-sdk` is used by the AI chatbot/recommendations server paths; `ioredis` by optional distributed rate limiting/queue; `sharp` by Next image optimization; `qrcode` by the QR pipeline; `nodemailer` by the SMTP provider).
- `prisma/db/custom.db` (stale 2.2 MB dev database with known-password accounts) was already excluded at the merge and remains absent; `.gitignore` covers `prisma/db/`.
- The 14 migrations, Dockerfile, compose files, Caddyfile, and CI workflow are all required deployment artifacts — all preserved.

## 4. Historical Removals Inherited From the Merge (re-verified still-correct)

- Four divergent `escapeHtml` copies → one shared, unit-tested `src/lib/html-escape.ts` (the email copy lacked single-quote escaping — fixed at merge; 16-test QR-injection suite guards it).
- Stale committed SQLite dev database removed (known-password seed accounts).
- Test-runner process-group teardown fixes retained (`killServerTree`).

## 5. Net Effect

- 2 real consolidations (drift hazards eliminated), 0 deletions, 0 dependency changes, 0 behavior changes.
- Every prior claim about "duplicates removed" in the inherited `CLEANUP_REPORT.md` was re-verified against the current tree and remains accurate.
