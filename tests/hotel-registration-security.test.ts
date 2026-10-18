import { beforeEach, describe, expect, mock, test } from "bun:test";

const state = {
  existing: false,
  production: true,
  passwordHashes: 0,
  accountExistsEmails: 0,
  verificationEmails: 0,
};

const db = {
  user: {
    findUnique: async () => (state.existing ? { id: "existing-user" } : null),
  },
  hotel: { update: async () => ({}) },
  plan: {
    findUnique: async () => null,
    findFirst: async () => null,
  },
  $transaction: async (callback: (tx: any) => Promise<unknown>) =>
    callback({
      hotel: {
        create: async ({ data }: { data: { name: string } }) => ({ id: "new-hotel", name: data.name }),
      },
      user: { create: async () => ({ id: "new-user" }) },
    }),
};

mock.module("@/lib/db", () => ({ db }));
mock.module("@/lib/auth", () => ({
  hashPasswordAsync: async (password: string) => {
    state.passwordHashes++;
    return `hashed:${password}`;
  },
}));
mock.module("@/lib/api-helpers", () => ({
  jsonError: (message: string, status = 400, code = "BAD_REQUEST") =>
    Response.json({ error: { message, code } }, { status }),
  readJson: async (req: Request) => req.json(),
  serverError: () => Response.json({ error: "server error" }, { status: 500 }),
}));
mock.module("@/lib/csrf", () => ({ assertCsrf: () => ({ ok: true }) }));
mock.module("@/lib/validation", () => ({
  registerHotelSchema: {},
  parseWith: (_schema: unknown, body: unknown) => ({ ok: true, data: body }),
}));
mock.module("@/lib/audit", () => ({
  AUDIT_ACTIONS: { HOTEL_CREATED: "HOTEL_CREATED", EMAIL_VERIFICATION_SENT: "EMAIL_VERIFICATION_SENT" },
  logAudit: async () => {},
}));
mock.module("@/lib/phone", () => ({ normalizePhone: () => ({ ok: true, normalized: "" }) }));
mock.module("@/lib/login-security", () => ({ requestIp: () => "192.0.2.1" }));
mock.module("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
mock.module("@/lib/security-tokens", () => ({ issueSecurityToken: async () => "one-time-test-token" }));
mock.module("@/lib/auth-emails", () => ({
  sendAccountExistsEmail: async () => {
    state.accountExistsEmails++;
    return { ok: true };
  },
  sendVerificationEmail: async () => {
    state.verificationEmails++;
    return { ok: true, url: "http://localhost/verify-email?token=one-time-test-token" };
  },
}));
mock.module("@/lib/logger", () => ({ logger: { warn: () => {} } }));
mock.module("@/lib/config", () => ({ isProduction: () => state.production }));
mock.module("@/lib/super-admin", () => ({
  ensurePlansSeed: async () => {},
  ensureDefaultFeatureFlags: async () => {},
}));
mock.module("@/lib/saas/subscriptions", () => ({ startTrial: async () => {} }));
mock.module("@/lib/saas/settings", () => ({ getSetting: async () => ({ defaultPlanKey: "STARTER", defaultDays: 14 }) }));

const { POST } = await import("@/app/api/hotels/route");

function registrationRequest(): Request {
  return new Request("http://localhost/api/hotels", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({
      hotelName: "Test Hotel",
      adminName: "Test Owner",
      email: "owner@example.test",
      password: "StrongPass123!",
    }),
  });
}

beforeEach(() => {
  state.existing = false;
  state.production = true;
  state.passwordHashes = 0;
  state.accountExistsEmails = 0;
  state.verificationEmails = 0;
});

describe("hotel registration anti-enumeration", () => {
  test("new and existing email responses are identical and both do the password KDF", async () => {
    const newStartedAt = Date.now();
    const newResponse = await POST(registrationRequest());
    const newElapsed = Date.now() - newStartedAt;
    const newBody = await newResponse.json();

    state.existing = true;
    const existingStartedAt = Date.now();
    const existingResponse = await POST(registrationRequest());
    const existingElapsed = Date.now() - existingStartedAt;
    const existingBody = await existingResponse.json();

    expect(newResponse.status).toBe(201);
    expect(existingResponse.status).toBe(201);
    expect(newBody).toEqual(existingBody);
    expect(newBody).not.toHaveProperty("hotel");
    expect(newBody.emailVerification).not.toHaveProperty("devUrl");
    expect(state.passwordHashes).toBe(2);
    expect(state.verificationEmails).toBe(1);
    expect(state.accountExistsEmails).toBe(1);
    expect(newElapsed).toBeGreaterThanOrEqual(950);
    expect(existingElapsed).toBeGreaterThanOrEqual(950);
  });

  test("development returns a devUrl key in both response shapes, production never does", async () => {
    state.production = false;
    const newResponse = await POST(registrationRequest());
    const newBody = await newResponse.json();
    expect(newBody.emailVerification.devUrl).toContain("/verify-email?token=");

    state.existing = true;
    const existingResponse = await POST(registrationRequest());
    const existingBody = await existingResponse.json();
    expect(Object.keys(newBody).sort()).toEqual(Object.keys(existingBody).sort());
    expect(Object.keys(newBody.emailVerification).sort()).toEqual(Object.keys(existingBody.emailVerification).sort());
    expect(existingBody.emailVerification.devUrl).toBeNull();

    state.production = true;
    state.existing = false;
    const productionBody = await (await POST(registrationRequest())).json();
    expect(productionBody.emailVerification).not.toHaveProperty("devUrl");
  });
});
