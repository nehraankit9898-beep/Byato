/**
 * Super Admin hotel creation — error mapping (DB-free).
 *
 * POST /api/super-admin/hotels must:
 *  - return 400 with the message for deliberate validation failures
 *    (unknown plan, owner email already in use);
 *  - return a generic 500 for anything else, and NEVER echo the underlying
 *    error text (Prisma / connection details) to the client.
 *
 * The session guard, plan seeding and tenant service are mocked, so this
 * runs without a database.
 * Run standalone: bun test tests/super-admin-hotel-errors.test.ts
 */
import "./queue-test-env";
import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { cleanupQueueTestTmp } from "./queue-test-env";

// Mirrors HotelValidationError in src/lib/super-admin.ts (the route checks
// `instanceof` against the module it imports, which is this mock).
class HotelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HotelValidationError";
  }
}

let tenantImpl: () => Promise<unknown> = async () => {
  throw new Error("not configured");
};

mock.module("../src/lib/db", () => ({ db: {} }));

mock.module("../src/lib/api-helpers", () => ({
  requireSuperAdminSession: async () => ({
    session: { userId: "sa-user", role: "SUPER_ADMIN" },
  }),
}));

mock.module("../src/lib/super-admin", () => ({
  ensurePlansSeed: async () => {},
  HotelValidationError,
  createHotelTenant: async () => tenantImpl(),
}));

const { POST } = await import("../src/app/api/super-admin/hotels/route");

const validBody = {
  name: "Sunrise Hotel",
  city: "Jaipur",
  planName: "FREE",
  ownerName: "Owner Person",
  ownerEmail: "owner@example.com",
};

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/super-admin/hotels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  tenantImpl = async () => {
    throw new Error("not configured");
  };
});

describe("POST /api/super-admin/hotels — error mapping", () => {
  test("unknown plan → 400 BAD_REQUEST with the validation message", async () => {
    tenantImpl = async () => {
      throw new HotelValidationError("Unknown plan: GOLD");
    };
    const res = await post({ ...validBody, planName: "GOLD" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("BAD_REQUEST");
    expect(json.error.message).toBe("Unknown plan: GOLD");
  });

  test("owner email already in use → 400 (existing behavior preserved)", async () => {
    tenantImpl = async () => {
      throw new HotelValidationError("A user with the owner email already exists.");
    };
    const res = await post(validBody);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toBe("A user with the owner email already exists.");
  });

  test("database failure → generic 500 INTERNAL, no connection details leaked", async () => {
    const leaky =
      "Can't reach database server at `ep-cool-123-pooler.neon.tech:5432` postgresql://stayloop:S3cretPw@ep-cool-123/stayloop";
    tenantImpl = async () => {
      throw new Error(leaky);
    };
    const res = await post(validBody);
    expect(res.status).toBe(500);
    const text = await res.text();
    const json = JSON.parse(text) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("INTERNAL");
    expect(json.error.message).toBe("Could not create hotel.");
    expect(text).not.toContain("S3cretPw");
    expect(text).not.toContain("neon.tech");
    expect(text).not.toContain("Can't reach");
  });

  test("a non-Error throw is also a generic 500", async () => {
    tenantImpl = async () => {
      throw "raw string with internals";
    };
    const res = await post(validBody);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("raw string");
  });

  test("invalid body is still rejected before any tenant work → 400", async () => {
    let called = false;
    tenantImpl = async () => {
      called = true;
      return {};
    };
    const res = await post({ name: "X" });
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });
});

afterAll(() => {
  cleanupQueueTestTmp();
});
