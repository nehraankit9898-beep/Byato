import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const state: {
  delivery: Record<string, any>;
  lookupAnswers: Array<{ address: string; family: number }>;
  lookupHosts: string[];
  requestOptions: Record<string, any> | null;
  requestBody: string;
  updates: Array<Record<string, any>>;
} = {
  delivery: {
    id: "delivery-1",
    status: "PENDING",
    attempt: 0,
    signature: "sig",
    eventId: "evt-1",
    eventType: "order.created",
    payload: "{\"id\":\"order-1\"}",
    endpoint: { active: true, url: "https://hooks.example.test/events", secret: "secret" },
  },
  lookupAnswers: [{ address: "93.184.216.34", family: 4 }],
  lookupHosts: [],
  requestOptions: null,
  requestBody: "",
  updates: [],
};

const fakeHttpsRequest = (options: Record<string, any>, callback: (response: any) => void) => {
  state.requestOptions = options;
  const request = new EventEmitter() as any;
  request.setTimeout = () => request;
  request.destroy = (error: Error) => {
    request.emit("error", error);
    return request;
  };
  request.end = (body: string) => {
    state.requestBody = body;
    const response = new EventEmitter() as any;
    response.statusCode = 204;
    callback(response);
    queueMicrotask(() => response.emit("end"));
  };
  return request;
};

mock.module("node:https", () => ({ request: fakeHttpsRequest }));
mock.module("node:dns/promises", () => ({
  lookup: async (hostname: string) => {
    state.lookupHosts.push(hostname);
    return state.lookupAnswers;
  },
}));
mock.module("@/lib/db", () => ({
  db: {
    webhookDelivery: {
      findUnique: async () => state.delivery,
      update: async ({ data }: { data: Record<string, any> }) => {
        state.updates.push(data);
        return {};
      },
    },
  },
}));
mock.module("@/lib/audit", () => ({ logAudit: async () => {} }));

const { createPinnedWebhookLookup, deliverWebhook } = await import("../src/lib/webhooks-out");

beforeEach(() => {
  state.lookupAnswers = [{ address: "93.184.216.34", family: 4 }];
  state.lookupHosts = [];
  state.requestOptions = null;
  state.requestBody = "";
  state.updates = [];
});

describe("outbound webhook DNS pinning", () => {
  test("production HTTPS connects to the already-validated IP, preserving hostname and TLS checks", async () => {
    const env = process.env as Record<string, string | undefined>;
    const originalNodeEnv = env.NODE_ENV;
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    env.NODE_ENV = "production";
    globalThis.fetch = Object.assign(
      async (..._args: Parameters<typeof fetch>) => {
        fetchCalled = true;
        throw new Error("production path must not re-resolve through fetch");
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;

    try {
      const result = await deliverWebhook("delivery-1");
      expect(result).toEqual({ ok: true, status: 204 });
      expect(state.lookupHosts).toEqual(["hooks.example.test"]);
      expect(state.requestOptions?.hostname).toBe("hooks.example.test");
      expect(state.requestOptions?.servername).toBe("hooks.example.test");
      expect(state.requestOptions?.agent).toBe(false);
      expect(fetchCalled).toBe(false);
      expect(state.requestBody).toBe(state.delivery.payload);

      let pinnedAddress = "";
      let pinnedFamily = 0;
      createPinnedWebhookLookup({ address: "93.184.216.34", family: 4 })(
        "hooks.example.test",
        {},
        (error, address, family) => {
          expect(error).toBeNull();
          pinnedAddress = address as string;
          pinnedFamily = family ?? 0;
        },
      );
      expect(pinnedAddress).toBe("93.184.216.34");
      expect(pinnedFamily).toBe(4);
      expect(state.updates[0]).toMatchObject({ status: "DELIVERED", responseStatus: 204 });
    } finally {
      if (originalNodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = originalNodeEnv;
      globalThis.fetch = originalFetch;
    }
  });

  test("a mixed public/private DNS answer set is blocked before connecting", async () => {
    const env = process.env as Record<string, string | undefined>;
    const originalNodeEnv = env.NODE_ENV;
    env.NODE_ENV = "production";
    state.lookupAnswers = [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ];
    try {
      const result = await deliverWebhook("delivery-1");
      expect(result.ok).toBe(false);
      expect(state.requestOptions).toBeNull();
      expect(state.updates[0]).toMatchObject({ status: "DEAD" });
    } finally {
      if (originalNodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = originalNodeEnv;
    }
  });
});
