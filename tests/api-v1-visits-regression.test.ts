import { afterAll, expect, test } from "bun:test";
import { testDb, apiCall } from "./helpers";

const db = testDb();

afterAll(async () => {
  await db.$disconnect();
});

test("concurrent v1 requests for the same customer and check-in create only one visit", async () => {
  const { generateApiKey, hashApiKey } = await import("../src/lib/api-keys");
  const suffix = Date.now();
  const rawKey = generateApiKey();
  const plan = await db.plan.create({
    data: {
      name: `VISIT-RACE-${suffix}`,
      key: `visit-race-${suffix}`,
      apiAccess: true,
      isActive: true,
      isPublic: false,
    },
  });
  const hotel = await db.hotel.create({
    data: { name: `Visit Race Hotel ${suffix}`, status: "ACTIVE", planId: plan.id },
  });

  try {
    const customer = await db.customer.create({
      data: {
        hotelId: hotel.id,
        name: "Visit race customer",
        phone: `+9198${String(suffix).slice(-8)}`,
      },
    });
    await db.apiKey.create({
      data: {
        hotelId: hotel.id,
        name: "visit race regression key",
        prefix: rawKey.slice(0, 14),
        keyHash: hashApiKey(rawKey),
        status: "ACTIVE",
        scopes: JSON.stringify(["read", "write"]),
      },
    });

    const results = await Promise.all([
      apiCall("POST", "/api/v1/visits", {
        bearer: rawKey,
        body: { phone: customer.phone, checkin: "2026-10-20" },
      }),
      // Datetime input is accepted by parseCsvDate; it must still collide
      // with the date-only visit because the API promises one per calendar day.
      apiCall("POST", "/api/v1/visits", {
        bearer: rawKey,
        body: { phone: customer.phone, checkin: "2026-10-20T12:00" },
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);

    // Identical payloads also race the old check-then-create code path: both
    // callers could see no visit before either created one.
    const sameTimestamp = { phone: customer.phone, checkin: "2026-10-21" };
    const concurrentDuplicates = await Promise.all([
      apiCall("POST", "/api/v1/visits", { bearer: rawKey, body: sameTimestamp }),
      apiCall("POST", "/api/v1/visits", { bearer: rawKey, body: sameTimestamp }),
    ]);
    expect(concurrentDuplicates.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(await db.visit.count({ where: { hotelId: hotel.id, customerId: customer.id } })).toBe(2);
  } finally {
    await db.hotel.delete({ where: { id: hotel.id } }).catch(() => undefined);
    await db.plan.delete({ where: { id: plan.id } }).catch(() => undefined);
  }
});
