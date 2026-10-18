import { beforeEach, describe, expect, mock, test } from "bun:test";

const state = {
  unknownAttempts: 0,
  unknownFailures: 0,
  knownAttempts: 0,
  knownFailures: 0,
  lockoutCounts: new Map<string, number>(),
  lockoutOldest: new Map<string, Date>(),
  lockoutQueries: [] as Array<{ email: string; ipAddress: string | null }>,
};

const lockoutKey = (email: string, ipAddress: string | null) => `${email}|${ipAddress ?? "null"}`;

mock.module("@/lib/db", () => ({
  db: {
    authAttempt: {
      count: async ({ where }: { where: { email?: string; ipAddress: string | null; success?: boolean } }) => {
        if (where.email !== undefined) {
          state.lockoutQueries.push({ email: where.email, ipAddress: where.ipAddress });
          return state.lockoutCounts.get(lockoutKey(where.email, where.ipAddress)) ?? 0;
        }
        const unknown = where.ipAddress === null;
        if (where.success === false) return unknown ? state.unknownFailures : state.knownFailures;
        return unknown ? state.unknownAttempts : state.knownAttempts;
      },
      findFirst: async ({ where }: { where: { email: string; ipAddress: string | null } }) => {
        const createdAt = state.lockoutOldest.get(lockoutKey(where.email, where.ipAddress));
        return createdAt ? { createdAt } : null;
      },
    },
  },
}));
mock.module("@/lib/audit", () => ({ logAudit: async () => {} }));
mock.module("@/lib/saas/security", () => ({ logSecurityEvent: async () => {} }));

const { getLockoutStatus, isIpThrottled } = await import("@/lib/login-security");
const { clientIp } = await import("@/lib/rate-limit");

beforeEach(() => {
  state.unknownAttempts = 0;
  state.unknownFailures = 0;
  state.knownAttempts = 0;
  state.knownFailures = 0;
  state.lockoutCounts.clear();
  state.lockoutOldest.clear();
  state.lockoutQueries = [];
});

describe("login IP throttling when proxy IP is unavailable", () => {
  test("TRUSTED_PROXY_HOPS selects from the right and fails safely when misconfigured", () => {
    const env = process.env as Record<string, string | undefined>;
    const previous = env.TRUSTED_PROXY_HOPS;
    const request = new Request("https://app.example.test", {
      headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.11, 10.0.0.1" },
    });
    try {
      env.TRUSTED_PROXY_HOPS = "2";
      expect(clientIp(request)).toBe("203.0.113.11");
      env.TRUSTED_PROXY_HOPS = "invalid";
      expect(clientIp(request)).toBe("10.0.0.1");
      env.TRUSTED_PROXY_HOPS = "9";
      expect(clientIp(request)).toBe("10.0.0.1");
    } finally {
      if (previous === undefined) delete env.TRUSTED_PROXY_HOPS;
      else env.TRUSTED_PROXY_HOPS = previous;
    }
  });

  test("lockout is scoped to normalized email plus source IP", async () => {
    const attackerIp = "203.0.113.41";
    state.lockoutCounts.set(lockoutKey("owner@example.test", attackerIp), 5);
    state.lockoutOldest.set(lockoutKey("owner@example.test", attackerIp), new Date(Date.now() - 60_000));

    const attacker = await getLockoutStatus({ email: "Owner@Example.test", ip: attackerIp });
    expect(attacker.locked).toBe(true);
    expect(state.lockoutQueries[0]).toEqual({ email: "owner@example.test", ipAddress: attackerIp });

    const ownerNetwork = await getLockoutStatus({ email: "owner@example.test", ip: "203.0.113.42" });
    expect(ownerNetwork.locked).toBe(false);
  });

  test("unknown IP is a shared fail-closed bucket with a low threshold", async () => {
    expect(await isIpThrottled("unknown")).toEqual({ throttled: false });

    state.unknownFailures = 5;
    expect(await isIpThrottled("unknown")).toEqual({ throttled: true, reason: "failures" });

    state.unknownFailures = 0;
    state.unknownAttempts = 10;
    expect(await isIpThrottled("unknown")).toEqual({ throttled: true, reason: "volume" });
  });

  test("normal IPs keep the higher shared-network limits", async () => {
    state.knownFailures = 24;
    state.knownAttempts = 199;
    expect(await isIpThrottled("203.0.113.12")).toEqual({ throttled: false });
    state.knownFailures = 25;
    expect(await isIpThrottled("203.0.113.12")).toEqual({ throttled: true, reason: "failures" });
  });
});
