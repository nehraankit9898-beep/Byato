# Remaining issues and approval boundaries — 2026-10-17

## B. Confirmed but not fixed
- **AUD-006 (High upstream rating):** five vulnerable development-package entries in a single braces advisory chain. No runtime advisories reported. A compatible patch was not available from the inspected latest braces version; do not blindly downgrade Next tooling with audit --force.

## C. Potential risks, not reproduced (not counted as confirmed findings)
- `src/lib/webhooks-out.ts`: DNS is checked before a separate fetch resolution; review DNS rebinding resistance and egress enforcement with controlled DNS infrastructure. No external target was probed.
- `src/lib/mfa.ts`: step-up backup-code check and the later disable/regenerate write are separate operations; review cross-operation races and challenge invalidation after password/session revocation. Not reproduced in this pass.
- Some handlers use raw req.json()/text() instead of shared capped body reading (e.g. bootstrap after secret verification). Inventory body limits, including reverse-proxy limits, before asserting uniform request limits.
- `src/lib/db.ts`: dev/test missing-file fallback can select an existing demo DB. Tests precreate isolated files, and production rejects SQLite; verify no other test tool can touch a developer DB.
- Filesystem-tracing warning in the production compile can enlarge output. Measure standalone size before changing path-resolution behavior.
- Serverless workers, exports/backups, integration state and persistent storage must match the chosen actual hosting configuration.
- Historical audit files contain claims that are stale; for example the older inventory generator still emits a statement that custom roles are not enforced, while current requireAuth resolves them. Current reports explicitly supersede those claims; historical files were not globally rewritten.

## E/F. Blocked or unverified
Native Prisma download; SQLite full suite; live PostgreSQL migrations/isolation; Redis coordination; Docker images/Compose; complete browser/mobile/accessibility/network-failure flows; email/SMS/WhatsApp delivery; payment provider handshakes/refunds; production DNS/TLS/storage/backup restore. See FEATURE_TEST_MATRIX.md and AUDIT_REPORT.md. Repository-wide discovery is complete at inventory level, but exhaustive semantic review and end-to-end verification are NOT complete.

## G. Requires operator input / approval
- Choose the actual production host and provide authorized staging service access/configuration through secure environment settings (not chat secrets).
- Approve any actual account bootstrap, data migration, dependency downgrade/replacement, deployment, restore or payment/refund test with real effects.
- Supply native-engine network availability or an approved engine cache, disposable PG/Redis and browser E2E infrastructure; these enable continued testing without production access.
- Approve release only after the deployment gates pass. No real accounts were created, deleted, promoted or suspended, no data migrated, and no changes pushed/deployed.
