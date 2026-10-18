# Byato — product demo video (recording + build pipeline)

This folder contains the finished demo package and the tooling that produced
it. Everything was recorded from the **real application** running against an
**isolated, seeded demo database** — no mock-ups, no fabricated API responses,
no production data.

## Deliverables

| File | What it is |
|---|---|
| `byato-demo-1080p.mp4` | **Main deliverable** — 1:53.1, 1920×1080 (16:9), H.264 High / yuv420p, 30 fps, AAC 44.1 kHz stereo, −16.1 LUFS, burned-in English subtitles, English voice-over + subtle music bed |
| `byato-demo-30s.mp4` | **Promotional cut** — 0:28.8, same codec/loudness, cut from the same take |
| `subtitles.srt` | English subtitles for the main video (generated from the real voice-over clips) |
| `byato-demo-30s.srt` | English subtitles for the promotional cut |
| `voiceover-script.md` | The voice-over script, scene by scene, with the exact timings and on-screen text |
| `recording-checklist.md` | Scene-by-scene recording checklist + how every claim was verified |
| `features-demonstrated.md` | The features that are actually demonstrated (with the component that renders each screen) |
| `bugs-and-unavailable-features.md` | Bugs/findings hit while producing the video and the features that could not be recorded |

## Pipeline

```
demo/setup-demo.sh        isolated DB + fictional accounts + MFA enrolment + .env.demo
demo/start-demo-server.sh Next dev server on 0.0.0.0:3000 using .env.demo
demo/clean-demo-audit.py  drop failed-attempt rows left by earlier test runs
demo/record.mjs           drives the real app in Chromium → demo/frames/*.jpg + demo/timing.json
demo/build-video.mjs      frames → 30 fps grid → H.264 + subtitles + VO/music mix → MP4s
```

`demo/browser.mjs` launches the headless Chromium build and `demo/overlay.js`
provides the presentation layer that is injected into the page (title cards,
lower thirds, note chips, the live access-check HUD, the dimmer, the viewport
zoom and the synthetic pointer — headless Chrome paints no cursor).

### Reproduce

```bash
BUN_BIN=/home/user/tooling/node_modules/.bin/bun ./demo/setup-demo.sh
./demo/start-demo-server.sh &
python3 demo/clean-demo-audit.py
LD_LIBRARY_PATH=/tmp/al2023/lib node demo/record.mjs
LD_LIBRARY_PATH=/tmp/al2023/lib node demo/build-video.mjs
```

`LD_LIBRARY_PATH=/tmp/al2023/lib` supplies the shared libraries the bundled
Chromium needs; `demo/browser.mjs` extracts them on first use.

## Data and accounts

The demo database is a throwaway SQLite file (`db/demo.db`, git-ignored) seeded
by `scripts/seed-demo-video.ts` with two business tenants and fictional people.
No production record is read or written, and no real credential is used.

| Account (all fictional, dev-only) | Role | Tenant |
|---|---|---|
| `demo.superadmin@byato.test` | SUPER_ADMIN (TOTP MFA) | platform |
| `demo.hoteladmin@byato.test` | HOTEL_ADMIN | Grand Palace Hotel |
| `demo.manager@byato.test` | RESTAURANT_MANAGER | Saffron Table |
| `demo.waiter@byato.test` | WAITER | Saffron Table |
| `demo.kitchen@byato.test` | KITCHEN_STAFF | Saffron Table |
| `demo.otheradmin@byato.test` | HOTEL_ADMIN | Sea View Resort |

Passwords live only in `.env.demo` / the seed script and are never typed on
screen in clear text (the app masks the field).

## Notes

* The video files, the captured frames and the audio clips are build outputs
  and are git-ignored; the scripts and documentation are not, so the whole
  package can be regenerated from the repository.
* The five "Live access checks" in scene 5 are real HTTP requests against the
  running server. Their labels come from the status codes the server returned
  (`AUTHORIZED` for 200, `ACCESS DENIED` for 202/401/403/404, `CHECK ERROR` for
  anything else) — see `recording-checklist.md`.
