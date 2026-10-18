import { beforeEach, describe, expect, mock, test } from "bun:test";

const state: {
  user: { id: string; email: string; hotelId: string | null; status: string } | null;
  afterTasks: Array<() => Promise<void>>;
  issued: number;
  sent: number;
  audited: number;
} = { user: null, afterTasks: [], issued: 0, sent: 0, audited: 0 };

mock.module("next/server", () => ({
  after: (task: () => Promise<void>) => state.afterTasks.push(task),
}));
mock.module("@/lib/body", () => ({ readJsonCapped: (req: Request) => req.json() }));
mock.module("@/lib/db", () => ({ db: { user: { findUnique: async () => state.user } } }));
mock.module("@/lib/api-helpers", () => ({
  jsonError: (message: string, status = 400, code = "ERROR") =>
    Response.json({ error: { code, message } }, { status }),
  serverError: () => Response.json({ error: { code: "INTERNAL" } }, { status: 500 }),
}));
mock.module("@/lib/security-tokens", () => ({
  issueSecurityToken: async () => {
    state.issued += 1;
    return "opaque-reset-token";
  },
}));
mock.module("@/lib/auth-emails", () => ({
  sendPasswordResetEmail: async () => {
    state.sent += 1;
    return { ok: true, url: "https://example.test/reset-password" };
  },
}));
mock.module("@/lib/audit", () => ({
  logAudit: async () => {
    state.audited += 1;
  },
  AUDIT_ACTIONS: { PASSWORD_RESET_REQUESTED: "PASSWORD_RESET_REQUESTED" },
}));
mock.module("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
mock.module("@/lib/login-security", () => ({ requestIp: () => "203.0.113.50" }));
mock.module("@/lib/logger", () => ({ logger: { warn: () => {}, error: () => {} } }));

const { POST } = await import("../src/app/api/auth/forgot-password/route");

function request(email: string): Request {
  return new Request("https://app.example.test/api/auth/forgot-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

beforeEach(() => {
  state.user = null;
  state.afterTasks = [];
  state.issued = 0;
  state.sent = 0;
  state.audited = 0;
});

describe("forgot-password response timing and email scheduling", () => {
  test("known and unknown addresses return the same response before user-specific work runs", async () => {
    state.user = {
      id: "user-1",
      email: "known@example.test",
      hotelId: "hotel-1",
      status: "ACTIVE",
    };
    const knownResponse = await POST(request("known@example.test"));
    const knownBody = await knownResponse.json();

    expect(knownResponse.status).toBe(200);
    expect(state.afterTasks).toHaveLength(1);
    expect(state.issued).toBe(0);
    expect(state.sent).toBe(0);

    state.user = null;
    const unknownResponse = await POST(request("unknown@example.test"));
    const unknownBody = await unknownResponse.json();
    expect(unknownResponse.status).toBe(knownResponse.status);
    expect(unknownBody).toEqual(knownBody);
    expect(state.afterTasks).toHaveLength(1);
    expect(state.sent).toBe(0);
  });

  test("the queued callback issues the token and sends the email after the response", async () => {
    state.user = {
      id: "user-1",
      email: "known@example.test",
      hotelId: "hotel-1",
      status: "ACTIVE",
    };
    const response = await POST(request("known@example.test"));
    expect(response.status).toBe(200);
    expect(state.issued).toBe(0);
    expect(state.sent).toBe(0);

    await state.afterTasks[0]();
    expect(state.issued).toBe(1);
    expect(state.sent).toBe(1);
    expect(state.audited).toBe(1);
  });
});
