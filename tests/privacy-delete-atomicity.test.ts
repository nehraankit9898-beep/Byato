import "./queue-test-env";
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cleanupQueueTestTmp } from "./queue-test-env";
import { testDb } from "./helpers";

// Real Prisma + LibSQL constraints/transactions, fresh disposable full schema.
const base = testDb();
let failArchive = false;
const db = base.$extends({
  query: {
    hotel: {
      async update({ args, query }) {
        if (failArchive) throw new Error("injected archive failure");
        return query(args);
      },
    },
  },
});
mock.module("@/lib/db", () => ({ db }));
const { executeDeleteRequest } = await import("../src/lib/privacy");

beforeAll(() => {
  const push = spawnSync("bunx", ["prisma", "db", "push", "--skip-generate"], {
    env: process.env,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (push.status !== 0) throw new Error(push.stdout + push.stderr);
}, 150_000);
afterAll(async () => {
  await base.$disconnect();
  cleanupQueueTestTmp();
});

async function fixture(count: number) {
  const hotel = await db.hotel.create({ data: { name: "Disposable privacy tenant" } });
  for (let i = 0; i < count; i++) {
    await db.customer.create({
      data: {
        hotelId: hotel.id,
        name: `Guest ${i}`,
        phone: `+9198765432${i}`,
        email: `guest${i}@example.test`,
        birthday: new Date("1990-01-01"),
        notes: "personal note",
        location: "Jaipur",
        marketingConsent: true,
        emailOptIn: true,
      },
    });
  }
  const request = await db.privacyRequest.create({
    data: {
      hotelId: hotel.id,
      type: "DELETE",
      status: "APPROVED",
      legalReviewBy: "reviewer",
      retentionExpiresAt: new Date(Date.now() - 1000),
    },
  });
  const actor = await db.user.create({
    data: {
      hotelId: hotel.id,
      name: "Owner",
      email: `owner-${hotel.id}@example.test`,
      passwordHash: "not-a-real-password-hash",
      role: "HOTEL_OWNER",
    },
  });
  const owner = {
    userId: actor.id,
    hotelId: hotel.id,
    role: "HOTEL_OWNER" as const,
    email: "owner@example.test",
    name: "Owner",
    hotelName: hotel.name,
    mustChangePassword: false,
    mfaSetupRequired: false,
  };
  return { hotel, request, owner };
}

test("BUG-16 multi-customer deletion preserves phone uniqueness and tenant isolation", async () => {
  const own = await fixture(2);
  const foreign = await fixture(1);
  const result = await executeDeleteRequest(own.owner, own.request.id);
  expect(result.ok).toBe(true);
  const customers = await db.customer.findMany({ where: { hotelId: own.hotel.id } });
  expect(new Set(customers.map((c) => c.phone)).size).toBe(2);
  for (const c of customers) {
    expect(c.name).toBe("[DELETED]");
    expect(c.email).toBeNull();
    expect(c.birthday).toBeNull();
    expect(c.notes).toBeNull();
    expect(c.location).toBeNull();
    expect(c.marketingConsent).toBe(false);
    expect(c.emailOptIn).toBe(false);
    expect(c.optOut).toBe(true);
  }
  expect(
    (await db.privacyRequest.findUniqueOrThrow({ where: { id: own.request.id } })).status,
  ).toBe("COMPLETED");
  expect((await db.hotel.findUniqueOrThrow({ where: { id: own.hotel.id } })).status).toBe(
    "ARCHIVED",
  );
  expect((await db.customer.findFirstOrThrow({ where: { hotelId: foreign.hotel.id } })).name).toBe(
    "Guest 0",
  );
  expect((await executeDeleteRequest(own.owner, own.request.id)).ok).toBe(false);
});

test("BUG-16 a failure rolls back PII changes and the request claim", async () => {
  const own = await fixture(1);
  failArchive = true;
  try {
    await expect(executeDeleteRequest(own.owner, own.request.id)).rejects.toThrow(
      "injected archive failure",
    );
  } finally {
    failArchive = false;
  }
  expect((await db.customer.findFirstOrThrow({ where: { hotelId: own.hotel.id } })).name).toBe(
    "Guest 0",
  );
  expect(
    (await db.privacyRequest.findUniqueOrThrow({ where: { id: own.request.id } })).status,
  ).toBe("APPROVED");
});

test("BUG-16 legal review, retention hold and tenant ownership are enforced", async () => {
  const own = await fixture(1);
  const foreign = await fixture(1);
  expect((await executeDeleteRequest(foreign.owner, own.request.id)).ok).toBe(false);
  await db.privacyRequest.update({
    where: { id: own.request.id },
    data: { retentionExpiresAt: new Date(Date.now() + 60_000) },
  });
  expect((await executeDeleteRequest(own.owner, own.request.id)).ok).toBe(false);
  await db.privacyRequest.update({
    where: { id: own.request.id },
    data: { retentionExpiresAt: new Date(Date.now() - 1000), legalReviewBy: null },
  });
  expect((await executeDeleteRequest(own.owner, own.request.id)).ok).toBe(false);
});
