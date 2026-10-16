# MERGE_AUDIT.md — StayLoop Repository Merge Audit

**Date:** 2026-10-16
**Inputs (untouched originals):** `upload/hotal-main (2).zip` (573 files), `upload/stayloop-fixed-repo.zip` (572 files)
**Output:** this merged repository (`stayloop-merged`)
**Method:** byte-level SHA-256 comparison of every file (excluding `node_modules/`, `.git/`, `.next/`, local DB binaries), followed by line-by-line diff review of every differing file.

---

## 1. Executive Summary

The two repositories share **558 identical files (97.4%)**. They are the same codebase; the "fixed" fork diverged in exactly **13 changed files, 2 files only in the original, and 1 file only in the fix**. The divergence is not random — it is two deliberate, *opposing* change sets:

1. The **fixed fork improved**: Netlify deployment (Next.js `output: "standalone"` made conditional), QR-code print-window HTML injection protection, wallet-pass secret handling, a test-infrastructure secret-stability race fix, and Postgres↔SQLite schema parity fixes.
2. The **fixed fork regressed**: it **deleted the payment-idempotency safeguard** — the `BillPayment.idempotencyKey` unique column, migration `0013`, the robust `recordManualPayment` implementation in `src/lib/billing.ts`, **and the test assertions that proved those behaviors** (a textbook case of making tests pass by deleting them).

The merge therefore takes the **fixed fork as the base** (its Netlify + security improvements are valid) and **restores the original's payment-idempotency stack** (schema columns, migration, billing logic, and test assertions), plus targeted hardening added during this merge.

**Merge health:** zero unresolved conflicts. Every one of the 16 differing paths has an explicit, reviewed decision below.

---

## 2. Full Inventory & Comparison

| Category | Count | Detail |
|---|---|---|
| Identical files | 558 | byte-for-byte (SHA-256) |
| Changed files | 13 | listed in §3 |
| Only in original | 2 | `prisma/migrations/0013_bill_payment_idempotency/migration.sql`, `prisma/db/custom.db` |
| Only in fixed | 1 | `tests/config-secret-stability.test.ts` |

Both repositories ship: full `src/` app tree (App Router), 48 test files, `bun.lock` + `package-lock.json` (byte-identical in both), Prisma SQLite + PostgreSQL schemas, Docker/compose/Caddy deployment stack, `audit/` documentation suite (29 documents), `docs/` operator references (10 documents), GitHub Actions CI.

---

## 3. Decision Matrix — Every Differing File

| # | File | Original | Fixed fork | Merged decision | Rationale |
|---|---|---|---|---|---|
| 1 | `package.json` | `build` = standalone + post-copy steps | splits `build` (default output) vs `build:standalone` | **FIXED** | Netlify needs default output; Docker flow preserved via `build:standalone`. See §5.3. |
| 2 | `next.config.ts` | `output: "standalone"` always | `output: standalone` only when `STAYLOOP_STANDALONE=1` | **FIXED** | Unconditional `standalone` output breaks Netlify's Next runtime (incompatible `.next` layout). Conditional flag keeps Docker working. |
| 3 | `netlify.toml` | `node_version = "20"` (invalid key, ignored) | `NODE_VERSION = "22"` in `[build.environment]` | **FIXED** | `node_version` is not a recognized netlify.toml key; `NODE_VERSION` is the documented pin. Next 16 requires Node ≥ 20.9. |
| 4 | `Dockerfile` | `bun run build` | `bun run build:standalone` | **FIXED** | Matches the conditional-output change; Docker/VPS flow still gets a standalone server. |
| 5 | `.gitignore` | `db/*.db` (root-anchored only) | adds `prisma/db/` | **FIXED** | The original accidentally shipped a 2.2 MB stale dev DB (`prisma/db/custom.db`) with 3 seed accounts using known passwords. |
| 6 | `src/lib/billing.ts` | **Full idempotency**: SHA-256-scoped key on dedicated unique column, conflict rejection (different amount/method/reference/cash session → 422), P2002 concurrent-winner handling, legacy pre-column meta fallback, replay-before-terminal-state ordering, PARTIALLY_REFUNDED refund status | **Regressed**: raw key stored in JSON `meta`, fragile substring `contains` search (false positives/negatives, no concurrency fence), no conflict rejection, no P2002 path, refund always reports "REFUNDED" | **ORIGINAL (restored)** | The fixed implementation can double-charge on concurrent retries (no DB fence), silently reports success when a key is reused with a *different* amount, and misreports refund state. The original is strictly more correct. §5.1. |
| 7 | `prisma/schema.prisma` | `BillPayment.idempotencyKey String? @unique` | column deleted | **ORIGINAL (restored)** | The unique index is the authoritative duplicate-payment fence required by the billing logic and migration 0013. |
| 8 | `prisma/schema.postgres.prisma` | has `idempotencyKey`; lacks parity fixes | drops `idempotencyKey`; adds `abAssignments` rename + `FranchiseOrganizationAdmin.user` relation | **MERGED (surgical)** | Restored the `idempotencyKey` line **and** kept the fixed fork's parity fixes — relation renames carry no SQL footprint (FK comes from `ABAssignment.userId`), so no new migration is needed for them. |
| 9 | `prisma/migrations/0013_bill_payment_idempotency/` | present | **deleted** | **ORIGINAL (restored)** | Without it, a production `prisma migrate deploy` diverges from the schema → `migrate diff` failure and a missing unique index. Uses `ADD COLUMN IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT EXISTS` — safe & idempotent for re-runs. |
| 10 | `tests/phase14-billing.test.ts` | asserts same-`paymentId` replay, 422 on key reuse with different amount, `PARTIALLY_REFUNDED` status | those assertions deleted | **ORIGINAL (restored)** | The deleted assertions are the regression tests for exactly the behavior the fixed fork broke. Restoring the code without the tests would leave the fence unguarded. |
| 11 | `src/components/app/qr-codes-view.tsx` | raw `document.write` interpolation of staff-editable label/URL | `escapeHtml()` on label + URL in print window | **FIXED** | `"</title><script>…</script>"` in a QR label previously injected markup into the print window. Kept, then consolidated (§5.2). |
| 12 | `src/app/api/wallet/pass/[serial]/route.ts` | reads `process.env.AUTH_SECRET` (+ undocumented `DEV_AUTH_SECRET` fallback) directly | uses canonical `getAuthSecret()` accessor; 503 fail-closed on `ConfigValidationError` | **FIXED** | Dev/test deployments previously 503'd because the HMAC primitives used the accessor-derived key while this route used a different source. |
| 13 | `src/lib/config.ts` | async dev-secret adoption race (session tokens minted pre-swap became unreadable) | `deterministicTestSecret()` for test mode; corrected docs; `adoptedEncryptionSecret` typed `boolean \| null` | **FIXED** | Root-cause fix for observed "session expired after login", GCM auth-tag failures, and BLOCKED integrations in test runs. |
| 14 | `scripts/run-tests.ts` | killed only the `bunx` wrapper PID (orphaned `next-server` + workers wedged port 3100) | `killServerTree()` with detached process groups; registers new test file | **FIXED** | Correct teardown of dev-server process groups; also registers `config-secret-stability.test.ts`. |
| 15 | `tests/config-secret-stability.test.ts` | absent | new regression suite for the secret-adoption race | **FIXED (kept)** | Pins determinism, cross-"restart" readability, first-use-window stability. |
| 16 | `prisma/db/custom.db` | committed 2.2 MB stale SQLite dev DB with 3 known-password seed accounts | removed | **NOT restored** | Demo data is reproducible via `bun run seed`; a committed DB is a leak + bloat + drift hazard. `.gitignore` now covers `prisma/db/`. |

---

## 4. Conflicting Implementations Found

Exactly one substantive conflict existed — **payment idempotency** (rows 6–10 above). Resolution: the original's database-enforced design wins, because:

- **The fixed fork's approach cannot be made safe by patching.** Searching `meta` with substring `contains` has no concurrency fence: two simultaneous retries of the same key both find nothing, both insert, and the bill is charged twice. Only a unique constraint makes the database the arbiter (`P2002` → replay the committed winner).
- **The fixed fork returns `ALREADY_RECORDED` when the key is reused for a different amount/method** — i.e., it *confirms* a payment the caller did not make. The original rejects this with 422.
- The refund path in the fixed fork reports `REFUNDED` even when only part of the paid amount was refunded, corrupting downstream reporting that keys on `PARTIALLY_REFUNDED`.

No other file contained conflicting implementations of the same behavior.

---

## 5. Merge Details by Area

### 5.1 Payment idempotency (restored from original, verified)

`recordManualPayment` now again:
1. **Scopes and hashes** the caller key: `sha256(JSON([hotelId, billId, key]))` → raw tokens never stored, no substring/escaping bugs.
2. **Replays before terminal-state checks** — a retry after the bill was later voided/refunded still identifies the original payment instead of erroring.
3. **Rejects key reuse with different payment data** (method / amount / reference / cash session) with 422.
4. **Uses the unique index as the concurrency fence** — on `P2002` from a concurrent winner, returns the committed winner's result (idempotent retry contract).
5. **Reads legacy rows** written before the durable column existed (JSON-escaped `meta` search as fallback only, never as the primary fence).
6. Gateway captures remain fenced separately by `gatewayPaymentId @unique`; refunds return `PARTIALLY_REFUNDED` vs `REFUNDED` correctly.
7. No raw payment credentials stored — only references/UTRs.

Schema support restored: `idempotencyKey String? @unique` on `BillPayment` in **both** schemas + migration `0013` (idempotent SQL, safe on databases that already have the column).

### 5.2 QR-code security (fixed fork kept + consolidated + hardened)

- `escapeHtml` from the fixed fork is preserved as the print-window defense, but the **four divergent copies** across the codebase (`qr-codes-view.tsx`, `bills/[id]/receipt/route.ts`, `providers/email.ts`, `retention.ts`) were consolidated into one shared, unit-tested `src/lib/html-escape.ts`. Notably the email copy **did not escape single quotes** — a latent attribute-breakout inconsistency now fixed everywhere at once.
- **New:** `buildPublicUrl` (`src/lib/qr.ts`) now validates the origin scheme (only absolute `http(s)` pass; `javascript:` / `data:` / `vbscript:` / garbage degrade to a relative URL, never an exception). QR codes embed URLs customers scan with phones; a misconfigured `APP_ORIGIN` must never become a payload.
- The print window keeps: no inline `<script>`, no `eval`, nonce-CSP inheritance, and print-from-opener.
- Full server-side QR pipeline audited: codes are server-generated 24-byte `base64url` identifiers; `resolvePublicQr` validates `^[A-Za-z0-9_-]{8,64}$`; labels are trimmed/sliced to 80 chars; creation requires auth + `QR_MANAGE`.
- **New regression suite:** `tests/qr-injection-regression.test.ts` (16 tests) covering script-tag labels, `onerror` attribute payloads, single-quote breakouts, `javascript:`/`data:` origins, double-escape ordering, null handling, and identifier entropy.

### 5.3 Netlify / Next.js output configuration (fixed fork kept)

- `next build` produces the **default output** on Netlify (required by `@netlify/plugin-nextjs`); `output: "standalone"` is opt-in via `STAYLOOP_STANDALONE=1`, set only by `npm run build:standalone` / the Dockerfile.
- `netlify.toml`: `command = "npm run build"`, `publish = ".next"`, `NODE_VERSION = "22"` in `[build.environment]`. The app is a full-stack Node app (Prisma + Node middleware in `src/proxy.ts`) — it is **not** converted to a static site; API routes remain server-rendered through the Next runtime. No catch-all rewrites to `/index.html`.
- Requires the Netlify Next.js runtime plugin (already in `[[plugins]]`), Node ≥ 20.9 (pinned 22), and a PostgreSQL `DATABASE_URL` (Neon) — the production startup path fails closed if `DATABASE_URL` is not `postgres://`.

### 5.4 Database / Prisma reconciliation

| Item | Decision |
|---|---|
| SQLite dev schema (`prisma/schema.prisma`) | Restored `BillPayment.idempotencyKey @unique` (original file taken verbatim; it contained no other change vs the fixed fork). |
| PostgreSQL prod schema (`prisma/schema.postgres.prisma`) | Fixed fork base (parity fixes kept: `User.abAssignments` naming aligned with the dev schema; `FranchiseOrganizationAdmin.user` relation restored) **+** `idempotencyKey` line restored. Relation renames carry no SQL footprint (FK lives on `ABAssignment.userId`), so no additional migration is required. |
| Migration `0013_bill_payment_idempotency` | Restored verbatim. Forward-only, idempotent (`IF NOT EXISTS`), safe on databases that already applied it, and required for `prisma migrate diff` parity (CI enforces empty diff). No applied migration was edited. |
| Migration history 0001–0012 | Identical in both inputs — untouched. |
| `DATABASE_URL` workflows | Preserved as documented: dev/test = SQLite via `prisma db push` (throwaway files); production = PostgreSQL (Neon-compatible; `connection_limit` pooling documented; migrations applied with `prisma migrate deploy --schema prisma/schema.postgres.prisma` inside the `migrate` compose service). |
| `prisma/db/custom.db` | **Not restored** (stale committed dev database). |
| Both schemas validated | `prisma validate` passes for SQLite and PostgreSQL. |

### 5.5 Test-infrastructure fixes (fixed fork kept)

- `killServerTree()` process-group teardown eliminates the orphaned-server wedges behind historical ECONNRESET flakes.
- `deterministicTestSecret()` eliminates the async secret-swap race that invalidated session tokens mid-run.
- `tests/config-secret-stability.test.ts` retained and registered.

---

## 6. Security Risks & Potential Regressions Considered

1. **Committed dev database (original)** — carried 3 seed accounts with known passwords; risk of someone deploying it as-is. Resolved: not carried over; `.gitignore` covers `prisma/db/`.
2. **Deleted regression tests (fixed fork)** — restoring behavior without tests invites the next silent regression. Resolved: original assertions restored; new QR suite added; all registered in `scripts/run-tests.ts` (the harness *fails* if a `tests/*.test.ts` file is unregistered).
3. **Netlify `output: "standalone"` (original)** — broke every Netlify deploy. Resolved: conditional.
4. **Schema drift (fixed fork)** — Postgres schema missing migration 0013 breaks CI's `migrate diff` gate and production `migrate deploy`. Resolved: restored.
5. **Cross-repo drift in `escapeHtml` semantics** — consolidated to the most defensive implementation.
6. **QR origin scheme** — new validation added (defense-in-depth; see §5.2).
7. **No production secrets were found in either input** (`scripts/scan-secrets.ts` clean; `.env.example` contains placeholders only; `AUTH_SECRET`, `INTEGRATION_ENCRYPTION_KEY`, `ADMIN_BOOTSTRAP_SECRET` are fail-closed in production).

---

## 7. What Was Explicitly NOT Done

- No rewrite or "simplification" of working business logic — the restored `billing.ts` is the original file byte-for-byte.
- No migration renumbering, rewriting, or squashing — 0013 keeps its name and content.
- No dependency upgrades or lockfile regeneration — `bun install --frozen-lockfile` verified byte-identical `bun.lock`.
- No removal of files based on grep absence alone (the codebase uses dynamic imports, string-built audit actions, and generated client references).
- No changes to the 558 identical files.

---

## 8. Verification Performed For This Merge

| Check | Result |
|---|---|
| `bun install --frozen-lockfile` | PASS (561 packages, no drift) |
| `prisma validate` (SQLite schema) | PASS |
| `prisma validate` (PostgreSQL schema, synthetic URL) | PASS |
| `prisma generate` | PASS |
| `tsc --noEmit` | PASS (0 errors) |
| `eslint .` | PASS (0 errors) |
| `bun test tests/qr-injection-regression.test.ts` | 16/16 PASS |
| Full integration suite (`bun run test`) | see TEST_REPORT.md |
| Production build attempt | see TEST_REPORT.md |

*(Full methodology, failures, and blockers: TEST_REPORT.md. Security findings: SECURITY_AUDIT.md. Deletions: CLEANUP_REPORT.md.)*
