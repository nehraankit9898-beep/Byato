import { describe, expect, mock, test } from "bun:test";

let attempts = 0;
let consumed = false;
let raceAtConsume = false;
mock.module("../src/lib/db", () => ({
  db: {
    phoneOtp: {
      findUnique: async () => ({
        id: "otp-1",
        codeHash: "unused",
        attempts: 0,
        consumedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      }),
      updateMany: async ({ where }: { where: { attempts?: { lt?: number; lte?: number } } }) => {
        if (raceAtConsume) attempts = 5;
        if (where.attempts?.lt !== undefined && attempts >= where.attempts.lt) return { count: 0 };
        if (where.attempts?.lte !== undefined && attempts > where.attempts.lte) return { count: 0 };
        consumed = true;
        return { count: 1 };
      },
    },
  },
}));
// Force a code match so this test isolates the atomic attempt-ceiling guard.
mock.module("crypto", () => ({
  createHash: () => ({
    update() {
      return this;
    },
    digest: () => "unused",
  }),
  timingSafeEqual: () => true,
  randomInt: () => 123456,
  createHmac: () => ({}),
  randomBytes: () => Buffer.alloc(16),
}));
mock.module("../src/lib/audit", () => ({ logAudit: async () => {} }));
mock.module("../src/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
const { verifyPhoneOtp } = await import("../src/lib/phone-otp");
const { endpointSubscribesTo } = await import("../src/lib/webhooks-out");

const endpoint = (events: string[], active = true) => ({
  id: "endpoint",
  hotelId: "tenant",
  url: "https://example.invalid",
  secret: "test-only",
  events: JSON.stringify(events),
  active,
});

describe("webhook subscription matching", () => {
  test("category wildcards match children, not other categories or the bare category", () => {
    expect(endpointSubscribesTo(endpoint(["order.*"]), "order.created")).toBe(true);
    expect(endpointSubscribesTo(endpoint(["order.*"]), "order.item.ready")).toBe(true);
    expect(endpointSubscribesTo(endpoint(["order.*"]), "bill.created")).toBe(false);
    expect(endpointSubscribesTo(endpoint(["order.*"]), "order")).toBe(false);
  });
  test("exact, global, inactive and malformed subscriptions", () => {
    expect(endpointSubscribesTo(endpoint(["order.created"]), "order.created")).toBe(true);
    expect(endpointSubscribesTo(endpoint(["order.created"]), "order.cancelled")).toBe(false);
    expect(endpointSubscribesTo(endpoint(["*"]), "bill.created")).toBe(true);
    expect(endpointSubscribesTo(endpoint(["*"], false), "bill.created")).toBe(false);
    expect(endpointSubscribesTo({ ...endpoint([]), events: "bad JSON" }, "order.created")).toBe(
      false,
    );
  });
});

describe("OTP atomic attempt ceiling", () => {
  test("a correct in-flight code cannot succeed after concurrent failures reach the ceiling", async () => {
    attempts = 0;
    consumed = false;
    raceAtConsume = true;
    const result = await verifyPhoneOtp({
      hotelId: "tenant",
      phone: "+919999999999",
      code: "123456",
    });
    expect(result.ok).toBe(false);
    expect(consumed).toBe(false);
  });
  test("a code below the ceiling can still be consumed", async () => {
    attempts = 4;
    consumed = false;
    raceAtConsume = false;
    expect(
      (await verifyPhoneOtp({ hotelId: "tenant", phone: "+919999999999", code: "123456" })).ok,
    ).toBe(true);
    expect(consumed).toBe(true);
  });
});
