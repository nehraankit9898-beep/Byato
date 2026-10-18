import { beforeEach, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MAX_JSON_BODY_BYTES } from "../src/lib/body";

let consumed = 0;
mock.module("@/lib/db", () => ({
  db: {
    integration: { findFirst: async () => null },
    restaurantWebhookEvent: { create: async () => ({}) },
  },
}));
mock.module("@/lib/security-tokens", () => ({
  consumeSecurityToken: async () => {
    consumed++;
    return { ok: false, reason: "invalid" };
  },
}));
mock.module("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
mock.module("@/lib/login-security", () => ({ requestIp: () => "127.0.0.1" }));
mock.module("@/lib/audit", () => ({ logAudit: async () => {}, AUDIT_ACTIONS: {} }));
const reset = await import("../src/app/api/auth/reset-password/route");
const webhook = await import("../src/app/api/webhooks/razorpay-restaurant/route");
const secret = "test-restaurant-webhook-secret";
process.env.RAZORPAY_RESTAURANT_WEBHOOK_SECRET = secret;
beforeEach(() => {
  consumed = 0;
});

function streamed(body: string, headers: Record<string, string> = {}) {
  let cancelled = false;
  let sent = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode(body));
        } else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const req = new Request("http://localhost/api/test", {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit);
  return { req, cancelled: () => cancelled };
}

test("BUG-17 reset-password cancels an oversized chunked body before token consumption", async () => {
  const input = streamed(
    JSON.stringify({
      token: "t".repeat(32),
      password: "ValidPassword123!",
      padding: "x".repeat(MAX_JSON_BODY_BYTES),
    }),
  );
  expect((await reset.POST(input.req)).status).toBe(400);
  expect(consumed).toBe(0);
  expect(input.cancelled()).toBe(true);
});
test("BUG-17 a normally sized reset request still reaches token validation", async () => {
  const input = streamed(JSON.stringify({ token: "t".repeat(32), password: "ValidPassword123!" }));
  expect((await reset.POST(input.req)).status).toBe(400);
  expect(consumed).toBe(1);
});
test("BUG-17 signature webhooks reject oversized raw bodies before processing", async () => {
  const raw = JSON.stringify({ event: "ignored.event", padding: "x".repeat(MAX_JSON_BODY_BYTES) });
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  const input = streamed(raw, { "x-razorpay-signature": signature });
  expect((await webhook.POST(input.req)).status).toBe(413);
  expect(input.cancelled()).toBe(true);
});
test("BUG-17 valid bounded raw signatures are not changed by the cap", async () => {
  const raw = JSON.stringify({ event: "ignored.event" });
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  expect(
    (await webhook.POST(streamed(raw, { "x-razorpay-signature": signature }).req)).status,
  ).toBe(200);
});
test("BUG-17 all API JSON/text readers use the capped helpers", () => {
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "route.ts") files.push(path);
    }
  }
  walk("src/app/api");
  expect(
    files.filter((path) =>
      /\b(?:req|request)\.(?:json|text|arrayBuffer)\s*\(/.test(readFileSync(path, "utf8")),
    ),
  ).toEqual([]);
});
