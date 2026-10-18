# Byato — bugs, findings and features that could not be recorded

Two separate lists:

* **A — issues found while producing this demo** (encountered, diagnosed, and
  either fixed in the demo tooling or left as a product finding).
* **B — could not be demonstrated** (features that exist but could not be
  recorded honestly in this environment, plus findings that are already on
  record in the repository's own audit documents).

Nothing in this document is presented in the video as a success.

---

## A. Issues found while producing the demo

### A1 — The public QR sign-up endpoint rate-limits per phone (3 / 60 s)

* **Where:** `src/app/api/public/join/route.ts` — `checkRateLimit("public-join-phone:${hotelId}:${phone}", 3, 60_000)`.
* **What happened:** the fifth access check (anonymous visitor → existing
  member's phone) returned **HTTP 429 – "This number was used too many times
  just now"** on the first takes, because earlier test runs had already spent
  the per-phone budget for the synthetic numbers.
* **Why it matters:** a 429 is a rate-limit artefact, not an access-control
  result. Reporting it as "ACCESS DENIED" would have been wrong, and reporting
  it as a success would have been worse.
* **Resolution in the demo tooling:** `demo/record.mjs` now walks the four
  seeded synthetic member numbers until the endpoint answers with a real
  result and skips any 429. The final take shows the true **HTTP 202**
  challenge response.
* **Product impact:** none — the per-phone limit is the intended spam control.
  It does mean a demo that is re-run repeatedly needs fresh synthetic numbers
  (or a 60 s wait).

### A2 — Brand inconsistency: the UI says "Beyto", the product is "Byato"

* **Where:** `src/app/layout.tsx` (title "Beyto — Restaurant CRM, Loyalty & QR
  Ordering"), the app shell logo, the login-page panel and the footer
  ("© 2026 Beyto · Restaurant CRM & Ordering").
* **What happened:** the brief's on-screen title is **BYATO**, but the running
  application is branded **Beyto**. Both wordmarks are visible in the video
  (title card vs. app chrome).
* **Resolution:** the application was **not** modified for the recording — the
  video must show the real product. The title cards follow the brief
  ("BYATO"), and the discrepancy is flagged here for a product decision
  (rename the UI to Byato, or align the marketing name to Beyto).
* **Severity:** cosmetic/branding, but visible to every viewer.

### A3 — The sign-in page copy is restaurant-only

* **Where:** `src/components/app/login-screen.tsx` — "Turn one-time guests
  into loyal regulars", "Sign in to manage your restaurant's guests and
  visits".
* **What happened:** the platform is presented as hotel **and** restaurant
  management, but the first screen a viewer sees talks only about restaurants.
* **Resolution:** not changed for the take (the recording must show the real
  screen). Recommended: hotel-aware copy on the sign-in panel.

### A4 — Platform Security Centre has no empty state for "Recent security events"

* **Where:** `src/components/app/super-admin-saas.tsx` — the table renders
  `overview.recentEvents.map(...)` with no fallback row.
* **What happened:** after the stale failed-login rows were removed
  (`demo/clean-demo-audit.py`), the table renders with its header row only —
  a visible empty box in the scene-3 shot.
* **Recommendation:** add an explicit "No security events in this period" row.

### A5 — Development-mode artefacts (demo environment, not product)

* **Next.js dev indicator** appears in the bottom-left corner in `next dev`.
  The demo overlay hides it with `nextjs-portal { display: none }`; a
  production build does not render it.
* **No emoji font in the headless container:** the dashboard greeting
  ("Welcome back, Ira 👋") rendered as an empty box. The demo serves
  `Noto Color Emoji` from `public/demo-assets/` and registers it under the
  family name the application's CSS already falls back to
  (`demo/overlay.js`). On a normal desktop the OS emoji font is used, so this
  is an environment gap, not a product bug.

### A6 — Observation: the two-factor code is visible while it is typed

The sign-in form masks the password, but the 6-digit TOTP is shown in clear
text while it is entered (scene 3, ~00:33–00:39). The code belongs to a
throwaway demo account and expires every 30 s, so nothing usable is exposed;
still, masking the 2FA field (or clearing it immediately after submit) is a
cheap hardening improvement and avoids normalising a bad habit in demo
material.

### A7 — Observation: contact details are fully revealed inside a customer record

In the customer list the phone number is masked (the list shows `******4432` — last four digits only); opening the
record as an authorised role of that hotel shows the full number and e-mail.
This is the intended behaviour (and the point of scene 6), but it is worth a
data-minimisation review for roles that do not need the full contact details.

---

## B. Features that could not be demonstrated

| # | Feature | Why it could not be shown honestly |
|---|---|---|
| B1 | Real SMS / WhatsApp / e-mail delivery of the QR sign-up code | No provider is configured; the endpoint issues the OTP in **simulation mode** (the audit row records `otpSimulated: true, otpDelivered: "SIMULATION"`). The video therefore shows the challenge response, not a delivered message. |
| B2 | Marketing campaign delivery (campaigns, segments, templates, automations) | The views exist (`campaigns-view.tsx`, `segments-view.tsx`, `templates-view.tsx`, `automations-view.tsx`) but sending depends on the same missing messaging providers; showing the send button would imply a delivery that does not happen. |
| B3 | Payment-provider handshake, refunds, split-payment settlement | The POS flow records bills and marks them paid in the local database, but no gateway is integrated in this environment, so no real charge or refund can be demonstrated. |
| B4 | Public self-service registration / "Register your restaurant" journey | Not recorded: it is a separate onboarding path and was not needed for the seven-scene brief. The endpoint itself was exercised as check 5. |
| B5 | Platform "coming soon" screens | Not an obstacle: all 53 navigation ids in `app-shell.tsx` map to implemented views — the `ComingSoonView` fallback in `src/app/page.tsx` is currently unreachable from the navigation. |
| B6 | Mobile / responsive layout | The demo is recorded in a 1920×1080 desktop Chromium; the mobile breakpoints were not exercised. |
| B7 | Accessibility, network-failure and offline behaviour | Not exercised; the recorder drove a healthy local server. |
| B8 | Production PostgreSQL behaviour | The Prisma native engine cannot be downloaded in this environment, so the demo runs on the SQLite/libsql adapter with `STAYLOOP_TEST=1` and a local `DATABASE_URL`. Migrations, isolation and concurrency on the production database were not exercised. |
| B9 | Backup / restore, exports, scheduled jobs | Require the production storage and scheduler; only the backup/session *screens* are shown, never a real restore. |

---

## C. Findings already on record in this repository (not re-verified for this demo)

These come from the repository's own audit documents and are reproduced here
because they limit what the video can honestly claim. They were **not**
re-tested in this session — see the source documents for their status lines.

* **`REMAINING_ISSUES.md` §B — AUD-006 (rated High upstream):** five vulnerable
  development-package entries in a single `braces` advisory chain. No runtime
  advisories are reported; a compatible patch was not available from the
  inspected latest `braces` version, and the file explicitly warns against a
  blind `npm audit fix --force` downgrade.
* **`REMAINING_ISSUES.md` §C — risks not reproduced:** DNS-res rebinding /
  egress enforcement in `src/lib/webhooks-out.ts`; a step-up backup-code check
  that is separate from the later disable/regenerate write in
  `src/lib/mfa.ts`; handlers that still use raw `req.json()`/`text()` instead
  of the shared capped body reader; the dev/test missing-file fallback in
  `src/lib/db.ts` that can select an existing demo database.
* **`REMAINING_ISSUES.md` §E/F — blocked or unverified:** native Prisma
  download; the SQLite full suite; live PostgreSQL migrations and isolation;
  Redis coordination; Docker images/Compose; complete browser / mobile /
  accessibility / network-failure flows; e-mail, SMS and WhatsApp delivery;
  payment-provider handshakes and refunds; production DNS/TLS/storage/backup
  restore.
* **`BUGS_FOUND.md`:** AUD-001 … AUD-005 are recorded as fixed, but several of
  their verification lines say so explicitly — e.g. "HTTP integration NOT
  VERIFIED", "actual PostgreSQL contention NOT VERIFIED", "actual delivery NOT
  VERIFIED", "live database concurrency NOT VERIFIED". A demo that shows the
  feature working in the UI is therefore not evidence that those conditions
  are closed.

### What the video does *not* claim

* No regulatory claim (GDPR, DPDP, PCI) and no "compliant"/"certified" wording.
* No claim of a complete security posture, penetration test or bug bounty.
* No claim that the five access checks exhaust the application's attack
  surface — they are five representative, reproducible server-side checks.
* The word **"AUTHORIZED"** always refers to one specific request that
  returned HTTP 200, and **"ACCESS DENIED"** to one specific request that
  returned 202/401/403/404.
