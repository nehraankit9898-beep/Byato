# Confirmed findings — 2026-10-17

Scope: findings newly confirmed in this session, not totals from historical reports.
**6 findings: Critical 0, High 3, Medium 3, Low 0. Five fixed, none partially fixed, one unresolved.**
Locations below refer to the current files; the corresponding functions existed on the baseline commit.
PASS means the stated regression scope passes, not that a production workflow was exercised.

## AUD-001 — High — MFA setup bypasses factor-removal verification
- Location: `src/lib/mfa.ts:191–208` (`beginMfaSetup`); API `src/app/api/mfa/setup/route.ts:10–29`.
- Reproduce: give an account an enabled factor, then call `beginMfaSetup` using its existing authenticated session, without a fresh MFA code. The baseline replaces the secret and sets `mfaEnabled=false`.
- Root cause/evidence: unconditional `user.update` explicitly disabled MFA. The separate disable endpoint requires a fresh code but setup did not. Regression tests reproduced this using an in-memory Prisma boundary; no live account was altered.
- Recommended/applied fix: reject enabled factors, atomically require `mfaEnabled=false` when saving setup, return HTTP 409 `MFA_SETUP_CONFLICT`; clear obsolete backup/replay state only for disabled factors.
- Verification: first two tests in `tests/mfa-enrollment-regression.test.ts`, including an enablement race during QR generation. Baseline fails, patched passes.
- Status: **PASS (service behavior with mocked persistence; HTTP integration NOT VERIFIED).**

## AUD-002 — High — enrollment confirmation is not bound to the verified secret
- Location: `src/lib/mfa.ts:212–240` (`confirmMfaSetup`).
- Reproduce: start enrollment A; while its valid code is being confirmed, replace the pending secret with B. Baseline enables B without verifying a code for B. Alternatively confirm A twice concurrently: both calls return different backup-code sets, only the last set remains valid.
- Root cause/evidence: read/verify followed by unconditional update using only user ID. In-memory interleaving tests reproduce both cases; baseline has two successful concurrent confirmations.
- Recommended/applied fix: compare-and-set the exact encrypted secret and disabled state in one `updateMany`; only the winner returns codes and logs enablement.
- Verification: replacement-secret and concurrent-confirmation tests; valid and invalid normal paths also covered.
- Status: **PASS (mocked atomic-update boundary); actual PostgreSQL contention NOT VERIFIED.**

## AUD-003 — Medium — OTP acceptance races past the failure ceiling
- Location: `src/lib/phone-otp.ts:282–290`.
- Reproduce: a correct verification reads attempts below five; concurrent wrong attempts raise the stored count to five before consumption. The baseline `lte: OTP_MAX_ATTEMPTS` still consumes it.
- Root cause/evidence: success-update predicate disagrees with the earlier `attempts >= max` rejection and documented strict ceiling. Mocked interleaving test fails on baseline.
- Recommended/applied fix: use `lt` rather than `lte` in the atomic consume predicate.
- Verification: `tests/audit-current-regressions.test.ts`, rejects at five, accepts at four. Hash comparison is deliberately stubbed here to isolate the concurrency predicate; this is not a cryptographic test.
- Status: **PASS (boundary regression); live database concurrency NOT VERIFIED.**

## AUD-004 — Medium — category webhook subscriptions never match
- Location: `src/lib/webhooks-out.ts:143–156` (`endpointSubscribesTo`).
- Reproduce: subscribe to `order.*`, match `order.created`; baseline returns false.
- Root cause/evidence: baseline tests for the literal prefix `order.*.`. Deterministic matcher test reproduces the failure.
- Recommended/applied fix: remove the terminal asterisk, retaining the dot boundary, before prefix matching.
- Verification: exact/global/category/nested events, wrong category, inactive endpoint and malformed subscription JSON in `tests/audit-current-regressions.test.ts`.
- Status: **PASS (matcher); actual delivery NOT VERIFIED.**

## AUD-005 — Medium — default build/start and PostgreSQL CI disagree on output mode
- Location: `package.json:7–10,30`; `.github/workflows/ci.yml:209–210`; `scripts/test-pg-integration.ts:294–300`.
- Reproduce from a clean output directory: baseline default build has standalone disabled by `next.config.ts`, but baseline start tries `.next/standalone/server.js`. PostgreSQL CI also uses that default build while its integration script requires the standalone file.
- Root cause/evidence: standalone became opt-in without updating consumers. Three build-contract tests fail on baseline. No runtime missing-module failure is claimed to have been executed.
- Recommended/applied fix: standard build pairs with `next start`; add explicit `start:standalone`; make standalone build generate the production client; CI requests standalone. README explains both modes. Docker's direct `server.js` startup is preserved.
- Verification: three static configuration regressions pass; direct Next production compilation passes with an engine-free client. Native Prisma generation and real startup remain blocked in this environment.
- Status: **PASS (configuration contract); production startup NOT VERIFIED.**

## AUD-006 — High (upstream rating) — vulnerable development dependency chain
- Location: `package-lock.json`, installed `braces@3.0.3`, through micromatch → fast-glob → @next/eslint-plugin-next → eslint-config-next; `package.json` devDependencies.
- Reproduce: `npm ci --ignore-scripts`, then `npm audit --json`: exit 1, five high-severity package entries from this chain, one underlying advisory: GHSA-vfj7-8cjw-p6xm (nested-pattern stack exhaustion).
- Evidence: audit result; no exploit or remotely reachable application attack was reproduced. `npm audit --omit=dev --json` exits 0 with zero reported runtime advisories.
- Recommended fix: adopt a compatible patched chain when available, or review a controlled tooling replacement. `npm view braces version` reports 3.0.3; the suggested force fix downgrades eslint-config-next to 14.2.35, mismatching Next 16.
- Actual fix: none; no forced downgrade or security-check suppression.
- Verification: **NOT VERIFIED (unresolved)**; dependency scan still reports the finding.
