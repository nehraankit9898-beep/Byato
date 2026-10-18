import { beforeEach, expect, mock, test } from "bun:test";

// Controlled READ COMMITTED interleaving, not a PostgreSQL integration test.
// Both service transactions read the same balance before either writes. The
// delegate evaluates the actual Prisma updateMany predicate against the latest
// committed row, as PostgreSQL does after waiting for a concurrent updater.
let bill: Record<string, any>;
let rows: Record<string, any>[];
let readers: number;
let release: () => void;
let barrier: Promise<void>;
let intentStatus: string;
let captureSequence: number;
const matches = (where: Record<string, any>) =>
  Object.entries(where).every(([key, value]) => bill[key] === value);
const db = {
  bill: {
    findFirst: async () => ({ ...bill }),
    findUnique: async () => ({ ...bill }),
  },
  $transaction: async (fn: (tx: any) => Promise<any>) => {
    const pending: Record<string, any>[] = [];
    const read = async () => {
      const snapshot = { ...bill };
      if (++readers === 2) release();
      await barrier;
      return snapshot;
    };
    const tx = {
      bill: {
        findFirst: read,
        findUnique: read,
        updateMany: async ({ where, data }: any) => {
          if (!matches(where)) return { count: 0 };
          Object.assign(bill, data);
          return { count: 1 };
        },
      },
      billPayment: {
        create: async ({ data }: any) => {
          const row = { id: `p${readers}`, ...data };
          pending.push(row);
          return row;
        },
        findFirst: async ({ where }: any) => ({
          id: where.id,
          hotelId: where.hotelId,
          billId: "b1",
          gatewayOrderId: where.gatewayOrderId,
          gateway: where.gateway,
          status: intentStatus,
          amountMinor: 200,
          currency: "INR",
        }),
        update: async ({ data }: any) => {
          pending.push(data);
          return data;
        },
      },
      billRefund: {
        create: async ({ data }: any) => {
          pending.push(data);
          return { id: "r1", ...data };
        },
      },
      auditLog: { create: async () => ({}) },
      backgroundJob: { create: async () => ({}) },
    };
    const result = await fn(tx);
    rows.push(...pending); // rejected callback leaves no ledger writes
    return result;
  },
};
mock.module("@/lib/db", () => ({ db }));
mock.module("@/lib/audit", () => ({ logAudit: async () => {}, AUDIT_ACTIONS: {} }));
const { recordManualPayment, recordGatewayCapture, refundOrVoidBill } =
  await import("../src/lib/billing");

beforeEach(() => {
  bill = {
    id: "b1",
    hotelId: "h1",
    billNumber: "INV1",
    currency: "INR",
    status: "PARTIALLY_PAID",
    totalMinor: 1000,
    paidMinor: 100,
    refundMinor: 0,
  };
  rows = [];
  readers = 0;
  intentStatus = "FAILED";
  captureSequence = 0;
  barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
});
const manual = () =>
  recordManualPayment({
    hotelId: "h1",
    billId: "b1",
    recordedByUserId: "u1",
    method: "CASH",
    amountMinor: 200,
  });
const capture = () => {
  const id = ++captureSequence;
  return recordGatewayCapture({
    hotelId: "h1",
    intentPaymentId: `intent-${id}`,
    gatewayOrderId: `order-${id}`,
    gatewayPaymentId: `capture-${id}`,
    expectedAmountMinor: 200,
  });
};

for (const mode of ["manual/manual", "manual/gateway", "gateway/gateway"] as const) {
  test(`BUG-15 ${mode}: same-status payments cannot lose a balance update`, async () => {
    const ops =
      mode === "manual/manual"
        ? [manual, manual]
        : mode === "manual/gateway"
          ? [manual, capture]
          : [capture, capture];
    const results = await Promise.allSettled(ops.map((op) => op()));
    const successes = results.filter((r) => r.status === "fulfilled" && r.value.ok);
    expect(successes).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(bill.paidMinor).toBe(300);
  });
}

test("BUG-15 same-status partial refunds cannot commit two refunds against one balance", async () => {
  Object.assign(bill, { status: "PARTIALLY_REFUNDED", paidMinor: 1000, refundMinor: 100 });
  const refund = () =>
    refundOrVoidBill({
      hotelId: "h1",
      billId: "b1",
      approvedByUserId: "u1",
      type: "REFUND",
      amountMinor: 600,
      reason: "duplicate meal",
    });
  const results = await Promise.all([refund(), refund()]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(rows).toHaveLength(1);
  expect(bill.refundMinor).toBe(700);
});
