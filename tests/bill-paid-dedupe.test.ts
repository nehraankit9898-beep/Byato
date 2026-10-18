import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const bill = {
  id: "bill-1",
  hotelId: "hotel-1",
  customerId: "customer-1",
  customerPhone: null,
  status: "PAID",
  totalMinor: 2500,
  currency: "INR",
  billNumber: "FY26-0001",
  issuedByUserId: "cashier-1",
};
const state: { jobs: Array<Record<string, unknown>>; createAttempts: number } = {
  jobs: [],
  createAttempts: 0,
};

const createBillPaidJob = async ({ data }: { data: Record<string, unknown> }) => {
  state.createAttempts += 1;
  if (state.jobs.some((job) => job.type === data.type && job.billId === data.billId)) {
    throw Object.assign(new Error("unique key"), { code: "P2002" });
  }
  state.jobs.push(data);
  return { id: `job-${state.jobs.length}` };
};

mock.module("@/lib/db", () => ({
  db: {
    bill: { findUnique: async () => bill },
    customer: { findFirst: async () => null },
    backgroundJob: { create: createBillPaidJob },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ backgroundJob: { create: createBillPaidJob } }),
  },
}));
mock.module("@/lib/audit", () => ({ logAudit: async () => {}, AUDIT_ACTIONS: {} }));
mock.module("@/lib/coupons", () => ({
  normalizeCouponCode: (value: string) => value,
  validateCoupon: async () => ({ valid: true }),
  computeDiscount: () => 0,
  computeDiscountMinor: () => 0,
}));

const { onBillPaid } = await import("../src/lib/billing");
const ROOT = join(import.meta.dir, "..");

describe("bill-paid outbox deduplication", () => {
  test("duplicate onBillPaid calls are fenced by the database business key", async () => {
    state.jobs = [];
    state.createAttempts = 0;

    await onBillPaid(bill.id);
    await onBillPaid(bill.id);

    expect(state.createAttempts).toBe(2);
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({ type: "RESTAURANT_BILL_PAID", billId: bill.id });
  });

  test("all Prisma schemas and the production migration define the composite unique key", () => {
    for (const file of ["prisma/schema.prisma", "prisma/schema.test.prisma", "prisma/schema.postgres.prisma"]) {
      const schema = readFileSync(join(ROOT, file), "utf8");
      expect(schema).toContain("billId      String?");
      expect(schema).toContain("@@unique([type, billId])");
    }
    const migration = readFileSync(join(ROOT, "prisma/migrations/0015_bill_job_dedupe_key/migration.sql"), "utf8");
    expect(migration).toContain('CREATE UNIQUE INDEX "BackgroundJob_type_billId_key"');
  });
});
