/**
 * DEMO VIDEO SEED — synthetic data for the Byato product demo recording.
 *
 * Run AFTER the standard seeds:
 *   bun run scripts/seed.ts
 *   bun run scripts/seed-phase3-6.ts
 *   bun run scripts/seed-phase63.ts
 *   bun run scripts/seed-demo-video.ts
 *
 * What it creates (all synthetic, all fictional businesses/people):
 *   • Platform Super Admin  — demo.superadmin@byato.test
 *   • Hotel tenant accounts — demo.hoteladmin@byato.test, demo.staff@byato.test
 *                              (Grand Palace Hotel, Jaipur)
 *   • A second hotel tenant  — demo.otheradmin@byato.test (Sea View Resort, Goa)
 *                              used to prove cross-tenant isolation
 *   • A restaurant tenant    — "Saffron Table" (Bandra West, Mumbai) with
 *                              demo.manager@byato.test, menu, tables, QR codes,
 *                              live table sessions, orders in different kitchen
 *                              states and a paid bill.
 *
 * Safety:
 *   • Development-only: refuses to run against PostgreSQL (dev-only guard) and
 *     never touches production data.
 *   • Passwords come from environment variables. When they are not set the
 *     script generates random ones and prints them once (local dev only).
 *   • No real customer data, phone numbers or payment details are used — every
 *     record below is synthetic.
 */
import { randomBytes } from "crypto";
import { writeFileSync } from "fs";
import { createScriptPrismaClient } from "./prisma-client";
import { assertDevOnlyScript } from "./dev-only-guard";
import { ensureDefaultFeatureFlags, ensurePlansSeed } from "../src/lib/super-admin";
import { beginMfaSetup, confirmMfaSetup, generateTotp } from "../src/lib/mfa";

assertDevOnlyScript("seed-demo-video");

const db = createScriptPrismaClient();

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  // scrypt via node:crypto (same format as src/lib/auth.ts)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { scryptSync } = require("crypto") as typeof import("crypto");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function demoPassword(envName: string, prefix: string): string {
  const fromEnv = (process.env[envName] || "").trim();
  if (fromEnv) return fromEnv;
  return `${prefix}-${randomBytes(9).toString("base64url")}7x`;
}

function daysAgo(n: number, hour = 12): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function token(len = 24): string {
  return randomBytes(len).toString("base64url");
}

async function upsertUser(params: {
  email: string;
  name: string;
  role: string;
  hotelId: string | null;
  password: string;
}) {
  const passwordHash = hashPassword(params.password);
  const existing = await db.user.findUnique({ where: { email: params.email } });
  if (existing) {
    await db.user.update({
      where: { id: existing.id },
      data: {
        name: params.name,
        role: params.role as never,
        hotelId: params.hotelId,
        passwordHash,
        status: "ACTIVE",
        emailVerified: new Date(),
        mustChangePassword: false,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
    return existing.id;
  }
  const created = await db.user.create({
    data: {
      email: params.email,
      name: params.name,
      role: params.role as never,
      hotelId: params.hotelId,
      passwordHash,
      status: "ACTIVE",
      emailVerified: new Date(),
      mustChangePassword: false,
    },
  });
  return created.id;
}

async function main() {
  await ensurePlansSeed();

  const plan = await db.plan.findUnique({ where: { name: "PROFESSIONAL" } });
  if (!plan) throw new Error("PROFESSIONAL plan missing — run scripts/seed-phase3-6.ts first");

  const palace = await db.hotel.findFirst({ where: { name: "Grand Palace Hotel" } });
  const seaView = await db.hotel.findFirst({ where: { name: "Sea View Resort" } });
  if (!palace || !seaView) {
    throw new Error("Base seed missing (Grand Palace Hotel / Sea View Resort) — run scripts/seed.ts first");
  }

  // Give the base tenants the demo plan + subscription so limits never bite.
  for (const h of [palace, seaView]) {
    await db.hotel.update({ where: { id: h.id }, data: { planId: plan.id } });
    const sub = await db.subscription.findFirst({ where: { hotelId: h.id } });
    if (!sub) {
      await db.subscription.create({
        data: {
          hotelId: h.id,
          planId: plan.id,
          status: "ACTIVE",
          amount: plan.monthlyPrice,
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });
    }
    await ensureDefaultFeatureFlags(h.id);
  }

  // ── Accounts (fictional, clearly-labelled demo identities) ──────────────
  const passwords = {
    super: demoPassword("DEMO_SUPER_ADMIN_PASSWORD", "super"),
    hotelAdmin: demoPassword("DEMO_HOTEL_ADMIN_PASSWORD", "hotel"),
    staff: demoPassword("DEMO_STAFF_PASSWORD", "staff"),
    otherAdmin: demoPassword("DEMO_OTHER_ADMIN_PASSWORD", "other"),
    manager: demoPassword("DEMO_MANAGER_PASSWORD", "manager"),
  };

  const superAdminId = await upsertUser({
    email: "demo.superadmin@byato.test",
    name: "Platform Operator",
    role: "SUPER_ADMIN",
    hotelId: null,
    password: passwords.super,
  });

  const hotelAdminId = await upsertUser({
    email: "demo.hoteladmin@byato.test",
    name: "Ira Sharma",
    role: "HOTEL_ADMIN",
    hotelId: palace.id,
    password: passwords.hotelAdmin,
  });

  const staffId = await upsertUser({
    email: "demo.staff@byato.test",
    name: "Dev Menon",
    role: "HOTEL_STAFF",
    hotelId: palace.id,
    password: passwords.staff,
  });

  const otherAdminId = await upsertUser({
    email: "demo.otheradmin@byato.test",
    name: "Nikhil Rao",
    role: "HOTEL_ADMIN",
    hotelId: seaView.id,
    password: passwords.otherAdmin,
  });

  // ── Restaurant tenant ───────────────────────────────────────────────────
  let restaurant = await db.hotel.findFirst({ where: { name: "Saffron Table" } });
  if (!restaurant) {
    restaurant = await db.hotel.create({
      data: {
        name: "Saffron Table",
        location: "Bandra West, Mumbai",
        city: "Mumbai",
        state: "Maharashtra",
        country: "India",
        phone: "+912200000000",
        email: "hello@saffrontable.test",
        tenantId: "tenant-saffron-table",
        planId: plan.id,
        currency: "INR",
        timezone: "Asia/Kolkata",
      },
    });
  }
  const restaurantId = restaurant.id;
  await db.hotel.update({ where: { id: restaurantId }, data: { planId: plan.id } });
  const restSub = await db.subscription.findFirst({ where: { hotelId: restaurantId } });
  if (!restSub) {
    await db.subscription.create({
      data: {
        hotelId: restaurantId,
        planId: plan.id,
        status: "ACTIVE",
        amount: plan.monthlyPrice,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
  }
  await ensureDefaultFeatureFlags(restaurantId);

  const managerId = await upsertUser({
    email: "demo.manager@byato.test",
    name: "Karan Bhatia",
    role: "RESTAURANT_MANAGER",
    hotelId: restaurantId,
    password: passwords.manager,
  });

  // Restaurant floor staff — role-scoped views (floor/orders, kitchen display)
  const waiterId = await upsertUser({
    email: "demo.waiter@byato.test",
    name: "Farah Qureshi",
    role: "WAITER",
    hotelId: restaurantId,
    password: demoPassword("DEMO_WAITER_PASSWORD", "waiter"),
  });

  const kitchenId = await upsertUser({
    email: "demo.kitchen@byato.test",
    name: "Ravi Pillai",
    role: "KITCHEN_STAFF",
    hotelId: restaurantId,
    password: demoPassword("DEMO_KITCHEN_PASSWORD", "kitchen"),
  });
  void waiterId;
  void kitchenId;

  // Menu
  const existingCats = await db.menuCategory.count({ where: { hotelId: restaurantId } });
  if (existingCats === 0) {
    const starters = await db.menuCategory.create({
      data: { hotelId: restaurantId, name: "Starters", description: "Small plates to share", sortOrder: 0 },
    });
    const mains = await db.menuCategory.create({
      data: { hotelId: restaurantId, name: "Main Course", description: "From the tandoor & kadhai", sortOrder: 1 },
    });
    const breads = await db.menuCategory.create({
      data: { hotelId: restaurantId, name: "Breads & Rice", sortOrder: 2 },
    });
    const drinks = await db.menuCategory.create({
      data: { hotelId: restaurantId, name: "Beverages", sortOrder: 3 },
    });

    await db.menuItem.create({
      data: {
        hotelId: restaurantId,
        categoryId: starters.id,
        name: "Paneer Tikka",
        description: "Char-grilled cottage cheese, mint chutney",
        priceMinor: 28000,
        prepMinutes: 15,
        dietaryTags: '["VEG","SPICY"]',
        sortOrder: 0,
      },
    });
    await db.menuItem.create({
      data: {
        hotelId: restaurantId,
        categoryId: starters.id,
        name: "Chicken 65",
        description: "Crispy fried chicken, curry leaf dip",
        priceMinor: 34000,
        prepMinutes: 18,
        dietaryTags: '["NON_VEG"]',
        sortOrder: 1,
      },
    });
    await db.menuItem.create({
      data: {
        hotelId: restaurantId,
        categoryId: mains.id,
        name: "Butter Chicken",
        description: "Slow-cooked tomato gravy, cream and fenugreek",
        priceMinor: 42000,
        prepMinutes: 22,
        dietaryTags: '["NON_VEG"]',
        sortOrder: 0,
      },
    });
    await db.menuItem.create({
      data: {
        hotelId: restaurantId,
        categoryId: mains.id,
        name: "Dal Makhani",
        description: "Black lentils simmered overnight on coal",
        priceMinor: 32000,
        prepMinutes: 15,
        dietaryTags: '["VEG"]',
        sortOrder: 1,
      },
    });
    await db.menuItem.create({
      data: {
        hotelId: restaurantId,
        categoryId: breads.id,
        name: "Tandoori Roti (3)",
        description: "Clay oven baked",
        priceMinor: 9000,
        prepMinutes: 8,
        dietaryTags: '["VEG"]',
        sortOrder: 0,
      },
    });
    await db.menuItem.create({
      data: {
        hotelId: restaurantId,
        categoryId: breads.id,
        name: "Jeera Rice",
        description: "Basmati rice tempered with cumin",
        priceMinor: 22000,
        prepMinutes: 12,
        dietaryTags: '["VEG"]',
        sortOrder: 1,
      },
    });
    await db.menuItem.create({
      data: {
        hotelId: restaurantId,
        categoryId: drinks.id,
        name: "Masala Chai",
        description: "Ginger cardamom milk tea",
        priceMinor: 12000,
        prepMinutes: 5,
        dietaryTags: '["VEG"]',
        sortOrder: 0,
      },
    });
    await db.menuItem.create({
      data: {
        hotelId: restaurantId,
        categoryId: drinks.id,
        name: "Sweet Lassi",
        description: "Chilled thick yoghurt drink",
        priceMinor: 16000,
        prepMinutes: 4,
        dietaryTags: '["VEG"]',
        sortOrder: 1,
      },
    });
  }

  // Tables + QR codes
  const tableDefs = [
    { number: "T1", capacity: 2, zone: "Window" },
    { number: "T2", capacity: 4, zone: "Main hall" },
    { number: "T3", capacity: 6, zone: "Main hall" },
    { number: "T4", capacity: 4, zone: "Main hall" },
    { number: "G1", capacity: 4, zone: "Garden" },
  ];
  const tables: Record<string, string> = {};
  for (const t of tableDefs) {
    let table = await db.diningTable.findFirst({ where: { hotelId: restaurantId, number: t.number } });
    if (!table) {
      table = await db.diningTable.create({
        data: {
          hotelId: restaurantId,
          number: t.number,
          capacity: t.capacity,
          zone: t.zone,
          qrCodes: { create: { hotelId: restaurantId, code: token(), type: "ORDER", label: `Table ${t.number}` } },
        },
      });
    }
    tables[t.number] = table.id;
  }

  // Diners (synthetic) for the restaurant tenant
  const diners = [
    { name: "Anika Bose", phone: "+919800000101" },
    { name: "Rohan Khanna", phone: "+919800000102" },
    { name: "Simran Kaur", phone: "+919800000103" },
    { name: "Vikram Joshi", phone: "+919800000104" },
  ];
  const dinerIds: string[] = [];
  for (const d of diners) {
    const existing = await db.customer.findFirst({
      where: { hotelId: restaurantId, phone: d.phone },
    });
    if (existing) {
      dinerIds.push(existing.id);
      continue;
    }
    const c = await db.customer.create({
      data: {
        hotelId: restaurantId,
        name: d.name,
        phone: d.phone,
        marketingConsent: true,
        consentTimestamp: daysAgo(40),
        consentSource: "QR_PAGE",
        source: "QR_PAGE",
        whatsappOptIn: true,
        smsOptIn: true,
        vip: d.name === "Anika Bose",
        diningFrequency: 4,
        totalRestaurantVisits: 4,
        totalRestaurantSpend: 6480,
        lastRestaurantVisit: daysAgo(2),
        customerValueScore: 72,
        recencyScore: 80,
        frequencyScore: 64,
        monetaryScore: 71,
      },
    });
    dinerIds.push(c.id);
    await db.loyaltyAccount.create({
      data: {
        hotelId: restaurantId,
        customerId: c.id,
        points: 320,
        lifetimePoints: 980,
        lifetimeSpend: 6480,
        visitsCounted: 4,
        tier: d.name === "Anika Bose" ? "GOLD" : "SILVER",
      },
    });
    for (let i = 0; i < 4; i++) {
      await db.restaurantVisit.create({
        data: {
          hotelId: restaurantId,
          customerId: c.id,
          visitDate: daysAgo(6 * (i + 1) + 1, 20),
          tableNumber: tableDefs[i % tableDefs.length].number,
          guests: 2,
          orderAmount: 1620,
          foodCategory: "NON_VEG",
          source: i % 2 === 0 ? "QR_MENU" : "WALK_IN",
        },
      });
    }
  }

  // Live table sessions + orders in different kitchen states
  const menu = await db.menuItem.findMany({ where: { hotelId: restaurantId } });
  const byName = (n: string) => menu.find((m) => m.name === n)!;

  const orderDefs = [
    { table: "T2", status: "PREPARING", items: [["Butter Chicken", 2], ["Garlic Naan", 1]] },
    { table: "T3", status: "PLACED", items: [["Paneer Tikka", 1], ["Dal Makhani", 1]] },
    { table: "T4", status: "READY", items: [["Chicken 65", 1], ["Sweet Lassi", 2]] },
    { table: "G1", status: "SERVED", items: [["Butter Chicken", 1], ["Masala Chai", 2]] },
  ] as const;

  let orderSeq = (await db.diningOrder.count({ where: { hotelId: restaurantId } })) + 1;
  for (const def of orderDefs) {
    const tableId = tables[def.table];
    // Idempotent: a table may only have ONE open session (DB-enforced).
    const openSession = await db.tableSession.findFirst({
      where: { tableId, status: "OPEN" },
    });
    if (openSession) continue;
    const session = await db.tableSession.create({
      data: {
        hotelId: restaurantId,
        tableId,
        status: "OPEN",
        guestName: diners[orderSeq % diners.length].name,
        guestPhone: diners[orderSeq % diners.length].phone,
        openedAt: new Date(Date.now() - 20 * 60 * 1000),
        publicToken: token(),
        openFence: 1,
      },
    });
    let subtotal = 0;
    for (const [name, qty] of def.items) {
      const item = byName(name as string) ?? byName("Masala Chai");
      subtotal += item.priceMinor * qty;
    }
    const order = await db.diningOrder.create({
      data: {
        hotelId: restaurantId,
        tableSessionId: session.id,
        tableId,
        orderNumber: orderSeq++,
        status: def.status,
        source: "QR_CUSTOMER",
        subtotalMinor: subtotal,
        totalMinor: subtotal + Math.round(subtotal * 0.05),
        currency: "INR",
        customerName: session.guestName,
        customerPhone: session.guestPhone,
        publicToken: token(),
        placedAt: new Date(Date.now() - 18 * 60 * 1000),
      },
    });
    // Line items are written after the order row exists (FK).
    for (const [name, qty] of def.items) {
      const item = byName(name as string) ?? byName("Masala Chai");
      await db.orderItem.create({
        data: {
          orderId: order.id,
          menuItemId: item.id,
          nameSnapshot: item.name,
          unitPriceMinor: item.priceMinor,
          quantity: qty,
          lineTotalMinor: item.priceMinor * qty,
          status:
            def.status === "PREPARING"
              ? "PREPARING"
              : def.status === "READY"
                ? "READY"
                : def.status === "SERVED"
                  ? "SERVED"
                  : "PENDING",
        },
      });
    }
  }

  // A paid bill for the POS screen
  const tableT2 = tables.T2;
  const paidSession = await db.tableSession.findFirst({
    where: { hotelId: restaurantId, tableId: tableT2, status: "CLOSED" },
  });
  if (!paidSession) {
    const s = await db.tableSession.create({
      data: {
        hotelId: restaurantId,
        tableId: tableT2,
        status: "CLOSED",
        guestName: "Rohan Khanna",
        guestPhone: "+919800000102",
        openedAt: daysAgo(1, 19),
        closedAt: daysAgo(1, 21),
        publicToken: token(),
      },
    });
    await db.bill.create({
      data: {
        hotelId: restaurantId,
        billNumber: "INV/2026-27/000101",
        series: "SAFFRON",
        seqNumber: 101,
        status: "PAID",
        tableSessionId: s.id,
        tableId: tableT2,
        currency: "INR",
        subtotalMinor: 118000,
        taxMinor: 16520,
        totalMinor: 134520,
        paidMinor: 134520,
        customerName: "Rohan Khanna",
        customerPhone: "+919800000102",
        issuedByUserId: managerId,
        paidAt: daysAgo(1, 21),
      },
    });
  }

  // A loyalty QR code for the restaurant (public join page used in the demo)
  let loyaltyQr = await db.qRCode.findFirst({
    where: { hotelId: restaurantId, type: "LOYALTY" },
  });
  if (!loyaltyQr) {
    loyaltyQr = await db.qRCode.create({
      data: {
        hotelId: restaurantId,
        code: token(18),
        type: "LOYALTY",
        label: "Saffron Table — loyalty sign-up",
        scans: 412,
        joins: 96,
        lastScanAt: daysAgo(0, 11),
      },
    });
  }

  // Audit trail entry so the platform audit log has content
  await db.auditLog.create({
    data: {
      hotelId: restaurantId,
      userId: managerId,
      action: "DEMO_SEED",
      entityType: "hotel",
      entityId: restaurantId,
      metadata: JSON.stringify({ note: "Synthetic demo dataset for the Byato product demo" }),
      createdAt: daysAgo(0, 10),
    },
  });

  // ── MFA enrolment for the platform operator ────────────────────────────
  // MFA is MANDATORY for SUPER_ADMIN (platform policy): an enrolled operator
  // signs in with password + TOTP. The demo needs a working factor, so the
  // TOTP secret is generated here and written to .dev-mfa-secret (git
  // ignored) for the recording script — it is a local demo value only.
  // The factor is re-created on every run so the recorded demo always has a
  // secret that matches .dev-mfa-secret.
  await db.user.update({
    where: { id: superAdminId },
    data: { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: null, mfaLastUsedStep: null },
  });
  const setup = await beginMfaSetup(superAdminId);
  const confirmed = await confirmMfaSetup(superAdminId, generateTotp(setup.secret));
  if (!confirmed.ok) throw new Error("MFA enrolment failed: " + confirmed.error);
  writeFileSync(".dev-mfa-secret", `${setup.secret}\n`, { mode: 0o600 });
  console.log("\n  TOTP secret for the demo operator written to .dev-mfa-secret (git ignored).");

  console.log("✓ Demo video seed complete.\n");
  console.log("Demo accounts (fictional — local development only):");
  console.log(`  Super Admin        demo.superadmin@byato.test  / ${passwords.super}`);
  console.log(`  Hotel Admin        demo.hoteladmin@byato.test  / ${passwords.hotelAdmin}  (Grand Palace Hotel)`);
  console.log(`  Hotel Staff        demo.staff@byato.test       / ${passwords.staff}  (Grand Palace Hotel)`);
  console.log(`  Other Tenant Admin demo.otheradmin@byato.test / ${passwords.otherAdmin}  (Sea View Resort)`);
  console.log(`  Restaurant Manager demo.manager@byato.test    / ${passwords.manager}  (Saffron Table, Mumbai)`);
  console.log(`\n  Public loyalty QR for the demo: /r/${loyaltyQr.code}`);
  console.log(`  Hotel admin id: ${hotelAdminId} · staff id: ${staffId} · other admin id: ${otherAdminId} · super admin id: ${superAdminId}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
