/**
 * Byato product demo — screen recorder.
 *
 * Drives the REAL running Byato application in Chromium and captures every
 * scene to JPEG frames (CDP screencast). No UI is faked: every click, login,
 * MFA code and API status shown in the video comes from the live app.
 *
 *   node demo/record.mjs [--out demo/frames] [--base http://localhost:3000]
 *
 * Writes:
 *   <out>/fXXXXX.jpg      captured frames (global order)
 *   <out>/manifest.json   frame -> timestamp map
 *   demo/timing.json      scene boundaries + subtitle cues for the build step
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { launch } from "./browser.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = arg("base", "http://localhost:3000");
const OUT = resolve(ROOT, arg("out", "demo/frames"));
const SHOTS = resolve(ROOT, arg("shots", "demo/frames"));
const MFA_SECRET_FILE = resolve(ROOT, ".dev-mfa-secret");

const ACCOUNTS = {
  hotel: { email: "demo.hoteladmin@byato.test", password: "DemoHotelAdmin@2026", label: "Hotel Admin · Grand Palace Hotel" },
  super: { email: "demo.superadmin@byato.test", password: "DemoSuper@2026", label: "Super Admin · Platform Control Centre" },
  manager: { email: "demo.manager@byato.test", password: "DemoManager@2026", label: "Restaurant Manager · Saffron Table" },
  waiter: { email: "demo.waiter@byato.test", password: "DemoWaiter@2026", label: "Waiter · Saffron Table" },
  other: { email: "demo.otheradmin@byato.test", password: "DemoOtherAdmin@2026", label: "Hotel Admin · Sea View Resort" },
  staff: { email: "demo.staff@byato.test", password: "DemoStaff@2026", label: "Hotel Staff · Grand Palace Hotel" },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── TOTP (RFC 6238) so the recorder can complete the real MFA challenge ──
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(input) {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error("bad base32 secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = createHmac("sha1", secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    digest[offset + 3];
  return (code % 10 ** 6).toString().padStart(6, "0");
}
const totp = (secret, at = Date.now()) => hotp(base32Decode(secret), Math.floor(at / 1000 / 30));

// ── capture ───────────────────────────────────────────────────────────────
class Capture {
  constructor(dir) {
    this.dir = dir;
    this.frames = [];
    this.t0 = null;
    this.session = null;
    this.page = null;
  }
  async attach(page) {
    this.page = page;
    if (this.t0 === null) this.t0 = Date.now();
    this.session = await page.createCDPSession();
    this.session.on("Page.screencastFrame", async (params) => {
      try {
        await this.session.send("Page.screencastFrameAck", { sessionId: params.sessionId });
      } catch {
        /* session closed */
      }
      const idx = this.frames.length;
      const file = join(this.dir, `f${String(idx).padStart(5, "0")}.jpg`);
      this.frames.push({ file, t: params.metadata?.timestamp ? params.metadata.timestamp * 1000 : Date.now() });
      writeFileSync(file, Buffer.from(params.data, "base64"));
    });
    await this.session.send("Page.startScreencast", {
      format: "jpeg",
      quality: 88,
      everyNthFrame: 1,
      maxWidth: 1920,
      maxHeight: 1080,
    });
  }
  async detach() {
    try {
      await this.session.send("Page.stopScreencast");
    } catch {
      /* noop */
    }
  }
  save() {
    writeFileSync(join(this.dir, "manifest.json"), JSON.stringify(this.frames, null, 1));
  }
}

// ── driver ────────────────────────────────────────────────────────────────
class Driver {
  constructor(page, capture) {
    this.page = page;
    this.capture = capture;
    this.timeline = [];
    this.cues = [];
    this.scenes = [];
    this.scene = null;
  }
  get now() {
    return (Date.now() - this.capture.t0) / 1000;
  }
  mark(label) {
    this.timeline.push({ t: +this.now.toFixed(2), label });
    console.log(`  [${this.now.toFixed(2).padStart(6)}s] ${label}`);
  }
  startScene(id, title, vo) {
    this.scene = { id, title, start: +this.now.toFixed(2), end: null, vo: vo || null };
    this.scenes.push(this.scene);
    this.mark(`scene ${id} — ${title}`);
  }
  endScene() {
    if (this.scene) this.scene.end = +this.now.toFixed(2);
    this.scene = null;
  }
  /** subtitle cue: text shown from now for `dur` seconds */
  say(text, dur) {
    this.cues.push({ start: +this.now.toFixed(2), end: +(this.now + dur).toFixed(2), text });
  }
  async wait(ms) {
    await sleep(ms);
  }
  /** Wait while keeping the compositor alive (the screencast only emits a
   *  frame when something changes, so a fully static stretch would be held
   *  as a single still). */
  async waitWithMotion(ms, every = 450) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await sleep(Math.min(every, end - Date.now()));
      await this.jiggle();
    }
  }
  async mouseTo(x, y, steps = 26) {
    this.lastPoint = { x, y };
    await this.page.mouse.move(x, y, { steps });
  }
  /** move the pointer to an element and click it */
  async clickSelector(selector, { nth = 0, hold = 90 } = {}) {
    const els = await this.page.$$(selector);
    if (!els[nth]) throw new Error(`selector not found: ${selector} [${nth}]`);
    const box = await els[nth].boundingBox();
    if (!box) throw new Error(`no box for ${selector}`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await this.mouseTo(x, y);
    await sleep(120);
    await this.page.mouse.click(x, y);
    await sleep(hold);
  }
  /** click an element whose visible text matches exactly */
  async clickText(text, { nth = 0, hold = 120, exact = true } = {}) {
    const handle = await this.page.evaluateHandle(
      (t, ex, n) => {
        const nodes = [...document.querySelectorAll("button, a, [role=button], li, td, span, div, h1, h2, h3, p")];
        const hits = nodes
          .filter((n) => {
            const s = (n.innerText || "").trim();
            if (!s) return false;
            return ex ? s === t : s.toLowerCase().includes(t.toLowerCase());
          })
          .filter((n) => {
            const r = n.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          .sort((a, b) => {
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            return ra.width * ra.height - rb.width * rb.height;
          });
        return hits[n] || null;
      },
      text,
      exact,
      nth,
    );
    const el = handle.asElement();
    if (!el) throw new Error(`text not found: ${text}`);
    await el.evaluate((n) => n.scrollIntoView({ block: "center" }));
    await sleep(120);
    const box = await el.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await this.mouseTo(x, y);
    await sleep(140);
    await this.page.mouse.click(x, y);
    await sleep(hold);
  }
  async typeInto(selector, text, { delay = 26 } = {}) {
    await this.clickSelector(selector, { hold: 60 });
    await this.page.keyboard.type(text, { delay });
  }
  async overlay(fn, ...args) {
    await this.page.evaluate(
      (f, a) => {
        const api = window.__byato__;
        if (api && api[f]) api[f](...a);
      },
      fn,
      args,
    );
    await this.jiggle();
  }
  /** Nudge the pointer so the compositor produces a frame right after an
   *  overlay change (the screencast only emits frames on visual change). */
  async jiggle() {
    const p = this.lastPoint || { x: 1200, y: 700 };
    await this.page.mouse.move(p.x + 2, p.y + 1);
    await this.page.mouse.move(p.x, p.y);
  }
  /** Click a sidebar navigation item (the app also shows these words in the
   *  page body — e.g. the "Customers" stat card — so the sidebar is scoped). */
  async clickNav(label) {
    const handle = await this.page.evaluateHandle((t) => {
      const nav = document.querySelector("aside") || document.querySelector("nav");
      if (!nav) return null;
      const nodes = [...nav.querySelectorAll("button, a, [role=button]")];
      const hits = nodes
        .filter((n) => (n.innerText || "").trim() === t)
        .filter((n) => n.getClientRects().length > 0);
      return hits[0] || null;
    }, label);
    const el = handle.asElement();
    if (!el) throw new Error(`nav item not found: ${label}`);
    await el.evaluate((n) => n.scrollIntoView({ block: "center" }));
    await sleep(120);
    const box = await el.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await this.mouseTo(x, y);
    await sleep(140);
    await this.page.mouse.click(x, y);
    await sleep(140);
  }
  /** Click the first row of the main table (used for a customer profile). */
  async clickFirstTableRow() {
    const rows = await this.page.$$("tbody tr");
    if (!rows.length) throw new Error("no table rows found");
    const box = await rows[0].boundingBox();
    const x = box.x + Math.min(box.width / 2, 220);
    const y = box.y + box.height / 2;
    await this.mouseTo(x, y);
    await sleep(160);
    await this.page.mouse.click(x, y);
    await sleep(200);
  }
  /** The sidebar keeps most destinations behind "More tools" — open it once. */
  async ensureExpanded(probe = "Kitchen Display") {
    const visible = await this.page.evaluate((t) => {
      const el = [...document.querySelectorAll("button, a, span, div")].find(
        (n) => (n.innerText || "").trim() === t && n.getClientRects().length > 0,
      );
      return !!el;
    }, probe);
    if (!visible) {
      await this.clickText("More tools", { hold: 500 });
      await this.wait(600);
    }
  }
  async shot(name) {
    await this.page.screenshot({ path: join(SHOTS, `${name}.png`) });
  }
}

// ── live API helpers (used by the security scene) ────────────────────────
async function apiCall(page, { method = "GET", path, body, token }) {
  return page.evaluate(
    async (m, p, b, tok) => {
      const headers = { "Content-Type": "application/json" };
      if (tok) headers.Authorization = `Bearer ${tok}`;
      const res = await fetch(p, {
        method: m,
        headers,
        // No cookies: the Bearer token alone authenticates, so the app's own
        // session in the page is never disturbed by the checks.
        credentials: "omit",
        body: b === null || b === undefined ? undefined : JSON.stringify(b),
      });
      let payload = null;
      const text = await res.text();
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text.slice(0, 200) };
      }
      return { status: res.status, payload };
    },
    method,
    path,
    body ?? null,
    token ?? null,
  );
}

async function loginToken(page, { email, password, platform = false, totpCode = null }) {
  const res = await page.evaluate(
    async (e, p, plat) => {
      const r = await fetch(plat ? "/api/super-admin/login" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify({ email: e, password: p }),
      });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, body: j };
    },
    email,
    password,
    platform,
  );
  if (res.body?.mfaRequired) {
    if (!totpCode) throw new Error("MFA required but no code supplied");
    const v = await page.evaluate(
      async (mfaToken, code) => {
        const r = await fetch("/api/auth/mfa/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "omit",
          body: JSON.stringify({ mfaToken, code }),
        });
        const j = await r.json().catch(() => ({}));
        return { status: r.status, body: j };
      },
      res.body.mfaToken,
      totpCode,
    );
    if (v.status !== 200) throw new Error(`MFA verify failed: ${v.status}`);
    return v.body.sessionToken || v.body.token;
  }
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
  return res.body.sessionToken || res.body.token;
}

/** Super-admin login for the HUD: retries in the next TOTP window if the
 *  current time-step was already consumed (replay protection). */
async function superToken(page, secret) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await loginToken(page, {
        email: ACCOUNTS.super.email,
        password: ACCOUNTS.super.password,
        platform: true,
        totpCode: totp(secret),
      });
    } catch (err) {
      if (attempt === 1) throw err;
      const now = Date.now();
      const next = Math.ceil((now + 1000) / 30000) * 30000;
      await sleep(next - now + 600);
    }
  }
  throw new Error("super admin login failed");
}

// ── run ───────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(MFA_SECRET_FILE)) {
    throw new Error("Missing .dev-mfa-secret — run ./demo/setup-demo.sh first.");
  }
  const mfaSecret = readFileSync(MFA_SECRET_FILE, "utf8").trim();

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const browser = await launch();
  const capture = new Capture(OUT);
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  PAGE ERROR:", String(e).slice(0, 160)));
  await page.evaluateOnNewDocument(readFileSync(join(HERE, "overlay.js"), "utf8"));
  await page.goto(BASE, { waitUntil: "networkidle2" });
  await capture.attach(page);

  const d = new Driver(page, capture);
  const log = (m) => console.log(m);

  // ═══════════════ SCENE 1 — introduction ═══════════════
  d.startScene("s1", "Introduction", "s1");
  await d.wait(700);
  // Park the pointer away from the corner so it never appears stuck at 0,0.
  await d.mouseTo(1180, 640, 30);
  await d.say(
    "Meet Byato — a unified platform designed to simplify hotel and restaurant management.",
    7.0,
  );
  await d.overlay("card", true, {
    tag: "Smarter Hospitality Management",
    sub: "Hotel & restaurant management, in one platform",
    pos: "left",
  });
  await d.mark("brand card in");
  await d.wait(3200);
  await d.overlay("card", false);
  await d.mark("brand card out");
  await d.typeInto("#email", ACCOUNTS.hotel.email, { delay: 13 });
  await d.wait(250);
  await d.typeInto("#password", ACCOUNTS.hotel.password, { delay: 13 });
  await d.wait(400);
  const signIn = await page.evaluateHandle(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /sign in/i.test(x.innerText || ""));
    return b || null;
  });
  const sBox = await signIn.asElement().boundingBox();
  await d.mouseTo(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
  await d.wait(600);
  d.endScene();

  // ═══════════════ SCENE 2 — dashboard overview ═══════════════
  d.startScene("s2", "Dashboard overview", "s2");
  await page.mouse.click(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
  await d.mark("signed in");
  await d.wait(1900);
  await d.say(
    "Manage your hospitality operations through one centralized workspace, with visibility into the features available to your role.",
    10.5,
  );
  await d.overlay("lower", true, "Dashboard", "Grand Palace Hotel · live tenant data");
  // sweep across the stat cards, then zoom in
  await d.mouseTo(700, 235, 40);
  await d.wait(400);
  await d.mouseTo(1200, 235, 40);
  await d.overlay("zoom", 1.22, 900, 235);
  await d.wait(1100);
  await d.overlay("zoom", 1);
  await d.wait(250);
  await d.overlay("lower", false);
  await d.clickNav("Customers");
  await d.mark("customers view");
  await d.wait(1000);
  await d.overlay("zoom", 1.3, 700, 300);
  await d.wait(1300);
  await d.overlay("zoom", 1);
  await d.wait(400);
  await d.clickNav("Visits");
  await d.mark("visits view");
  await d.wait(1100);
  await d.clickNav("Analytics");
  await d.mark("analytics view");
  await d.wait(1800);
  await d.overlay("note", true, "Every number below is tenant-scoped", "green");
  await d.wait(1100);
  await d.overlay("note", false);
  d.endScene();

  // ═══════════════ SCENE 3 — super admin ═══════════════
  d.startScene("s3", "Super Admin", "s3");
  await d.say(
    "Platform administrators can manage authorized platform-level settings, while access controls help protect sensitive operations.",
    9.5,
  );
  await d.clickSelector('button[aria-label="Sign out"]', { hold: 300 });
  await d.mark("signed out");
  await d.wait(1200);
  await d.clickText("Platform admin");
  await d.mark("platform tab");
  await d.wait(400);
  await d.typeInto("#email", ACCOUNTS.super.email, { delay: 13 });
  await d.wait(220);
  await d.typeInto("#password", ACCOUNTS.super.password, { delay: 13 });
  await d.wait(350);
  await d.clickText("Sign in as super admin");
  await d.mark("submitted super admin sign-in");
  await d.wait(1400);
  // real MFA challenge — compute a fresh TOTP for the current step
  const secret = mfaSecret;
  let code = totp(secret);
  await d.clickSelector("#mfa-code", { hold: 200 });
  await page.keyboard.type(code, { delay: 30 });
  await d.clickText("Verify and sign in");
  await d.wait(1900);
  const stillMfa = await page.$("#mfa-code");
  if (stillMfa) {
    // replay-protected step: wait for the next window and retry
    log("  MFA rejected (replayed time-step) — retrying in the next window");
    const now = Date.now();
    const next = Math.ceil((now + 1000) / 30000) * 30000;
    await sleep(next - now + 600);
    code = totp(secret);
    await d.clickSelector("#mfa-code", { hold: 200 });
    await page.keyboard.type(code, { delay: 30 });
    await d.clickText("Verify and sign in");
    await d.wait(3000);
  }
  await d.mark("MFA completed → platform console");
  await d.wait(1200);
  await d.overlay("lower", true, "Platform Control Centre", "Super Admin · MFA enforced at sign-in");
  await d.wait(900);
  await d.overlay("lower", false);
  await d.clickNav("Security Centre");
  await d.mark("security centre");
  await d.wait(1400);
  await d.overlay("zoom", 1.35, 640, 420);
  await d.wait(1400);
  await d.overlay("zoom", 1);
  await d.wait(500);
  await d.clickNav("Platform Settings");
  await d.mark("platform settings");
  await d.wait(1500);
  d.endScene();

  // ═══════════════ SCENE 4 — hotel & restaurant ═══════════════
  d.startScene("s4", "Hotel & restaurant operations", "s4");
  await d.say(
    "Hotel and restaurant teams can work within their authorized areas, keeping their operational data separate from other businesses.",
    9.5,
  );
  await d.clickSelector('button[aria-label="Sign out"]', { hold: 300 });
  await d.wait(1500);
  await d.typeInto("#email", ACCOUNTS.manager.email, { delay: 13 });
  await d.wait(220);
  await d.typeInto("#password", ACCOUNTS.manager.password, { delay: 13 });
  await d.wait(350);
  await d.clickText("Sign in");
  await d.mark("signed in as restaurant manager");
  await d.wait(1900);
  await d.overlay("lower", true, "Saffron Table · Mumbai", "Restaurant tenant — separate operational data");
  await d.wait(900);
  await d.overlay("lower", false);
  await d.ensureExpanded("Kitchen Display");
  await d.clickNav("Kitchen Display");
  await d.mark("kitchen display");
  await d.wait(1200);
  await d.overlay("zoom", 1.28, 860, 240);
  await d.wait(1300);
  await d.overlay("zoom", 1);
  await d.wait(500);
  await d.clickNav("Orders");
  await d.mark("orders");
  await d.wait(1100);
  await d.clickNav("Digital Menu");
  await d.mark("digital menu");
  await d.wait(1300);
  await d.clickNav("POS Terminal");
  await d.mark("pos terminal");
  await d.wait(1400);
  d.endScene();

  // ═══════════════ SCENE 5 — role permissions & security ═══════════════
  d.startScene("s5", "Role permissions & security", "s5");
  await d.say(
    "Role-based access control is enforced on the server for every request. Platform settings stay with platform administrators, pricing changes stay with managers, and one business can never read another business's customer records.",
    13.5,
  );
  await d.overlay("dim", true);
  await d.overlay("hud", true);
  await d.overlay("hudReset");
  await d.wait(500);

  const checks = [];
  /** Map a real HTTP status to an honest label. A 202 from the public join
   *  endpoint means "challenge issued, no member data disclosed" → denied.
   *  Anything that is not a clean authorization/denial (rate limit, server
   *  error, network fault) is reported as a CHECK ERROR, never as a
   *  security result. */
  const verdictFor = (status) => {
    if (status === 200) return "AUTHORIZED";
    if ([202, 401, 403, 404].includes(status)) return "ACCESS DENIED";
    return "CHECK ERROR";
  };
  const runCheck = async (i, cfg) => {
    const r = await cfg.run();
    const row = {
      who: cfg.who,
      role: cfg.role,
      method: cfg.method,
      path: cfg.path,
      status: `HTTP ${r.status}`,
      verdict: verdictFor(r.status),
    };
    checks.push(row);
    await d.overlay("hudRow", i, row);
    await d.mark(`check ${i + 1} → HTTP ${r.status} (${row.verdict})`);
    await d.waitWithMotion(2000);
  };

  // 1 — Super Admin reads a platform setting (authorized)
  await runCheck(0, {
    who: "Platform Operator",
    role: "demo.superadmin@byato.test · SUPER_ADMIN",
    method: "GET",
    path: "/api/super-admin/settings",
    run: async () => {
      const token = await superToken(page, mfaSecret);
      return apiCall(page, { path: "/api/super-admin/settings", token });
    },
  });

  // 2 — Hotel Admin is denied the same platform setting
  await runCheck(1, {
    who: "Hotel Admin",
    role: "demo.hoteladmin@byato.test · HOTEL_ADMIN",
    method: "GET",
    path: "/api/super-admin/settings",
    run: async () => {
      const token = await loginToken(page, {
        email: ACCOUNTS.hotel.email,
        password: ACCOUNTS.hotel.password,
      });
      return apiCall(page, { path: "/api/super-admin/settings", token });
    },
  });

  // 3 — Waiter is denied a menu price change
  await runCheck(2, {
    who: "Waiter",
    role: "demo.waiter@byato.test · WAITER",
    method: "PATCH",
    path: "/api/menu/items/… price",
    run: async () => {
      const token = await loginToken(page, {
        email: ACCOUNTS.waiter.email,
        password: ACCOUNTS.waiter.password,
      });
      const list = await apiCall(page, { path: "/api/menu/items", token });
      const item = list.payload?.items?.[0];
      return apiCall(page, {
        method: "PATCH",
        path: `/api/menu/items/${item?.id}`,
        body: { priceMinor: (item?.priceMinor ?? 1000) + 500 },
        token,
      });
    },
  });

  // 4 — One tenant cannot read another tenant's customer record
  await runCheck(3, {
    who: "Hotel Admin (other tenant)",
    role: "demo.otheradmin@byato.test · Sea View Resort",
    method: "GET",
    path: "/api/customers/… (foreign id)",
    run: async () => {
      const hotelToken = await loginToken(page, {
        email: ACCOUNTS.hotel.email,
        password: ACCOUNTS.hotel.password,
      });
      const list = await apiCall(page, { path: "/api/customers?limit=1", token: hotelToken });
      const foreignId = list.payload?.customers?.[0]?.id;
      const otherToken = await loginToken(page, {
        email: ACCOUNTS.other.email,
        password: ACCOUNTS.other.password,
      });
      return apiCall(page, { path: `/api/customers/${foreignId}`, token: otherToken });
    },
  });

  // 5 — An anonymous visitor cannot read an existing member's profile
  await runCheck(4, {
    who: "Anonymous visitor",
    role: "No session · public QR sign-up",
    method: "POST",
    path: "/api/public/join (member phone)",
    run: async () => {
      const managerToken = await loginToken(page, {
        email: ACCOUNTS.manager.email,
        password: ACCOUNTS.manager.password,
      });
      const qr = await apiCall(page, { path: "/api/qr-codes", token: managerToken });
      const codes = qr.payload?.qrCodes ?? qr.payload?.codes ?? [];
      const loyalty = codes.find((c) => c.type === "LOYALTY");
      // The public join endpoint rate-limits per phone number, so try the
      // synthetic members in order until one answers with the real result
      // (a 429 would be a rate-limit artefact, not an access-control result).
      const members = ["+919800000101", "+919800000102", "+919800000103", "+919800000104"];
      let last = null;
      for (const phone of members) {
        const res = await apiCall(page, {
          method: "POST",
          path: "/api/public/join",
          body: { qrCode: loyalty?.code, name: "Anonymous Visitor", phone },
        });
        last = res;
        if (res.status !== 429) return res;
      }
      return last;
    },
  });

  await d.overlay("note", true, "All five checks ran against the live server", "green");
  await d.wait(1800);
  await d.overlay("note", false);
  await d.overlay("hud", false);
  await d.overlay("dim", false);
  await d.overlay("lower", true, "Access control", "Server-side permission checks on every request");
  await d.wait(1800);
  await d.overlay("lower", false);
  d.endScene();

  // ═══════════════ SCENE 6 — customer privacy ═══════════════
  d.startScene("s6", "Customer privacy", "s6");
  await d.overlay("lower", true, "Customer privacy", "Signed in as the hotel admin of Grand Palace Hotel");
  await d.clickSelector('button[aria-label="Sign out"]', { hold: 300 });
  await d.wait(900);
  await d.typeInto("#email", ACCOUNTS.hotel.email, { delay: 13 });
  await d.wait(200);
  await d.typeInto("#password", ACCOUNTS.hotel.password, { delay: 13 });
  await d.wait(300);
  await d.clickText("Sign in");
  await d.mark("signed in as hotel admin");
  await d.wait(1600);
  // the narration is placed on the customer screens, not on the sign-in
  await d.say(
    "Byato's access-control design aims to keep customer information private and limit access to authorized users.",
    9.0,
  );
  await d.overlay("lower", false);
  await d.clickNav("Customers");
  await d.mark("customers view");
  await d.wait(1000);
  await d.overlay("zoom", 1.16, 1150, 330);
  await d.wait(1400);
  await d.overlay("zoom", 1);
  await d.wait(500);
  await d.clickFirstTableRow();
  await d.mark("customer profile");
  await d.wait(1600);
  await d.overlay("note", true, "Only authorized roles inside this hotel can open a customer record", "green");
  await d.wait(1500);
  await d.overlay("note", false);
  d.endScene();

  // ═══════════════ SCENE 7 — closing ═══════════════
  d.startScene("s7", "Closing", "s7");
  await d.say(
    "Byato — bringing hospitality operations together with clarity, control, and a focus on security.",
    7.5,
  );
  await d.clickNav("Dashboard");
  await d.mark("dashboard");
  await d.wait(1500);
  await d.overlay("dim", true);
  await d.overlay("card", true, {
    tag: "One Platform. Better Operations.",
    sub: "Byato — hotel & restaurant management",
    pos: "center",
  });
  await d.mark("closing card");
  await d.wait(3200);
  await d.overlay("card", false);
  await d.overlay("dim", false);
  await d.wait(1200);
  d.endScene();

  await capture.detach();
  await browser.close();

  capture.save();
  const timing = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    duration: +d.now.toFixed(2),
    // absolute clock of the first captured frame — the build step uses it to
    // align the encoded video with the scene/cue timeline below
    captureT0: capture.t0,
    scenes: d.scenes,
    cues: d.cues,
    timeline: d.timeline,
    securityChecks: checks,
    frames: capture.frames.length,
  };
  writeFileSync(join(ROOT, "demo/timing.json"), JSON.stringify(timing, null, 2));
  console.log(
    `\n✔ recorded ${capture.frames.length} frames · ${d.now.toFixed(1)}s → ${OUT}`,
  );
}

async function nextWindowTotp(secret) {
  const now = Date.now();
  const next = Math.ceil((now + 1200) / 30000) * 30000;
  await sleep(next - now + 500);
  return totp(secret);
}

main().catch((e) => {
  console.error("RECORDING FAILED:", e);
  process.exit(1);
});
