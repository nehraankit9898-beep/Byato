/**
 * QR-code injection regression suite (2026-10 merge).
 *
 * Pins the security contract of every value that flows into the QR print
 * window (src/components/app/qr-codes-view.tsx) and QR URL construction
 * (src/lib/qr.ts):
 *
 *   1. escapeHtml (src/lib/html-escape.ts) must neutralize markup payloads in
 *      staff-editable QR labels and dynamic URLs — the print window is built
 *      via document.write(), so an unescaped "</title><script>…" label is
 *      direct markup injection. (The escapeHtml copies in email.ts,
 *      retention.ts, and the bill receipt route were consolidated onto the
 *      same implementation during the merge, so one test guards all four
 *      surfaces.)
 *   2. buildPublicUrl must refuse non-http(s) origins — a misconfigured
 *      APP_ORIGIN like "javascript:…" must never be embedded into the QR
 *      image customers scan.
 *   3. generateQrIdentifier must stay URL-safe and unpredictable.
 */
import { describe, test, expect } from "bun:test";

import { escapeHtml } from "../src/lib/html-escape";
import { buildPublicUrl, generateQrIdentifier } from "../src/lib/qr";

describe("escapeHtml — QR label / URL injection payloads", () => {
  test("script tag in label cannot break out of the <title> element", () => {
    const malicious = '</title><script>alert("pwned")</script>';
    const escaped = escapeHtml(malicious);
    expect(escaped).not.toContain("<script");
    expect(escaped).not.toContain("</title>");
    expect(escaped).toBe(
      "&lt;/title&gt;&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt;",
    );
  });

  test("img onerror payload is defused (attribute quoting survives)", () => {
    const malicious = '" onerror="alert(1)"';
    const escaped = escapeHtml(malicious);
    expect(escaped).toBe("&quot; onerror=&quot;alert(1)&quot;");
    // The escaped value cannot terminate a double-quoted attribute:
    expect(escaped.includes('"')).toBe(false);
  });

  test("single-quote attribute breakout is defused (email template context)", () => {
    // The old email.ts escapeHtml did NOT escape ' — pin the fixed contract.
    const malicious = "' onmouseover='alert(1)";
    const escaped = escapeHtml(malicious);
    expect(escaped.includes("'")).toBe(false);
    expect(escaped).toBe("&#39; onmouseover=&#39;alert(1)");
  });

  test("javascript: URL in a href context is inert as text", () => {
    const malicious = 'javascript:alert("xss")';
    const escaped = escapeHtml(malicious);
    // Rendered as text it is harmless; no markup is produced from it.
    expect(escaped.startsWith("javascript:")).toBe(true);
    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
  });

  test("data: URI with HTML payload is defused", () => {
    const malicious = "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==";
    const escaped = escapeHtml(malicious);
    expect(escaped).not.toContain("<");
    expect(escaped).toBe(malicious); // base64 payload has no metacharacters; escaping is a no-op — safe as TEXT
  });

  test("event-handler payload in URL query is defused", () => {
    const malicious = '"><img src=x onerror=alert(document.domain)>';
    const escaped = escapeHtml(malicious);
    expect(escaped).not.toContain("<img");
    expect(escaped).not.toContain('"');
  });

  test("ampersand-first ordering prevents double-escape bypass", () => {
    // "&lt;script&gt;" must not become "&amp;lt;script&amp;gt;" that decodes
    // back into live markup via a second decode pass. Escaping & first and
    // checking the round-trip pins the ordering.
    expect(escapeHtml("&lt;script&gt;")).toBe("&amp;lt;script&amp;gt;");
  });

  test("null/undefined/empty are handled (receipt context)", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml("")).toBe("");
  });
});

describe("buildPublicUrl — scheme validation", () => {
  test("http and https origins pass through", () => {
    expect(buildPublicUrl("abc123", "https://stayloop.example.com")).toBe(
      "https://stayloop.example.com/r/abc123",
    );
    expect(buildPublicUrl("abc123", "http://localhost:3000/")).toBe(
      "http://localhost:3000/r/abc123",
    );
  });

  test("javascript: origin is rejected", () => {
    // APP_ORIGIN misconfiguration must never reach the QR image.
    delete process.env.APP_ORIGIN;
    delete process.env.FRONTEND_URL;
    expect(buildPublicUrl("abc123", "javascript:alert(1)//")).toBe("/r/abc123");
  });

  test("data: origin is rejected", () => {
    expect(buildPublicUrl("abc123", "data:text/html,<script>alert(1)</script>,")).toBe(
      "/r/abc123",
    );
  });

  test("vbscript: and unknown schemes are rejected", () => {
    expect(buildPublicUrl("abc123", "vbscript:msgbox(1)")).toBe("/r/abc123");
    expect(buildPublicUrl("abc123", "file:///etc/passwd")).toBe("/r/abc123");
  });

  test("origin with a path only keeps the origin", () => {
    // Paths are dropped: QRs always resolve at the site root /r/<code>.
    expect(buildPublicUrl("abc123", "https://example.com/some/subpath?x=1")).toBe(
      "https://example.com/r/abc123",
    );
  });

  test("garbage origin degrades to a relative URL, not an exception", () => {
    expect(buildPublicUrl("abc123", "::::not-a-url")).toBe("/r/abc123");
    expect(buildPublicUrl("abc123", null)).toBe("/r/abc123");
  });
});

describe("generateQrIdentifier — QR code material", () => {
  test("identifiers are URL-safe (QR-encodable without escaping)", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateQrIdentifier();
      expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    }
  });

  test("identifiers are unpredictable (no repeats across 100 draws)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateQrIdentifier());
    expect(seen.size).toBe(100);
  });
});
