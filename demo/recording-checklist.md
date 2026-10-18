# Byato — demo recording checklist (scene by scene)

Everything in the final video was captured from the **real application** running
on a local, isolated demo database. This checklist records, scene by scene,
what was on screen, how it was produced, and how each claim was verified.

| | |
|---|---|
| Recording | `demo/record.mjs` (Chromium via CDP screencast) |
| Build | `demo/build-video.mjs` (ffmpeg: frames → 30 fps grid → H.264 + burned subtitles + VO/music mix) |
| Source frames | `demo/frames/` — 2 064 JPEGs + `manifest.json` |
| Scene/cue map | `demo/timing.json` (written by the recorder: scene boundaries, subtitle cues, live check results, absolute capture clock) |
| Raw take | 112.40 s · final render 113.14 s (the tail is held for the last word of the closing line) |
| Final video | `demo/byato-demo-1080p.mp4` — 1920×1080, 16:9, H.264 High @ yuv420p, 30 fps, AAC 44.1 kHz stereo, −16.1 LUFS, true peak −2.9 dBFS |
| Cut | `demo/byato-demo-30s.mp4` — 28.81 s, same codec/loudness, its own burned-in subtitles |

---

## Global checks (apply to every scene)

| # | Check | How it was verified | Result |
|---|---|---|---|
| G1 | The video shows the real app, not a mock-up | Every scene was recorded by driving the running Next.js server with a real browser; no HTML was hand-authored | PASS |
| G2 | Only implemented features are shown | Each screen in the take is reachable by clicking the app's own navigation; no screen was fabricated | PASS |
| G3 | No production data | The recording used a throwaway SQLite file (`db/demo.db`) seeded with synthetic records; the app was started with `STAYLOOP_TEST=1` and a local `DATABASE_URL` | PASS |
| G4 | No real secrets on screen | Only the fictional `demo.*@byato.test` accounts appear; the password field is masked by the app; the TOTP secret never leaves `.dev-mfa-secret` (mode 0600, git-ignored) | PASS |
| G5 | No real customer data | Seeded guests have synthetic names, `@example.com` addresses and synthetic `+91 98…` numbers | PASS |
| G6 | Every status code shown is real | The five access checks are HTTP calls made by the recorder against the live server; the labels are computed from the returned status | PASS |
| G7 | Nothing is presented as a security success that was not one | Labels come from `verdictFor(status)`; any non-2xx/404/202 status is reported as **CHECK ERROR** (amber), never as "AUTHORIZED" | PASS |
| G8 | Frame-accurate A/V sync | Every captured frame is mapped onto an exact 30 fps slot grid; 15/15 sampled frames land on their expected slot (PSNR ≈ 50 dB) | PASS |
| G9 | Subtitles match the narration | `demo/subtitles.srt` is generated from the real voice-over clip durations, not typed by hand | PASS |
| G10 | Readable typography / consistent style | One subtitle style (DejaVu Sans, white on 60 % black box, bottom centre), one lower-third style, one brand-card style, one HUD style | PASS |
| G11 | Smooth cursor, zoom only where needed | The pointer is drawn by the demo overlay (headless Chrome paints none); zoom is used twice, on stat cards and on the platform settings table | PASS |
| G12 | No development artefacts on screen | The Next.js dev indicator is suppressed by the demo overlay CSS; production builds do not render it | PASS |

---

## Scene 1 — Introduction (00:00 → 00:09.8)

- [x] The real sign-in page is used, with the app's own marketing panel on the left and the sign-in form on the right.
- [x] The brand card **BYATO / SMARTER HOSPITALITY MANAGEMENT** sits on the left over a dimmed panel; the sign-in form stays fully readable on the right.
- [x] The pointer is parked away from the corner so it never appears stuck at 0,0.
- [x] The email/password fields are empty at this point — the sign-in happens on camera in scene 2.
- [x] The opening line is spoken **over the brand card**, not over the sign-in form.
- [x] On-screen title matches the brief: "BYATO — Smarter Hospitality Management".

## Scene 2 — Dashboard overview (00:09.8 → 00:26.3)

- [x] Real sign-in as the seeded **Hotel Admin** of *Grand Palace Hotel* (typed on camera, including the submit click).
- [x] Dashboard: 4 stat cards, 14-day visits chart, marketing-consent donut, recent-activity list — all values computed by the app from the seeded tenant.
- [x] Lower third "Dashboard · Grand Palace Hotel · live tenant data".
- [x] Pointer sweep across the stat cards, then a 1.22× zoom on the customer/repeat/visit cards.
- [x] Customers, Visits and Analytics screens shown by clicking the sidebar.
- [x] Note chip "Every number below is tenant-scoped".

## Scene 3 — Platform administration (00:26.3 → 00:48.7)

- [x] Sign-out on camera, then the **Platform admin** tab of the same login screen.
- [x] A **real TOTP challenge**: the recorder computes a live RFC 6238 code from the demo secret and types it into `#mfa-code`; the server accepts it (the MFA secret is enrolled by `scripts/seed-demo-video.ts`).
- [x] Super Admin Control Centre opens; the Security Centre shows the MFA policy matrix (SUPER_ADMIN enforced), the blocked-IP list and the 24 h counters.
- [x] Platform Settings screen shown with a 1.35× zoom on the settings table.
- [x] Lower third "Platform Control Centre · Super Admin · MFA enforced at sign-in".
- [x] The security counters read 0 failed logins / 0 suspicious activity — `demo/clean-demo-audit.py` removes the failed-attempt rows left by earlier test runs before the take (successful sign-ins stay in the audit log).

## Scene 4 — Hotel & restaurant operations (00:48.7 → 01:10.9)

- [x] A **second tenant** — *Saffron Table* (restaurant manager) — is signed in and shown; the sidebar, footer and data are that tenant's only.
- [x] Orders list, live Kitchen Display (New / Preparing / Ready columns with 3 live orders), digital menu and POS terminal.
- [x] Lower third "Saffron Table · Mumbai · Restaurant tenant — separate operational data".
- [x] The app's own footer line "Guest data is private to your restaurant — never shared across restaurants." is visible.

## Scene 5 — Role permissions & security (01:10.9 → 01:28.7)

- [x] The application is dimmed and the **Live access checks** panel is shown.
- [x] Five requests are executed live, one after another; each row appears with the account, the request and the status the server returned.
- [x] Results as rendered in the final video:

| # | Account (role) | Request | Status | Label |
|---|---|---|---|---|
| 1 | demo.superadmin@byato.test (SUPER_ADMIN) | `GET /api/super-admin/settings` | HTTP 200 | AUTHORIZED |
| 2 | demo.hoteladmin@byato.test (HOTEL_ADMIN) | `GET /api/super-admin/settings` | HTTP 403 | ACCESS DENIED |
| 3 | demo.waiter@byato.test (WAITER) | `PATCH /api/menu/items/… price` | HTTP 403 | ACCESS DENIED |
| 4 | demo.otheradmin@byato.test (Sea View Resort) | `GET /api/customers/… (foreign id)` | HTTP 404 | ACCESS DENIED |
| 5 | no session (public QR sign-up) | `POST /api/public/join (member phone)` | HTTP 202 | ACCESS DENIED |

- [x] The 404 for the cross-tenant read is the tenant-isolation answer (the record is not disclosed — the API does not return "not found" content for a foreign id).
- [x] The 202 is explained in the panel footer: a verification challenge was issued and **no member data was disclosed** — it is not presented as a successful read.
- [x] Note chip "All five checks ran against the live server".
- [x] No check is simulated: `demo/record.mjs` performs the HTTP calls and derives the label from the returned status.

## Scene 6 — Customer privacy (01:28.7 → 01:45.1)

- [x] Signed in as the hotel admin; the customer **list** is shown first (phone numbers masked in the list view).
- [x] The privacy line is spoken over the customer list (not over the sign-in), and the record opens as the visual conclusion.
- [x] A customer **record** is opened (full phone, e-mail, activity timeline, visit history, consent state) — this is the "authorized role" side of the story.
- [x] Note chip "Only authorized roles inside this hotel can open a customer record".
- [x] The narration says "aims to keep customer information private" — no compliance or "fully secure" claim is made anywhere in the video.

## Scene 7 — Closing (01:45.1 → 01:53.1)

- [x] Return to the hotel dashboard, dimmed, with the centred end card **BYATO / ONE PLATFORM. BETTER OPERATIONS.**
- [x] Closing line: "Byato — bringing hospitality operations together with clarity, control, and a focus on security."

---

## How to reproduce the take

```bash
# 1. isolated demo environment (throwaway DB, seeded accounts, MFA enrolment)
BUN_BIN=/home/user/tooling/node_modules/.bin/bun ./demo/setup-demo.sh

# 2. start the demo server (0.0.0.0:3000, local .env.demo)
./demo/start-demo-server.sh

# 3. clean stale failed-login rows, then record the 7 scenes
python3 demo/clean-demo-audit.py
LD_LIBRARY_PATH=/tmp/al2023/lib node demo/record.mjs

# 4. build the MP4s + subtitles
LD_LIBRARY_PATH=/tmp/al2023/lib node demo/build-video.mjs
```

## Machine-readable evidence

* `demo/timing.json` — `scenes[]` (start/end per scene), `cues[]` (subtitle cues), `securityChecks[]` (who / method / path / status / verdict), `timeline[]` (every recorded action with its timestamp), `captureT0` (absolute clock used to align the render).
* `demo/frames/manifest.json` — every captured frame with its absolute timestamp.
* `demo/subtitles.srt` / `demo/byato-demo-30s.srt` — subtitle files generated from the real voice-over clips.
