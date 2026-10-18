# Byato — features actually demonstrated in the demo video

Only features that are **implemented in this repository**, were **verified
before recording**, and are **visible in `byato-demo-1080p.mp4`** are listed
here. Nothing on this page is aspirational; the view name in brackets is the
component in `src/components/app/` that renders the screen.

---

## 1. Authentication & identity

| Feature | Where it is shown | Notes |
|---|---|---|
| Two sign-in modes on one screen — *Hotel sign-in* and *Platform admin* | Scene 1 / 3 (`login-screen.tsx`) | Real login form with CSRF-protected API calls |
| Role-filtered navigation | Scene 2 / 3 / 4 (`app-shell.tsx`) | The sidebar differs per role: hotel admin, restaurant manager, platform operator |
| TOTP two-factor authentication (mandatory for platform operators) | Scene 3 (`src/lib/mfa.ts`, `/api/auth/mfa/verify`) | A live RFC 6238 code is generated and accepted during the take; the sign-in only succeeds after the MFA challenge |
| Sign-out | Scene 3 (visible click) | Session is ended from the app shell |
| Platform-scoped session for the platform operator | Scene 3 | The operator sees the multi-tenant control centre, not a tenant workspace |

## 2. Hotel / restaurant operations

| Feature | Where it is shown | Notes |
|---|---|---|
| Operational dashboard (4 stat cards, 14-day visits chart, marketing-consent donut, recent activity) | Scene 2 (`dashboard-view.tsx`) | All figures are computed from the seeded tenant — no hard-coded mock-ups |
| Customer directory with search, consent chips and pagination | Scene 2 (`customers-view.tsx`) | Phone numbers are masked in the list view |
| Customer record: profile, activity timeline, visit history, consent state, guest intelligence | Scene 6 (`customer-profile-view.tsx`) | Full details are revealed to an authorised role inside that hotel |
| Visit recording and customer-visit history | Scene 2 (`visits-view.tsx`) | "Record a visit" and "Add customer" actions are on the dashboard |
| Analytics | Scene 2 (`analytics-view.tsx`) | Retention/repeat-customer views over the tenant's own data |
| Live kitchen display (New / Preparing / Ready columns) | Scene 4 (`kds-view.tsx`) | 3 live orders, auto-refreshing queue |
| Order management | Scene 4 (`orders-view.tsx`) | Order pipeline for the restaurant tenant |
| Digital menu | Scene 4 (`menu-view.tsx`) | The menu the QR ordering flow serves |
| POS terminal: create a bill, split/mixed payment, print receipt, invoice list | Scene 4 (`pos-view.tsx`, `bills-view.tsx`) | A paid bill (`INV/2026-27/000181`, ₹1,345.20) is visible in the recent-bills list |
| Consent-first marketing | Scene 2 / 6 (`customers-view.tsx`, `customer-profile-view.tsx`) | Marketing consent with source, timestamp, channel opt-ins; the UI states that campaigns skip guests who opted out |

## 3. Multi-tenancy & platform administration

| Feature | Where it is shown | Notes |
|---|---|---|
| Platform Control Centre for the platform operator | Scene 3 (`super-admin-saas.tsx`) | Plans & pricing, subscriptions, coupons, feature flags, billing, usage & limits, backups, system health, support sessions, notification templates, platform audit logs, platform settings |
| Security Centre: MFA policy matrix, blocked-IP list, 24 h security counters, recent security events | Scene 3 | MFA is enforced for SUPER_ADMIN in the policy matrix; the counters are read from the audit log |
| Platform settings (operator-side configuration) | Scene 3 (`super-admin-saas.tsx`) | Shown with a zoom on the settings table |
| Tenant separation | Scenes 2 / 4 / 6 | Two independent tenants (*Grand Palace Hotel*, *Saffron Table*) plus a third for the isolation test (*Sea View Resort*); each footer states that guest data stays inside that business |
| Audit trail | Scene 3 (audit-log views behind the nav) | Sign-ins, MFA challenges, customer updates and plan changes are written to `AuditLog` while the take is running |

## 4. Access control & privacy (demonstrated as live HTTP results)

| Feature | Where it is shown | Live result in the take |
|---|---|---|
| Server-side role checks on every request (`src/lib/permissions.ts` → API routes) | Scene 5, check 1 & 2 | Platform settings: **200** for SUPER_ADMIN, **403** for HOTEL_ADMIN |
| Function-level permissions (a waiter may not change menu pricing) | Scene 5, check 3 | `PATCH /api/menu/items/…` → **403** for WAITER |
| Tenant isolation on customer records | Scene 5, check 4 | A foreign customer id → **404** for the other tenant's admin |
| Proof-of-ownership for public QR sign-up (no member data without phone verification) | Scene 5, check 5 | `POST /api/public/join` with an existing member's phone → **202** challenge, `customer` and `loyalty` both `null` |
| Masked contact details in list views, full details inside the record for authorised roles | Scene 6 | List shows `******4432`; the opened record shows the full number |
| MFA enrolment and policy enforcement for platform operators | Scene 3 | Sign-in is blocked until the TOTP challenge is answered |

## 5. Presentation layer produced for this demo

These are not product features; they are the recording/authoring layer, kept
separate from the application code in `demo/`.

| Piece | File | Purpose |
|---|---|---|
| Scene recorder | `demo/record.mjs` | Drives the real app in Chromium, captures a CDP screencast, runs the five live access checks, writes `demo/timing.json` |
| Overlay layer | `demo/overlay.js` | Title cards, lower thirds, note chips, the access-check HUD, the dimmer, the viewport zoom and the synthetic cursor (headless Chrome paints no pointer) |
| Video builder | `demo/build-video.mjs` | Maps the capture onto an exact 30 fps grid, encodes H.264, mixes the voice-over with the music bed, burns the subtitles, and cuts the 33 s promo |
| Voice-over | `demo/audio/vo-s1..s7.mp3` | Seven synthesised English clips, one per scene |
| Music bed | `demo/audio/music.wav` | Original synthesised pad, ≈11 dB under the narration |
| Subtitles | `demo/subtitles.srt`, `demo/byato-demo-30s.srt` | Generated from the real clip durations |
| Demo seed | `scripts/seed-demo-video.ts` | Fictional accounts, the two demo tenants, menu/tables/QR/orders/bills/loyalty data and the MFA enrolment |
| Audit clean-up | `demo/clean-demo-audit.py` | Removes failed-attempt rows left by earlier test runs so the security counters read 0 |
