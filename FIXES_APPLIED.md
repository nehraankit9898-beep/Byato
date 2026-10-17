# Fixes applied — 2026-10-17

See BUGS_FOUND.md for evidence, severity, reproduction and verification limits.

| File | Change | Finding |
|---|---|---|
| `src/lib/mfa.ts` | Typed setup conflict; refuses enabled MFA; conditional setup persistence; clears old disabled-factor state; exact-secret single-winner confirmation | AUD-001, AUD-002 |
| `src/app/api/mfa/setup/route.ts` | Expected setup conflict becomes 409, not generic 500 | AUD-001 |
| `src/lib/phone-otp.ts` | Strict attempt ceiling in atomic consume | AUD-003 |
| `src/lib/webhooks-out.ts` | Correct category wildcard prefix | AUD-004 |
| `package.json` | Consistent default and explicit standalone build/start pairs; standalone generates PostgreSQL client | AUD-005 |
| `.github/workflows/ci.yml` | PG integration builds its required standalone artifact | AUD-005 |
| `scripts/test-pg-integration.ts` | Correct prerequisite message | AUD-005 |
| `README.md` | Explain standard versus standalone commands | AUD-005 |
| `scripts/run-tests.ts` | Register all three added regression suites in the existing per-process harness | All fixed findings |
| `tests/mfa-enrollment-regression.test.ts` | Five real service-function tests with simulated persistence | AUD-001, AUD-002 |
| `tests/audit-current-regressions.test.ts` | Four matcher/OTP predicate regressions | AUD-003, AUD-004 |
| `tests/build-mode-contract.test.ts` | Three build/CI configuration contracts | AUD-005 |
| Nine root audit documents + `audit/CURRENT_ROUTE_INVENTORY.md` | Current evidence, scope, matrices and remaining work; historical SECURITY_AUDIT.md retained with an appended current section | Reporting |

Before/after: enabled MFA could be overwritten by starting setup; now setup cannot change an enabled factor. Confirmation used to update whichever factor was currently stored; now only the verified pending factor can win once. Webhook wildcards formerly treated `*` as literal text; now the namespace prefix is used. Default startup formerly required an artifact its paired build did not produce; output modes are now explicit.

No schema, migration, lockfile, dependency version, account, production data, or deployment was changed. No push was performed. Existing architecture and features remain in place. New mocks live only in tests and never replace production integrations.
