/**
 * Phase 22 — brute-force lockout tests (dedicated accounts, run isolated).
 */
import { describe, test, expect } from "bun:test";
import { BASE, apiCall } from "./helpers";

async function loginFrom(email: string, password: string, ip: string) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email, password }),
  });
  return { res, body: await res.json() };
}

describe("Brute force / account lockout (Phase 10)", () => {
  test("lockout response is generic and a stranger's IP cannot lock out the owner", async () => {
    const email = `lock${Date.now()}@victim.test`;
    const attackerIp = "203.0.113.41";
    const ownerIp = "203.0.113.42";
    const reg = await apiCall("POST", "/api/hotels", {
      body: {
        hotelName: "Lockout Test Hotel",
        adminName: "Lock Admin",
        email,
        password: "GoodPass123",
      },
    });
    expect(reg.status).toBe(201);

    for (let i = 0; i < 5; i++) {
      const { res } = await loginFrom(email, "BadPass123", attackerIp);
      expect(res.status).toBe(401);
    }

    const locked = await loginFrom(email, "GoodPass123", attackerIp);
    const unknown = await loginFrom(`unknown-${Date.now()}@victim.test`, "GoodPass123", attackerIp);
    expect(locked.res.status).toBe(401);
    expect(unknown.res.status).toBe(401);
    expect(locked.body.error).toEqual(unknown.body.error);
    expect(locked.body.error.code).toBe("INVALID_CREDENTIALS");

    // The failures from the attacker's network do not create a global lockout.
    const ownerLogin = await loginFrom(email, "GoodPass123", ownerIp);
    expect(ownerLogin.res.status).toBe(200);
  });
});
