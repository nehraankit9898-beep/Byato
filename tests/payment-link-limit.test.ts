import { beforeEach, test, expect } from "bun:test";
import { __resetInMemoryBuckets } from "@/lib/rate-limit";
import { limitPaymentLinkRequest } from "@/lib/payment-link-limit";

const req = new Request("http://localhost/api/pay/token/checkout", {
  method: "POST",
  headers: { "x-forwarded-for": "203.0.113.127" },
});

beforeEach(() => __resetInMemoryBuckets());

test("payment-link checkout is keyed by token, with independent action budgets", async () => {
  const linkA = "payment-link-token-A-123";
  const linkB = "payment-link-token-B-123";
  for (let n = 0; n < 10; n++) expect(await limitPaymentLinkRequest(req, "checkout", linkA)).toBeNull();
  const rejected = await limitPaymentLinkRequest(req, "checkout", linkA);
  expect(rejected?.status).toBe(429);
  expect(Number(rejected?.headers.get("Retry-After"))).toBeGreaterThan(0);

  // A second public link behind the same IP retains its own checkout budget.
  expect(await limitPaymentLinkRequest(req, "checkout", linkB)).toBeNull();
  // Independent action budgets: verification remains available for link A.
  expect(await limitPaymentLinkRequest(req, "verify", linkA)).toBeNull();
});

test("payment-link IP limit is a 10x backstop across distinct tokens", async () => {
  for (let n = 0; n < 100; n++) {
    const token = `payment-link-token-${String(n).padStart(4, "0")}`;
    expect(await limitPaymentLinkRequest(req, "checkout", token)).toBeNull();
  }
  const rejected = await limitPaymentLinkRequest(req, "checkout", "payment-link-token-0100");
  expect(rejected?.status).toBe(429);
});
