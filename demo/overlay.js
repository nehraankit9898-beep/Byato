/**
 * Byato demo video — on-screen overlay layer.
 *
 * Injected into every page before load. Provides:
 *   • a pointer cursor (headless Chrome does not paint one)
 *   • title cards / lower thirds
 *   • a subtitle bar
 *   • the live "access check" HUD used by the security scene
 *   • a viewport zoom helper
 *
 * Everything is driven from the recorder through window.__byato.*.
 */
(() => {
  const NS = "__byato__";
  if (window[NS]) return;

  // Chromium evaluates this before <html> exists — wait for the document.
  const boot = () => {
    const style = document.createElement("style");
    style.textContent = `
      /* The demo host has no emoji font installed — without this the app's
         emoji (👋, 🎉, ⭐) render as empty boxes. The font is served by the
         demo dev server and registered under the same family name the app's
         CSS already falls back to. */
      @font-face {
        font-family: "Noto Color Emoji";
        src: url("/demo-assets/NotoColorEmoji.ttf") format("truetype");
        font-display: block;
      }
      #__byato_root__ { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; font-family: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      #__byato_root__ * { box-sizing: border-box; }
      nextjs-portal { display: none !important; }
      .bb-cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; z-index: 2147483647; pointer-events: none; will-change: transform; }
      .bb-card { position: absolute; left: 0; right: 0; top: 0; bottom: 0; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity .45s ease; }
      .bb-card.left { justify-content: flex-start; padding-left: 76px; }
      .bb-card.left::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 48%; background: linear-gradient(90deg, rgba(6,10,20,.66), rgba(6,10,20,.30) 62%, rgba(6,10,20,0)); }
      .bb-card.left .inner { position: relative; }
      .bb-card.on { opacity: 1; }
      .bb-card .inner { text-align: center; padding: 46px 70px; border-radius: 26px; background: rgba(15, 23, 42, .82); backdrop-filter: blur(14px); box-shadow: 0 30px 90px rgba(0,0,0,.45); border: 1px solid rgba(255,255,255,.14); }
      .bb-card .logo { display: flex; align-items: center; gap: 18px; justify-content: center; }
      .bb-card .logo .mark { width: 68px; height: 68px; border-radius: 18px; background: linear-gradient(140deg,#b45309,#d97706); display: flex; align-items: center; justify-content: center; box-shadow: 0 12px 30px rgba(180,83,9,.45); }
      .bb-card .logo .mark svg { width: 36px; height: 36px; color: #fff; }
      .bb-card .wordmark { font-size: 68px; font-weight: 800; letter-spacing: .16em; color: #fff; }
      .bb-card .tag { margin-top: 20px; font-size: 27px; font-weight: 500; letter-spacing: .10em; color: #fdba74; text-transform: uppercase; }
      .bb-card .sub { margin-top: 12px; font-size: 22px; color: rgba(255,255,255,.78); letter-spacing: .02em; }
      .bb-lower { position: absolute; left: 78px; bottom: 200px; display: flex; align-items: stretch; gap: 18px; opacity: 0; transition: opacity .35s ease; background: rgba(9, 14, 26, .88); border: 1px solid rgba(255,255,255,.14); border-radius: 16px; padding: 16px 30px 16px 20px; box-shadow: 0 18px 48px rgba(0,0,0,.45); backdrop-filter: blur(10px); }
      .bb-lower.on { opacity: 1; }
      .bb-lower .bar { width: 6px; border-radius: 4px; background: linear-gradient(180deg,#f59e0b,#b45309); }
      .bb-lower .txt .t1 { font-size: 29px; font-weight: 700; color: #fff; line-height: 1.15; }
      .bb-lower .txt .t2 { font-size: 18px; color: rgba(255,255,255,.72); margin-top: 4px; }
      .bb-subs { position: absolute; left: 50%; transform: translateX(-50%); bottom: 46px; max-width: 1280px; text-align: center; opacity: 0; transition: opacity .22s ease; }
      .bb-subs.on { opacity: 1; }
      .bb-subs span { display: inline-block; background: rgba(8, 12, 22, .78); color: #fff; font-size: 27px; line-height: 1.35; padding: 9px 22px; border-radius: 10px; letter-spacing: .01em; box-shadow: 0 10px 30px rgba(0,0,0,.35); }
      .bb-hud { position: absolute; right: 60px; top: 140px; width: 960px; border-radius: 20px; background: rgba(10, 15, 26, .94); border: 1px solid rgba(255,255,255,.13); box-shadow: 0 30px 80px rgba(0,0,0,.55); overflow: hidden; opacity: 0; transform: translateY(14px); transition: opacity .4s ease, transform .4s ease; }
      .bb-hud.on { opacity: 1; transform: translateY(0); }
      .bb-hud .hd { padding: 18px 26px; background: linear-gradient(90deg, rgba(180,83,9,.95), rgba(217,119,6,.85)); display: flex; align-items: center; justify-content: space-between; }
      .bb-hud .hd .h1 { font-size: 24px; font-weight: 800; color: #fff; letter-spacing: .02em; }
      .bb-hud .hd .h2 { font-size: 15px; color: rgba(255,255,255,.9); letter-spacing: .04em; text-transform: uppercase; }
      .bb-hud .rows { padding: 8px 0 10px; }
      .bb-hud .row { display: grid; grid-template-columns: 30px minmax(0, 330px) minmax(0, 1fr) 150px; gap: 14px; align-items: center; padding: 12px 24px; font-size: 16px; color: rgba(255,255,255,.9); border-top: 1px solid rgba(255,255,255,.07); }
      .bb-hud .row:first-child { border-top: none; }
      .bb-hud .row .num { width: 26px; height: 26px; border-radius: 50%; background: rgba(255,255,255,.12); display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; }
      .bb-hud .row .who { font-weight: 600; min-width: 0; }
      .bb-hud .row .who small { display: block; font-weight: 400; color: rgba(255,255,255,.6); font-size: 14px; margin-top: 2px; }
      .bb-hud .row .req { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; color: rgba(255,255,255,.78); word-break: break-all; }
      .bb-hud .row .req b { color: #fdba74; font-weight: 700; }
      .bb-hud .row .code { font-family: ui-monospace, monospace; font-size: 16px; text-align: right; color: rgba(255,255,255,.8); }
      .bb-hud .row .verdict { text-align: center; font-size: 13.5px; font-weight: 800; letter-spacing: .05em; padding: 7px 10px; border-radius: 999px; display: inline-block; white-space: nowrap; }
      .bb-hud .row .verdict.ok { background: rgba(16,185,129,.16); color: #6ee7b7; border: 1px solid rgba(110,231,183,.4); }
      .bb-hud .row .verdict.no { background: rgba(244,63,94,.16); color: #fda4af; border: 1px solid rgba(253,164,175,.4); }
      .bb-hud .row .verdict.err { background: rgba(251,191,36,.16); color: #fcd34d; border: 1px solid rgba(252,211,77,.45); }
      .bb-hud .row .verdict.wait { background: rgba(255,255,255,.08); color: rgba(255,255,255,.55); border: 1px solid rgba(255,255,255,.14); }
      .bb-hud .ft { padding: 12px 26px 16px; font-size: 14px; color: rgba(255,255,255,.55); border-top: 1px solid rgba(255,255,255,.07); }
      .bb-note { position: absolute; left: 78px; top: 92px; display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-radius: 14px; background: rgba(10,15,26,.86); border: 1px solid rgba(255,255,255,.13); color: #fff; font-size: 19px; font-weight: 600; opacity: 0; transition: opacity .35s ease; }
      .bb-note.on { opacity: 1; }
      .bb-note .dot { width: 10px; height: 10px; border-radius: 50%; background: #34d399; box-shadow: 0 0 0 4px rgba(52,211,153,.22); }
      .bb-note .dot.amber { background: #fbbf24; box-shadow: 0 0 0 4px rgba(251,191,36,.22); }
      .bb-vig { position: absolute; inset: 0; background: radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(0,0,0,.32) 100%); opacity: 0; transition: opacity .4s ease; }
      .bb-vig.on { opacity: 1; }
      .bb-dim { position: absolute; inset: 0; background: rgba(4, 8, 18, .72); opacity: 0; transition: opacity .45s ease; }
      .bb-dim.on { opacity: 1; }
    `;
    document.documentElement.appendChild(style);

    // Warm the emoji font so the first paint of a scene never shows a box.
    try {
      const warm = document.createElement("span");
      warm.textContent = "👋";
      warm.style.cssText = "position:absolute;left:-9999px;font-family:'Noto Color Emoji';font-size:16px";
      document.documentElement.appendChild(warm);
      if (document.fonts && document.fonts.load) {
        document.fonts.load("16px 'Noto Color Emoji'").catch(() => {});
      }
    } catch {
      /* ignore */
    }

    const root = document.createElement("div");
    root.id = "__byato_root__";
    root.innerHTML = `
      <div class="bb-dim" id="bb_dim"></div>
      <div class="bb-vig" id="bb_vig"></div>
      <div class="bb-card" id="bb_card">
        <div class="inner">
          <div class="logo">
            <div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M9 13h.01M9 17h.01M15 9h.01M15 13h.01M15 17h.01"/></svg></div>
            <div class="wordmark">BYATO</div>
          </div>
          <div class="tag" id="bb_card_tag">Smarter Hospitality Management</div>
          <div class="sub" id="bb_card_sub">Hotel &amp; restaurant management, in one platform</div>
        </div>
      </div>
      <div class="bb-lower" id="bb_lower">
        <div class="bar"></div>
        <div class="txt"><div class="t1" id="bb_lower_t1"></div><div class="t2" id="bb_lower_t2"></div></div>
      </div>
      <div class="bb-note" id="bb_note"><span class="dot"></span><span id="bb_note_txt"></span></div>
      <div class="bb-subs" id="bb_subs"><span id="bb_subs_txt"></span></div>
      <div class="bb-hud" id="bb_hud">
        <div class="hd"><div class="h1">Live access checks</div><div class="h2">Real HTTP responses · Byato demo server</div></div>
        <div class="rows" id="bb_hud_rows"></div>
        <div class="ft" id="bb_hud_ft">Every request below ran against the live server with the labelled test account. Labels are derived from the actual HTTP status returned (HTTP 202 = a verification challenge was issued and no member data was disclosed).</div>
      </div>
    `;
    // Mount OUTSIDE <body> so React hydration never sees the extra nodes.
    const mount = () => document.documentElement.appendChild(root);
    if (document.documentElement) mount();

    // pointer cursor (headless Chrome paints no pointer)
    const cursor = document.createElement("div");
    cursor.className = "bb-cursor";
    cursor.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 17 L7.2 13.2 L10 20 L13 19 L10.2 12.2 L16 12 Z" fill="#0f172a" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    const mountCursor = () => document.documentElement.appendChild(cursor);
    if (document.documentElement) mountCursor();
    window.addEventListener(
      "mousemove",
      (e) => {
        cursor.style.transform = `translate(${e.clientX - 4}px, ${e.clientY - 3}px)`;
      },
      { passive: true },
    );

    const $ = (id) => document.getElementById(id);
    const api = {
      card(on, { tag, sub, pos } = {}) {
        if (tag !== undefined) $("bb_card_tag").textContent = tag;
        if (sub !== undefined) $("bb_card_sub").textContent = sub;
        if (pos !== undefined) $("bb_card").classList.toggle("left", pos === "left");
        $("bb_card").classList.toggle("on", !!on);
      },
      lower(on, t1 = "", t2 = "") {
        $("bb_lower_t1").textContent = t1;
        $("bb_lower_t2").textContent = t2;
        $("bb_lower").classList.toggle("on", !!on);
      },
      note(on, text = "", tone = "green") {
        $("bb_note_txt").textContent = text;
        $("bb_note").querySelector(".dot").className = "dot" + (tone === "amber" ? " amber" : "");
        $("bb_note").classList.toggle("on", !!on);
      },
      subtitle(text) {
        const el = $("bb_subs");
        if (!text) {
          el.classList.remove("on");
          return;
        }
        $("bb_subs_txt").textContent = text;
        el.classList.add("on");
      },
      vignette(on) {
        $("bb_vig").classList.toggle("on", !!on);
      },
      dim(on) {
        $("bb_dim").classList.toggle("on", !!on);
      },
      hud(on) {
        $("bb_hud").classList.toggle("on", !!on);
      },
      hudRow(i, { who, role, req, method, path, status, verdict }) {
        const rows = $("bb_hud_rows");
        let row = rows.querySelector(`[data-i="${i}"]`);
        if (!row) {
          row = document.createElement("div");
          row.className = "row";
          row.dataset.i = String(i);
          rows.appendChild(row);
        }
        const cls = verdict === "AUTHORIZED" ? "ok" : verdict === "ACCESS DENIED" ? "no" : verdict === "CHECK ERROR" ? "err" : "wait";
        row.innerHTML = `
          <div class="num">${i + 1}</div>
          <div class="who">${who}<small>${role}</small></div>
          <div class="req"><b>${method || ""}</b> ${path || ""}</div>
          <div style="text-align:right"><div class="code">${status || "…"}</div><span class="verdict ${cls}">${verdict || "RUNNING"}</span></div>
        `;
      },
      hudReset() {
        $("bb_hud_rows").innerHTML = "";
      },
      /** zoom the viewport around a point (document coordinates) */
      zoom(k, cx = 0, cy = 0) {
        const html = document.documentElement;
        if (!k || k === 1) {
          html.style.zoom = "";
          html.style.overflow = "";
          document.body.style.marginLeft = "";
          document.body.style.marginTop = "";
          return;
        }
        html.style.zoom = String(k);
        html.style.overflow = "hidden";
        document.body.style.marginLeft = `${cx * (1 - k)}px`;
        document.body.style.marginTop = `${cy * (1 - k)}px`;
      },
    };
    window[NS] = api;
  };
  if (document.documentElement) boot();
  else {
    const timer = setInterval(() => {
      if (document.documentElement) {
        clearInterval(timer);
        boot();
      }
    }, 5);
  }
})();
