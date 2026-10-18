import { beforeEach, describe, expect, mock, test } from "bun:test";
import { __resetInMemoryBuckets } from "@/lib/rate-limit";

const state = { createCalls: 0 };

mock.module("@/lib/db", () => ({
  db: {
    tableSession: {
      findUnique: async ({ where }: { where: { publicToken: string } }) => ({
        id: `table-session-${where.publicToken}`,
        hotelId: "hotel-1",
        status: "OPEN",
      }),
    },
  },
}));
mock.module("@/lib/orders", () => ({
  createOrder: async () => {
    state.createCalls++;
    return { created: true, order: { id: `order-${state.createCalls}` } };
  },
  CartValidationError: class CartValidationError extends Error {
    code = "INVALID_CART";
  },
}));
mock.module("@/lib/api-helpers", () => ({
  jsonError: (message: string, status = 400, code = "BAD_REQUEST") =>
    Response.json({ error: { message, code } }, { status }),
  readJson: async (req: Request) => req.json(),
  serverError: () => Response.json({ error: "server error" }, { status: 500 }),
}));
mock.module("@/lib/csrf", () => ({ assertCsrf: () => ({ ok: true }) }));
mock.module("@/lib/login-security", () => ({ requestIp: () => "203.0.113.10" }));

const { POST } = await import("@/app/api/public/orders/route");

beforeEach(() => {
  __resetInMemoryBuckets();
  state.createCalls = 0;
});

describe("public order rate limits", () => {
  test("20 table sessions behind one IP can each place an order", async () => {
    for (let i = 0; i < 20; i++) {
      const sessionToken = `session-token-${String(i).padStart(8, "0")}`;
      const req = new Request("http://localhost/api/public/orders", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
          "x-real-ip": "203.0.113.10",
        },
        body: JSON.stringify({
          sessionToken,
          idempotencyKey: `request-${i.toString().padStart(4, "0")}`,
          cart: [{ menuItemId: "item-1", quantity: 1 }],
        }),
      });
      const res = await POST(req);
      expect(res.status).toBe(201);
    }
    expect(state.createCalls).toBe(20);
  });
});
