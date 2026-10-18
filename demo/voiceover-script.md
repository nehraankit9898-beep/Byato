# Byato — demo voice-over script

English narration for the Byato product demo, scene by scene. Every line below
is the **exact** text that is spoken in `byato-demo-1080p.mp4`; the timings are
taken from the final render (`demo/subtitles.srt`), which is generated from the
real voice-over clips, not hand-typed.

| | |
|---|---|
| Video | `demo/byato-demo-1080p.mp4` — 1:53.1, 1920×1080, 30 fps |
| Promotional cut | `demo/byato-demo-30s.mp4` — 0:28.8 |
| Subtitles | `demo/subtitles.srt` (full) · `demo/byato-demo-30s.srt` (cut) |
| Voice | synthesised English narration voice (`voice-00`), 44.1 kHz mono, mixed to stereo |
| Music | original synthesised ambient pad (Am–F–C–G, 8 s per chord), ≈11 dB below the narration — deliberately non-dominant |
| Loudness | −16.1 LUFS integrated, true peak −2.9 dBFS |

---

## Scene 1 — Introduction · 00:00 → 00:09.8

**On screen:** the real Byato sign-in page (hotel sign-in / platform admin tabs)
with the **BYATO** brand card on the left, the sign-in form on the right.

> **VO (00:01.81 – 00:08.63)**
> "Meet Byato — a unified platform designed to simplify hotel and restaurant management."

**On-screen title:** `BYATO` · *SMARTER HOSPITALITY MANAGEMENT* · "Hotel & restaurant management, in one platform"

---

## Scene 2 — Dashboard overview · 00:09.8 → 00:26.3

**On screen:** the authenticated hotel dashboard of *Grand Palace Hotel* — four
stat cards, a 14-day visits chart, the marketing-consent donut, recent
activity — then the Customers, Visits and Analytics screens.

> **VO (00:12.09 – 00:20.06)**
> "Manage your hospitality operations through one centralized workspace, with visibility into the features available to your role."

**Lower third:** "Dashboard" · "Grand Palace Hotel · live tenant data"

---

## Scene 3 — Platform administration · 00:26.3 → 00:48.7

**On screen:** sign-out, the *Platform admin* tab, a real TOTP two-factor
challenge, then the Super Admin Control Centre (Security Centre with the MFA
policy, blocked-IP list and security counters; Platform Settings).

> **VO (00:26.67 – 00:34.97)**
> "Platform administrators can manage authorized platform-level settings, while access controls help protect sensitive operations."

**Lower third:** "Platform Control Centre" · "Super Admin · MFA enforced at sign-in"

---

## Scene 4 — Hotel & restaurant operations · 00:48.7 → 01:10.9

**On screen:** a second tenant (*Saffron Table*, restaurant manager) — Orders,
the live Kitchen Display, the digital menu, the POS terminal. The footer of the
app reads "Guest data is private to your restaurant — never shared across
restaurants."

> **VO (00:49.01 – 00:56.67)**
> "Hotel and restaurant teams can work within their authorized areas, keeping their operational data separate from other businesses."

**Lower third:** "Saffron Table · Mumbai" · "Restaurant tenant — separate operational data"

---

## Scene 5 — Role permissions & security · 01:10.9 → 01:28.7

**On screen:** a dark-tinted application view with the **Live access checks**
panel. Five requests are executed against the running server while the video
plays; each row shows the account, the request and the HTTP status that the
server actually returned.

> **VO (01:11.22 – 01:25.07)**
> "Role-based access control is enforced on the server for every request. Platform settings stay with platform administrators, pricing changes stay with managers, and one business can never read another business's customer records."

| # | Account | Request | Result on screen |
|---|---|---|---|
| 1 | Platform Operator (SUPER_ADMIN) | `GET /api/super-admin/settings` | **HTTP 200 — AUTHORIZED** |
| 2 | Hotel Admin (HOTEL_ADMIN) | `GET /api/super-admin/settings` | **HTTP 403 — ACCESS DENIED** |
| 3 | Waiter (WAITER) | `PATCH /api/menu/items/… price` | **HTTP 403 — ACCESS DENIED** |
| 4 | Hotel Admin, other tenant (Sea View Resort) | `GET /api/customers/… (foreign id)` | **HTTP 404 — ACCESS DENIED** |
| 5 | Anonymous visitor (no session) | `POST /api/public/join (member phone)` | **HTTP 202 — ACCESS DENIED** (verification challenge issued, no member data disclosed) |

The labels are derived from the real status codes at record time; nothing in the
panel is mocked. See `recording-checklist.md` for the evidence file.

---

## Scene 6 — Customer privacy · 01:28.7 → 01:45.1

**On screen:** the hotel admin's customer list (phone numbers masked in the
list) and an opened customer record (full details, activity timeline, visit
history, marketing-consent state).

> **VO (01:36.96 – 01:44.57)**
> "Byato's access-control design aims to keep customer information private and limit access to authorized users."

**Note chip:** "Only authorized roles inside this hotel can open a customer record"

> The line deliberately says *aims to* — the video does not claim regulatory
> compliance, a complete security posture, or penetration-test coverage.

---

## Scene 7 — Closing · 01:45.1 → 01:53.1

**On screen:** the hotel dashboard, dimmed, with the centred end card.

> **VO (01:45.41 – 01:52.87)**
> "Byato — bringing hospitality operations together with clarity, control, and a focus on security."

**End card:** `BYATO` · *ONE PLATFORM. BETTER OPERATIONS.* · "Byato — hotel & restaurant management"

---

## Promotional cut (0:28.8)

The cut is assembled from the same recording; every line it contains is a
complete sentence.

| Cut time | Content | Narration |
|---|---|---|
| 00:00 – 00:07.4 | brand card over the sign-in page | "Meet Byato — a unified platform designed to simplify hotel and restaurant management." |
| 00:07.4 – 00:12.6 | live access-check panel (the first result appears live) | "Role-based access control is enforced on the server for every request." (first sentence of the scene-5 line) |
| 00:12.6 – 00:20.6 | customer list with masked phone numbers | "Byato's access-control design aims to keep customer information private and limit access to authorized users." |
| 00:20.6 – 00:28.8 | closing end card over the dimmed dashboard | "Byato — bringing hospitality operations together with clarity, control, and a focus on security." |

## Recording notes (why the wording is what it is)

* **No compliance claims.** Scene 6 says "aims to keep … private" rather than
  "is GDPR compliant" or "is fully secure" — the demo shows a *design intent*
  plus five verified server responses, not a certification.
* **No security absolutes.** The access-check panel is labelled "Real HTTP
  responses", and the 202 result is spelled out in the panel footer so a
  viewer cannot mistake a verification challenge for a successful read.
* **No invented numbers.** Every figure on screen comes from the seeded demo
  database (Grand Palace Hotel, Saffron Table, Sea View Resort) — the
  statistics are computed by the app, never typed into a mock-up.
* **Fictional businesses only.** *Grand Palace Hotel*, *Saffron Table* and
  *Sea View Resort* are demo tenants created by `scripts/seed-demo-video.ts`;
  customer names, `@example.com` addresses and phone numbers are synthetic.
