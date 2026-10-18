/**
 * Byato demo — final video build.
 *
 *   node demo/build-video.mjs
 *
 * Inputs
 *   demo/frames/manifest.json   captured frames (from demo/record.mjs)
 *   demo/timing.json            scene boundaries, subtitle cues, check results
 *   demo/audio/vo-s*.mp3        per-scene voice-over
 * Outputs
 *   demo/byato-demo-1080p.mp4             full demo (H.264, 1920x1080)
 *   demo/byato-demo-30s.mp4                promotional cut
 *   demo/subtitles.srt                     English subtitles
 *   demo/byato-demo-30s.srt                subtitles for the cut
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, linkSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FFMPEG = ffmpegInstaller.path;
const FRAMES = join(HERE, "frames");
const AUDIO = join(HERE, "audio");
const OUT = join(HERE, "out");
const FONT_DIR = "/usr/share/fonts/truetype/dejavu";

mkdirSync(OUT, { recursive: true });

const timing = JSON.parse(readFileSync(join(HERE, "timing.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(FRAMES, "manifest.json"), "utf8"));

const VO_LEAD = 0.35; // narration lead-in after the on-screen cue starts
const VO_GAP = 0.12; // minimum silence between two narration clips
const total = timing.duration;

function run(args, label) {
  process.stdout.write(`→ ${label}\n`);
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
}

/** exact duration of a media file (seconds) */
function durationOf(file) {
  let out = "";
  try {
    out = execFileSync(FFMPEG, ["-hide_banner", "-i", file], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    out = `${e.stdout || ""}${e.stderr || ""}`;
  }
  const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(out);
  if (!m) throw new Error(`could not read duration of ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// ── 1. voice-over placement (drives BOTH the audio mix and the subtitles) ──
const VO_IDS = { s1: "s1", s2: "s2", s3: "s3", s4: "s4", s5: "s5", s6: "s6", s7: "s7" };
const placements = [];
let prevEnd = 0;
for (const scene of timing.scenes) {
  const voId = VO_IDS[scene.id];
  if (!voId) continue;
  const file = join(AUDIO, `vo-${voId}.mp3`);
  if (!existsSync(file)) continue;
  const dur = durationOf(file);
  const cue = timing.cues.find((c) => c.start >= scene.start - 0.25 && c.start < scene.end);
  if (!cue) continue;
  const start = Math.max(cue.start + VO_LEAD, prevEnd + VO_GAP);
  placements.push({ id: voId, file, dur, start, end: start + dur, text: cue.text });
  prevEnd = start + dur;
}
const audioEnd = prevEnd;
const videoLength = Math.max(total, audioEnd + 0.25);
console.log(
  `→ voice-over: ${placements.length} clips, last one ends at ${audioEnd.toFixed(2)}s ` +
    `(video ${total.toFixed(2)}s → output ${videoLength.toFixed(2)}s)`,
);

// ── 2. frames → silent video ─────────────────────────────────────────────
// The screencast delivers frames at irregular intervals (≈50 fps while the
// pointer moves, ≈2 fps while the page is static). Concatenating them with
// the concat demuxer quantises every duration to the image time base and
// the rounding error random-walks by more than a second over a two-minute
// take. Instead every captured frame is mapped onto an exact 30 fps slot
// grid (hard links — no image is copied) and the grid is encoded as a
// constant-frame-rate stream, so the picture stays locked to the scene /
// cue timeline in timing.json and to the voice-over.
const FPS = 30;
const t0 = timing.captureT0 ?? manifest[0].t;
const frames = manifest
  .map((f) => ({ file: f.file, rt: (f.t - t0) / 1000 }))
  .filter((f) => f.rt >= 0);
if (!frames.length) throw new Error("no frames left after re-basing on the capture start");

const slotCount = Math.round(total * FPS);
const slots = new Array(slotCount);
let lastFile = frames[0].file;
for (let i = 0; i < frames.length; i++) {
  const startSlot = Math.min(Math.round(frames[i].rt * FPS), slotCount - 1);
  const nextRt = i + 1 < frames.length ? frames[i + 1].rt : total;
  const endSlot = i + 1 < frames.length ? Math.round(nextRt * FPS) : slotCount;
  for (let s = startSlot; s < Math.max(endSlot, startSlot + 1); s++) {
    if (s < slotCount) slots[s] = frames[i].file;
  }
  lastFile = frames[i].file;
}
for (let s = 0; s < slotCount; s++) if (!slots[s]) slots[s] = lastFile;

const slotDir = join(OUT, "slots");
rmSync(slotDir, { recursive: true, force: true });
mkdirSync(slotDir, { recursive: true });
for (let s = 0; s < slotCount; s++) {
  linkSync(slots[s], join(slotDir, `s${String(s).padStart(5, "0")}.jpg`));
}
console.log(
  `→ ${frames.length} captured frames mapped onto ${slotCount} exact ${FPS} fps slots ` +
    `(${total.toFixed(2)}s)`,
);

const silentVideo = join(OUT, "silent.mp4");
run(
  [
    "-framerate", String(FPS), "-i", join(slotDir, "s%05d.jpg"),
    "-vf", "format=yuv420p",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-r", String(FPS), "-pix_fmt", "yuv420p",
    silentVideo,
  ],
  "encode screen capture (1920x1080, 30 fps)",
);

// ── 3. background music bed (synthesised, subtle) ────────────────────────
const musicFile = join(AUDIO, "music.wav");
if (!existsSync(musicFile)) {
  // Slow four-chord pad: Am – F – C – G, 8 s each, 32 s per cycle.
  const chords = [
    [110.0, 130.81, 164.81, 220.0],
    [87.31, 110.0, 130.81, 174.61],
    [130.81, 164.81, 196.0, 261.63],
    [98.0, 123.47, 146.83, 196.0],
  ];
  const chord = (c) => c.map((f, j) => `${(0.5 / (j + 1)).toFixed(3)}*sin(2*PI*${f}*t)`).join("+");
  const sel = `mod(t,32)`;
  const expr =
    `0.34*if(lt(${sel},8),${chord(chords[0])},` +
    `if(lt(${sel},16),${chord(chords[1])},` +
    `if(lt(${sel},24),${chord(chords[2])},${chord(chords[3])})))` +
    `*(0.55+0.45*sin(2*PI*0.03125*t))` +
    `+0.05*sin(2*PI*523.25*t)*(0.5+0.5*sin(2*PI*0.045*t))`;
  const dur = Math.ceil(videoLength + 2);
  run(
    [
      "-f", "lavfi", "-i", `aevalsrc=exprs='${expr}':s=44100:d=${dur}`,
      "-af",
      `lowpass=f=1400,afade=t=in:st=0:d=3,afade=t=out:st=${dur - 3}:d=3,volume=0.6`,
      "-c:a", "pcm_s16le", musicFile,
    ],
    "synthesise background music bed",
  );
}

// ── 4. voice-over + music mix ────────────────────────────────────────────
// ffmpeg 4.1 has no `amix` normalise switch and always divides by the input
// count, so the voice-over is first assembled into a single exact track with
// the `concat` filter (silence pads between clips), and only then mixed with
// the music bed — with the ×2 compensation that amix=inputs=2 applies.
const gaps = [];
let cursor = 0;
for (const p of placements) {
  gaps.push(Math.max(0, p.start - cursor));
  cursor = p.end;
}
gaps.push(Math.max(0, videoLength - cursor));

const voInputs = [];
placements.forEach((p) => voInputs.push("-i", p.file));
const silenceIndex = placements.length;
const musicIndex = placements.length + 1;
voInputs.push(
  "-f", "lavfi", "-i", `aevalsrc=0:s=44100:d=${videoLength.toFixed(3)}`,
  "-i", musicFile,
);

const parts = [];
placements.forEach((_, i) => {
  parts.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=mono[v${i}]`);
});
parts.push(`[${silenceIndex}:a]asplit=${gaps.length}${gaps.map((_, i) => `[s${i}]`).join("")}`);
gaps.forEach((g, i) => {
  if (g > 0.01) parts.push(`[s${i}]atrim=0:${g.toFixed(3)},asetpts=N/SR/TB[g${i}]`);
});
const concatOrder = [];
placements.forEach((_, i) => {
  if (gaps[i] > 0.01) concatOrder.push(`[g${i}]`);
  concatOrder.push(`[v${i}]`);
});
if (gaps[gaps.length - 1] > 0.01) concatOrder.push(`[g${gaps.length - 1}]`);
parts.push(`${concatOrder.join("")}concat=n=${concatOrder.length}:v=0:a=1[vo]`);
parts.push(`[vo]volume=2.0[vox]`);
parts.push(`[${musicIndex}:a]aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=mono,volume=0.44[mx]`);
parts.push(
  `[vox][mx]amix=inputs=2:duration=longest,alimiter=limit=0.95,volume=1.35,` +
    `apad=whole_len=${Math.round(videoLength * 44100)}[aout]`,
);

const mixFile = join(OUT, "audio-mix.wav");
run(
  [...voInputs, "-filter_complex", parts.join(";"), "-map", "[aout]", "-c:a", "pcm_s16le", mixFile],
  "mix voice-over with background music",
);

// ── 5. subtitles (timed from the real voice-over clips) ──────────────────
function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  const msec = String(ms % 1000).padStart(3, "0");
  return `${h}:${m}:${s},${msec}`;
}
function writeSrt(cues, file) {
  const body = cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join("\n");
  writeFileSync(file, body);
  return cues.length;
}

// libass renders an SRT against a 288-line PlayRes, so the sizes below are
// scaled by 1080/288 = 3.75 when they reach the 1080p frame.
const subtitleStyle = [
  "FontName=DejaVu Sans",
  "FontSize=10",
  "PrimaryColour=&H00FFFFFF",
  "OutlineColour=&H00000000",
  "BackColour=&H90000000",
  "BorderStyle=3",
  "Outline=2",
  "Shadow=0",
  "Alignment=2",
  "MarginV=24",
].join(",");

const fullSrt = join(HERE, "subtitles.srt");
const srtCount = writeSrt(placements, fullSrt);
console.log(`→ wrote ${srtCount} subtitle cues → ${fullSrt}`);

// ── 6. final video ───────────────────────────────────────────────────────
const finalVideo = join(HERE, "byato-demo-1080p.mp4");
run(
  [
    "-i", silentVideo,
    "-i", mixFile,
    "-vf",
    `subtitles=filename=${fullSrt}:fontsdir=${FONT_DIR}:force_style='${subtitleStyle}',` +
      `tpad=stop_mode=clone:stop_duration=3,format=yuv420p`,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "slow", "-crf", "19",
    "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p",
    "-x264-params", "keyint=60:min-keyint=30:scenecut=0",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
    "-movflags", "+faststart",
    "-t", videoLength.toFixed(2),
    finalVideo,
  ],
  "mux + burn subtitles → byato-demo-1080p.mp4",
);

// ── 7. 30-second promotional cut ─────────────────────────────────────────
// The segments are derived from the recorded narration, so every line the
// promo contains is a complete sentence (the security segment deliberately
// stops after the first sentence of the longer scene-5 line).
const vo = (id) => {
  const p = placements.find((x) => x.id === id);
  if (!p) throw new Error(`no voice-over placement for ${id}`);
  return p;
};
const p1 = vo("s1");
const p5 = vo("s5");
const p6 = vo("s6");
const p7 = vo("s7");
const cutPlan = [
  { from: p1.start - 0.3, to: p1.end + 0.3 },
  {
    from: p5.start - 0.3,
    to: p5.start + 4.5,
    // this segment only carries the first sentence of the scene-5 line
    caption: "Role-based access control is enforced on the server for every request.",
  },
  { from: p6.start - 0.4, to: p6.end + 0.4 },
  { from: p7.start - 0.4, to: p7.end + 0.3 },
];
const cutCues = [];
let cutOffset = 0;
for (const seg of cutPlan) {
  for (const p of placements) {
    if (p.end > seg.from && p.start < seg.to) {
      cutCues.push({
        start: cutOffset + Math.max(p.start, seg.from) - seg.from,
        end: cutOffset + Math.min(p.end, seg.to) - seg.from,
        text: seg.caption || p.text,
      });
    }
  }
  cutOffset += seg.to - seg.from;
}
const cutSrt = join(HERE, "byato-demo-30s.srt");
writeSrt(cutCues, cutSrt);

// The cut is rendered from the SILENT master plus the cut audio, and its own
// subtitle file is burned in — slicing the finished video would keep the
// full-length captions of the main render, which no longer match the cut.
const segFiles = [];
const audioSegFiles = [];
for (let i = 0; i < cutPlan.length; i++) {
  const seg = cutPlan[i];
  const dur = seg.to - seg.from;
  const file = join(OUT, `cut-${i}.mp4`);
  run(
    [
      "-ss", seg.from.toFixed(2), "-t", dur.toFixed(2), "-i", silentVideo,
      "-vf", "fps=30,format=yuv420p",
      "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p",
      file,
    ],
    `promo segment ${i + 1}/${cutPlan.length}`,
  );
  segFiles.push(file);

  const audioFile = join(OUT, `cut-audio-${i}.wav`);
  run(
    [
      "-ss", seg.from.toFixed(2), "-t", dur.toFixed(2), "-i", mixFile,
      "-c:a", "pcm_s16le", audioFile,
    ],
    `promo audio segment ${i + 1}/${cutPlan.length}`,
  );
  audioSegFiles.push(audioFile);
}
const cutList = join(OUT, "cut-list.txt");
writeFileSync(cutList, segFiles.map((f) => `file '${f}'`).join("\n") + "\n");
const cutAudioList = join(OUT, "cut-audio-list.txt");
writeFileSync(cutAudioList, audioSegFiles.map((f) => `file '${f}'`).join("\n") + "\n");

const cutVideoJoined = join(OUT, "cut-joined.mp4");
run(["-f", "concat", "-safe", "0", "-i", cutList, "-c", "copy", cutVideoJoined], "join promo picture");
const cutAudioJoined = join(OUT, "cut-audio.wav");
run(["-f", "concat", "-safe", "0", "-i", cutAudioList, "-c", "copy", cutAudioJoined], "join promo audio");

const promoVideo = join(HERE, "byato-demo-30s.mp4");
run(
  [
    "-i", cutVideoJoined,
    "-i", cutAudioJoined,
    "-vf", `subtitles=filename=${cutSrt}:fontsdir=${FONT_DIR}:force_style='${subtitleStyle}',format=yuv420p`,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "slow", "-crf", "19",
    "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
    "-movflags", "+faststart",
    promoVideo,
  ],
  "mux + burn cut subtitles → byato-demo-30s.mp4",
);

console.log("\n✔ build complete");
for (const f of [finalVideo, promoVideo, fullSrt, cutSrt]) {
  const kb = statSync(f).size / 1024;
  console.log(`  ${f.replace(ROOT + "/", "")}  (${kb.toFixed(0)} KB)`);
}
