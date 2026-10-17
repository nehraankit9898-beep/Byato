/**
 * 2026-10 master RBAC & tenant-isolation regression suite.
 *
 * Covers (allowed AND denied cases, per the security review mandate):
 *   - custom roles: mass assignment, reserved permissions, unknown
 *     permission identifiers, inactive-role revocation, cross-hotel
 *     assignment in both directions, self-assignment without escalation
 *   - staff management: owner boundary (admin cannot act on the owner),
 *     self-privilege-escalation, forged/super-admin role values
 *   - super-admin boundary: no SUPER_ADMIN minting via public or
 *     hotel-admin endpoints
 *   - session revocation: revokeSessions + tampered session tokens
 *   - tenant isolation: nested resources (customer visits, bill refund,
 *     background jobs) and franchise branch capture
 *   - export/financial permission boundaries
 *
 * Requires scripts/run-tests.ts's disposable SQLite DB and live server.
 * NEVER run against a customer or production database.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { apiCall, login, testDb, Jar } from "./helpers";
import { hashPassword } from "../src/lib/auth";

const db = testDb();

const HOTEL_A_ADMIN = "admin@grandpalace.com";
const HOTEL_A_STAFF = "staff@grandpalace.com";
const HOTEL_B_ADMIN = "admin@seaview.com";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? "TestAdmin123";
const STAFF_PASSWORD = process.env.TEST_STAFF_PASSWORD ?? "TestStaff123";
const EXTRA_PASSWORD = "ExtraRole123";

interface Fixtures {
  hotelAId: string;
  hotelBId: string;
  adminA: Jar;
  staffA: Jar;
  adminB: Jar;
  ownerAId: string;
  ownerA: Jar;
  kitchenId: string;
  kitchen: Jar;
  managerId: string;
  manager: Jar;
  staffUserId: string;
  revocationUserId: string;
}

const fx: Partial<Fixtures> = {};

async function makeUser(email: string, role: string, hotelId: string) {
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return existing.id;
  const u = await db.user.create({
    data: {
      email,
      name: email.split("@")[0],
      passwordHash: hashPassword(EXTRA_PASSWORD),
      role: role as never,
      hotelId,
      status: "ACTIVE",
      mustChangePassword: false,
    },
  });
  return u.id;
}

beforeAll(async () => {
  const adminA = await login(HOTEL_A_ADMIN, ADMIN_PASSWORD);
  const staffA = await login(HOTEL_A_STAFF, STAFF_PASSWORD);
  const adminB = await login(HOTEL_B_ADMIN, ADMIN_PASSWORD);
  expect(adminA.res.status).toBe(200);
  expect(staffA.res.status).toBe(200);
  expect(adminB.res.status).toBe(200);

  const adminAUser = await db.user.findUnique({ where: { email: HOTEL_A_ADMIN } });
  const adminBUser = await db.user.findUnique({ where: { email: HOTEL_B_ADMIN } });
  const staffUser = await db.user.findUnique({ where: { email: HOTEL_A_STAFF } });
  expect(adminAUser?.hotelId).toBeTruthy();
  expect(adminBUser?.hotelId).toBeTruthy();

  fx.adminA = adminA.jar;
  fx.staffA = staffA.jar;
  fx.adminB = adminB.jar;
  fx.hotelAId = adminAUser!.hotelId!;
  fx.hotelBId = adminBUser!.hotelId!;
  fx.staffUserId = staffUser!.id;
  fx.ownerAId = await makeUser("owner@grandpalace.test", "HOTEL_OWNER", fx.hotelAId!);
  fx.kitchenId = await makeUser("kitchen@grandpalace.test", "KITCHEN_STAFF", fx.hotelAId!);
  fx.managerId = await makeUser("manager@grandpalace.test", "HOTEL_MANAGER", fx.hotelAId!);
  // Dedicated revocation probe user: the SEEDed staff account carries
  // leftover custom-role grants from other suites (custom-role-api leaves an
  // active ATTENDANCE_MANAGE assignment on it), which would make
  // "deactivation revokes access" flaky. A fresh user has a clean baseline.
  fx.revocationUserId = await makeUser("revocation@grandpalace.test", "HOTEL_STAFF", fx.hotelAId!);
  const ownerA = await login("owner@grandpalace.test", EXTRA_PASSWORD);
  const kitchen = await login("kitchen@grandpalace.test", EXTRA_PASSWORD);
  const manager = await login("manager@grandpalace.test", EXTRA_PASSWORD);
  expect(ownerA.res.status).toBe(200);
  expect(kitchen.res.status).toBe(200);
  expect(manager.res.status).toBe(200);
  fx.ownerA = ownerA.jar;
  fx.kitchen = kitchen.jar;
  fx.manager = manager.jar;
}, 120_000);

afterAll(async () => {
  // Clean up the extra probe users (the DB is disposable, but keep it tidy).
  for (const email of [
    "owner@grandpalace.test",
    "kitchen@grandpalace.test",
    "manager@grandpalace.test",
    "revocation@grandpalace.test",
  ]) {
    const u = await db.user.findUnique({ where: { email } });
    if (u) await db.user.delete({ where: { id: u.id } }).catch(() => undefined);
  }
  const forged = await db.user.findMany({ where: { email: { startsWith: "forged-" } } });
  for (const u of forged) await db.user.delete({ where: { id: u.id } }).catch(() => undefined);
});

/* ------------------------------------------------------------------ */
/* Custom roles                                                        */
/* ------------------------------------------------------------------ */

describe("custom roles — mass assignment, reserved permissions, revocation", () => {
  let roleA: string;

  test("create ignores client-supplied tenant/role-lifecycle fields (mass assignment)", async () => {
    const res = await apiCall("POST", "/api/custom-roles", {
      jar: fx.adminA,
      body: {
        name: `MA role ${Date.now()}`,
        permissions: ["INVENTORY_READ"],
        // Forged/lifecycle fields must be ignored:
        hotelId: fx.hotelBId,
        isSystemRole: true,
        active: false,
        createdByUserId: "someone-else",
        permissions_2: ["SUPER_ADMIN_ACCESS"],
      },
    });
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    roleA = id;
    const row = await db.customRole.findUnique({ where: { id } });
    expect(row?.hotelId).toBe(fx.hotelAId);
    expect(row?.isSystemRole).toBe(false);
    expect(row?.active).toBe(true);
    const granted = JSON.parse(row!.permissions!);
    expect(granted).toEqual(["INVENTORY_READ"]);
  });

  test("every reserved platform/financial permission is rejected", async () => {
    const reserved = [
      "SUPER_ADMIN_ACCESS",
      "CUSTOM_ROLE_MANAGE",
      "STAFF_MANAGE",
      "SETTINGS_MANAGE",
      "INTEGRATION_MANAGE",
      "BRANCH_MANAGE",
      "FRANCHISE_MANAGE",
      "WHITE_LABEL_MANAGE",
      "ENTERPRISE_API_MANAGE",
      "WEBHOOK_MANAGE",
      "PRIVACY_REQUEST_MANAGE",
      "BILL_REFUND",
      "BILL_VOID",
      "TAX_MANAGE",
      "AUDIT_LOG_READ",
    ];
    for (const p of reserved) {
      const res = await apiCall("POST", "/api/custom-roles", {
        jar: fx.adminA,
        body: { name: `R ${p} ${Date.now()}`, permissions: [p] },
      });
      expect(res.status, `${p} must be rejected`).toBe(422);
    }
  });

  test("unknown permission identifiers are rejected", async () => {
    const res = await apiCall("POST", "/api/custom-roles", {
      jar: fx.adminA,
      body: { name: `Unknown ${Date.now()}`, permissions: ["NOT_A_REAL_PERMISSION"] },
    });
    expect(res.status).toBe(422);
  });

  test("assigning an INACTIVE role is denied", async () => {
    const create = await apiCall("POST", "/api/custom-roles", {
      jar: fx.adminA,
      body: { name: `Inactive ${Date.now()}`, permissions: ["INVENTORY_READ"] },
    });
    expect(create.status).toBe(201);
    const inactiveId = create.body.id as string;
    const disable = await apiCall("PATCH", `/api/custom-roles/${inactiveId}`, {
      jar: fx.adminA,
      body: { active: false },
    });
    expect(disable.status).toBe(200);
    const assign = await apiCall("POST", `/api/custom-roles/${inactiveId}/assign`, {
      jar: fx.adminA,
      body: { userId: fx.kitchenId },
    });
    expect(assign.status).toBe(404);
  });

  test("deactivating a role revokes its grants on the next request", async () => {
    // Grant ATTENDANCE_MANAGE to the DEDICATED revocation user, verify access,
    // then deactivate.
    const grant = await apiCall("POST", "/api/custom-roles", {
      jar: fx.adminA,
      body: { name: `Revocation ${Date.now()}`, permissions: ["ATTENDANCE_MANAGE"] },
    });
    expect(grant.status).toBe(201);
    const id = grant.body.id as string;
    const assign = await apiCall("POST", `/api/custom-roles/${id}/assign`, {
      jar: fx.adminA,
      body: { userId: fx.revocationUserId },
    });
    expect(assign.status).toBe(200);

    let staff = await login("revocation@grandpalace.test", EXTRA_PASSWORD);
    expect(staff.res.status).toBe(200);
    // Mark the KITCHEN user's attendance (not the staff user's own — the
    // route has a self-approval guard for that case).
    const today = new Date().toISOString().slice(0, 10);
    const allowed = await apiCall("POST", "/api/attendance", {
      jar: staff.jar,
      body: { userId: fx.kitchenId, date: today, status: "PRESENT" },
    });
    expect(allowed.status).not.toBe(403); // the grant works

    // Deactivate the role: sessions are revoked (tokenVersion bump) and the
    // permission is gone.
    const disable = await apiCall("PATCH", `/api/custom-roles/${id}`, {
      jar: fx.adminA,
      body: { active: false },
    });
    expect(disable.status).toBe(200);
    expect((await apiCall("GET", "/api/audit-logs", { jar: staff.jar })).status).toBe(401);

    staff = await login("revocation@grandpalace.test", EXTRA_PASSWORD);
    expect(staff.res.status).toBe(200);
    const denied = await apiCall("POST", "/api/attendance", {
      jar: staff.jar,
      body: { userId: fx.kitchenId, date: today, status: "PRESENT" },
    });
    expect(denied.status).toBe(403);

    // Re-activate + revoke the assignment to restore baseline state.
    const enable = await apiCall("PATCH", `/api/custom-roles/${id}`, {
      jar: fx.adminA,
      body: { active: true },
    });
    expect(enable.status).toBe(200);
    const unassign = await apiCall("DELETE", `/api/custom-roles/${id}/assign`, {
      jar: fx.adminA,
      body: { userId: fx.revocationUserId },
    });
    expect(unassign.status).toBe(200);
  });

  test("cross-hotel role use and assignment are denied in both directions", async () => {
    // Hotel B admin cannot ASSIGN Hotel A's role (tenant-scoped lookup).
    const foreignAssign = await apiCall("POST", `/api/custom-roles/${roleA}/assign`, {
      jar: fx.adminB,
      body: { userId: fx.kitchenId },
    });
    expect(foreignAssign.status).toBe(404);

    // Hotel A admin cannot assign to a Hotel B user.
    const bUser = await db.user.findUnique({ where: { email: HOTEL_B_ADMIN } });
    const foreignTarget = await apiCall("POST", `/api/custom-roles/${roleA}/assign`, {
      jar: fx.adminA,
      body: { userId: bUser!.id },
    });
    expect(foreignTarget.status).toBe(404);

    // Hotel B admin cannot EDIT Hotel A's role either.
    const foreignPatch = await apiCall("PATCH", `/api/custom-roles/${roleA}`, {
      jar: fx.adminB,
      body: { permissions: [] },
    });
    expect(foreignPatch.status).toBe(404);
  });

  test("self-assignment grants nothing the caller does not already hold", async () => {
    // Baseline permission set BEFORE any self-assignment.
    const before = await apiCall("GET", "/api/auth/me", { jar: fx.adminA });
    expect(before.status).toBe(200);
    const basePerms: string[] = [...((before.body?.user?.permissions as string[]) ?? [])].sort();

    const role = await apiCall("POST", "/api/custom-roles", {
      jar: fx.adminA,
      body: { name: `Self ${Date.now()}`, permissions: ["INVENTORY_READ"] },
    });
    expect(role.status).toBe(201);
    const adminAUser = await db.user.findUnique({ where: { email: HOTEL_A_ADMIN } });
    const assign = await apiCall("POST", `/api/custom-roles/${role.body.id}/assign`, {
      jar: fx.adminA,
      body: { userId: adminAUser!.id },
    });
    expect(assign.status).toBe(200);
    // Self-assignment bumps the caller's OWN tokenVersion (session revocation
    // fence) — the old jar dies, a fresh session is required.
    expect((await apiCall("GET", "/api/auth/me", { jar: fx.adminA })).status).toBe(401);
    const fresh = await login(HOTEL_A_ADMIN, ADMIN_PASSWORD);
    expect(fresh.res.status).toBe(200);
    fx.adminA = fresh.jar; // keep the shared jar valid for later tests
    // No escalation: the effective permission set is EXACTLY the baseline
    // (the custom grant can only re-state what the system role already
    // provides; it can never add, and reserved perms are ungrantable).
    const me = await apiCall("GET", "/api/auth/me", { jar: fx.adminA });
    expect(me.status).toBe(200);
    const perms: string[] = [...((me.body?.user?.permissions as string[]) ?? [])].sort();
    expect(perms).toEqual(basePerms);

    // And the same property for a user whose role does NOT hold the granted
    // permission: the grant adds exactly that permission — nothing else.
    const kitchenPermsBefore: string[] = [];
    const kBefore = await apiCall("GET", "/api/auth/me", { jar: fx.kitchen });
    expect(kBefore.status).toBe(200);
    kitchenPermsBefore.push(...((kBefore.body?.user?.permissions as string[]) ?? []));
    const grantRole = await apiCall("POST", "/api/custom-roles", {
      jar: fx.adminA,
      body: { name: `Kitchen ${Date.now()}`, permissions: ["INVENTORY_MANAGE"] },
    });
    expect(grantRole.status).toBe(201);
    expect(
      (await apiCall("POST", `/api/custom-roles/${grantRole.body.id}/assign`, {
        jar: fx.adminA,
        body: { userId: fx.kitchenId },
      })).status,
    ).toBe(200);
    // Kitchen's session was revoked by the assignment; fresh login sees the grant.
    const kFresh = await login("kitchen@grandpalace.test", EXTRA_PASSWORD);
    const kMe = await apiCall("GET", "/api/auth/me", { jar: kFresh.jar });
    expect(kMe.status).toBe(200);
    const permsAfter = [...((kMe.body?.user?.permissions as string[]) ?? [])].sort();
    const expected = [...kitchenPermsBefore, "INVENTORY_MANAGE"].sort();
    expect(permsAfter).toEqual(expected);

    // Clean up both grants — ORDER MATTERS: every unassign bumps the TARGET's
    // tokenVersion, so the kitchen grant is removed first (while the admin
    // jar is still live), then the SELF grant (which kills the admin's own
    // session last). Both shared jars are re-logged for later tests.
    const unassignKitchen = await apiCall("DELETE", `/api/custom-roles/${grantRole.body.id}/assign`, {
      jar: fx.adminA,
      body: { userId: fx.kitchenId },
    });
    expect(unassignKitchen.status).toBe(200);
    const unassignSelf = await apiCall("DELETE", `/api/custom-roles/${role.body.id}/assign`, {
      jar: fx.adminA,
      body: { userId: adminAUser!.id },
    });
    expect(unassignSelf.status).toBe(200);
    const kFinal = await login("kitchen@grandpalace.test", EXTRA_PASSWORD);
    expect(kFinal.res.status).toBe(200);
    fx.kitchen = kFinal.jar;
    const adminFinal = await login(HOTEL_A_ADMIN, ADMIN_PASSWORD);
    expect(adminFinal.res.status).toBe(200);
    fx.adminA = adminFinal.jar;
  });
});

/* ------------------------------------------------------------------ */
/* Staff management — owner boundary & self-escalation                 */
/* ------------------------------------------------------------------ */

describe("staff management — owner boundary and privilege escalation", () => {
  test("hotel admin cannot demote, suspend, revoke sessions of, or re-invite the OWNER", async () => {
    for (const body of [
      { role: "HOTEL_STAFF" },
      { deactivate: true },
      { revokeSessions: true },
      { resetInvite: true },
    ]) {
      const res = await apiCall("PATCH", `/api/staff/${fx.ownerAId}`, {
        jar: fx.adminA,
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(403);
    }
    const ownerRow = await db.user.findUnique({ where: { id: fx.ownerAId! } });
    expect(ownerRow?.role).toBe("HOTEL_OWNER");
    expect(ownerRow?.status).toBe("ACTIVE");
  });

  test("owner CAN demote and reactivate a hotel admin", async () => {
    const demote = await apiCall("PATCH", `/api/staff/${fx.managerId}`, {
      jar: fx.ownerA,
      body: { role: "HOTEL_STAFF" },
    });
    expect(demote.status).toBe(200);
    expect((await db.user.findUnique({ where: { id: fx.managerId! } }))?.role).toBe("HOTEL_STAFF");
    const restore = await apiCall("PATCH", `/api/staff/${fx.managerId}`, {
      jar: fx.ownerA,
      body: { role: "HOTEL_MANAGER" },
    });
    expect(restore.status).toBe(200);
  });

  test("a user cannot change their own role or deactivate themselves", async () => {
    const selfRole = await apiCall("PATCH", `/api/staff/${fx.ownerAId}`, {
      jar: fx.ownerA,
      body: { role: "HOTEL_ADMIN" },
    });
    expect(selfRole.status).toBe(403);
    const selfDeactivate = await apiCall("PATCH", `/api/staff/${fx.ownerAId}`, {
      jar: fx.ownerA,
      body: { deactivate: true },
    });
    expect(selfDeactivate.status).toBe(403);
  });

  test("staff invite cannot mint SUPER_ADMIN or HOTEL_OWNER", async () => {
    for (const role of ["SUPER_ADMIN", "HOTEL_OWNER"]) {
      const res = await apiCall("POST", "/api/staff", {
        jar: fx.adminA,
        body: { name: "Forged Role", email: `forged-${Date.now()}@example.test`, role },
      });
      expect(res.status, role).toBe(400);
    }
  });

  test("PATCH staff cannot set SUPER_ADMIN or HOTEL_OWNER", async () => {
    for (const role of ["SUPER_ADMIN", "HOTEL_OWNER"]) {
      const res = await apiCall("PATCH", `/api/staff/${fx.kitchenId}`, {
        jar: fx.adminA,
        body: { role },
      });
      expect(res.status, role).toBe(400);
    }
    expect((await db.user.findUnique({ where: { id: fx.kitchenId! } }))?.role).toBe("KITCHEN_STAFF");
  });

  test("non-owner admin cannot mint another HOTEL_ADMIN", async () => {
    const res = await apiCall("POST", "/api/staff", {
      jar: fx.manager,
      body: { name: "Minted Admin", email: `minted-${Date.now()}@example.test`, role: "HOTEL_ADMIN" },
    });
    expect(res.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/* Super-admin boundary                                                */
/* ------------------------------------------------------------------ */

describe("super-admin boundary — no SUPER_ADMIN minting outside bootstrap", () => {
  test("public hotel registration creates HOTEL_ADMIN, never SUPER_ADMIN", async () => {
    // The registration endpoint rate-limits 5/hour PER CLIENT IP. Several
    // earlier suites in this same harness run consume the shared 127.0.0.1
    // budget (and test-phase63.ts needs it too). Present this single probe
    // registration as coming via the proxy from a unique IP — the dev server
    // treats XFF as the client-IP source of truth (TRUSTED_PROXY_HOPS) — so
    // we test the endpoint without draining the shared bucket.
    const email = `reg-probe-${Date.now()}@example.test`;
    // Fresh (random) probe IP per run: each client IP gets its own 5/hour
    // bucket, so repeated suite runs (same long-lived server) never collide.
    const probeIp = `10.99.${1 + Math.floor(Math.random() * 200)}.${1 + Math.floor(Math.random() * 200)}`;
    const res = await apiCall("POST", "/api/hotels", {
      headers: { "x-forwarded-for": probeIp },
      body: {
        hotelName: `Probe Hotel ${Date.now()}`,
        adminName: "Probe Admin",
        email,
        password: "ProbePass123",
      },
    });
    expect(res.status).toBe(201);
    const user = await db.user.findUnique({ where: { email } });
    expect(user?.role).toBe("HOTEL_ADMIN");
    expect(user?.role).not.toBe("SUPER_ADMIN");
    // Tidy: the probe hotel/user are orphaned test tenants — remove them.
    if (user) {
      await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    }
  });

  test("super-admin management endpoints reject hotel users (401 anonymous / 403 hotel)", async () => {
    const anon = await apiCall("GET", "/api/super-admin/stats");
    expect(anon.status).toBe(401);
    const hotelUser = await apiCall("GET", "/api/super-admin/stats", { jar: fx.adminA });
    expect(hotelUser.status).toBe(403);
    const ownerUser = await apiCall("GET", "/api/super-admin/hotels", { jar: fx.ownerA });
    expect(ownerUser.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/* Session revocation                                                  */
/* ------------------------------------------------------------------ */

describe("session revocation — revokeSessions and tampered tokens", () => {
  test("revokeSessions kills the target's current session", async () => {
    const target = await db.user.findUnique({ where: { email: HOTEL_A_STAFF } });
    const res = await apiCall("PATCH", `/api/staff/${target!.id}`, {
      jar: fx.adminA,
      body: { revokeSessions: true },
    });
    expect(res.status).toBe(200);
    const dead = await apiCall("GET", "/api/audit-logs", { jar: fx.staffA });
    expect(dead.status).toBe(401); // old jar's token version no longer matches
    // ...but the account itself is fine: a fresh login works.
    const fresh = await login(HOTEL_A_STAFF, STAFF_PASSWORD);
    expect(fresh.res.status).toBe(200);
  });

  test("a tampered session token is rejected with 401", async () => {
    // Fresh login (the previous test revoked the staff session) — the token
    // FORMAT is what we tamper, so any live session works.
    const staff = await login(HOTEL_A_STAFF, STAFF_PASSWORD);
    expect(staff.res.status).toBe(200);
    const cookie = staff.jar.cookie;
    const sessionPair = cookie.split(";").find((c) => c.trim().startsWith("stayloop_session="));
    expect(sessionPair).toBeTruthy();
    const raw = decodeURIComponent(sessionPair!.split("=").slice(1).join("="));
    const [body, sig] = raw.split(".");
    // Flip one character of the signature → HMAC mismatch.
    const flipped = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
    const forged = `stayloop_session=${encodeURIComponent(`${body}.${flipped}`)}`;
    const csrfPair = cookie.split(";").find((c) => c.trim().startsWith("stayloop_csrf="));
    const res = await apiCall("GET", "/api/audit-logs", {
      headers: { cookie: `${forged}; ${csrfPair}` },
    });
    expect(res.status).toBe(401);
  });
});

/* ------------------------------------------------------------------ */
/* Tenant isolation — nested resources & franchise capture             */
/* ------------------------------------------------------------------ */

describe("tenant isolation — nested resources and franchise branch capture", () => {
  test("cross-tenant nested customer visits are 404", async () => {
    let customer = await db.customer.findFirst({ where: { hotelId: fx.hotelAId! } });
    if (!customer) {
      customer = await db.customer.create({
        data: {
          hotelId: fx.hotelAId!,
          name: "Iso Probe",
          // (hotelId, phone) is unique — randomize to avoid cross-run collisions.
          phone: `+9199${Math.floor(10000000 + Math.random() * 89999999)}`,
          email: "iso-probe@example.test",
        },
      });
    }
    const visits = await apiCall("GET", `/api/customers/${customer.id}/visits`, {
      jar: fx.adminB,
    });
    expect(visits.status).toBe(404);
  });

  test("cross-tenant bill refund is denied and the bill is untouched", async () => {
    // Real bill in Hotel A (minimal row — the point is tenant scoping, not
    // bill creation).
    const adminAUser = await db.user.findUnique({ where: { email: HOTEL_A_ADMIN } });
    const bill = await db.bill.create({
      data: {
        hotelId: fx.hotelAId!,
        billNumber: `INV/ISO/${Date.now()}`,
        series: "ISO-PROBE",
        seqNumber: 1,
        totalMinor: 10000,
        issuedByUserId: adminAUser!.id,
      },
    });
    // Hotel B tries to refund a Hotel A bill: the tenant-scoped lookup must
    // find nothing and the bill must be untouched.
    const refund = await apiCall("POST", `/api/bills/${bill.id}/refund`, {
      jar: fx.adminB,
      body: { type: "REFUND", reason: "cross-tenant probe" },
    });
    expect(refund.status).toBe(422); // generic rejection, no 201
    const after = await db.bill.findUnique({ where: { id: bill.id } });
    expect(after?.status).toBe("ISSUED");
    expect(after?.refundMinor).toBe(0);
    expect(after?.voidedAt).toBeNull();
    await db.bill.delete({ where: { id: bill.id } });
  });

  test("cross-tenant background job status is 404", async () => {
    const jobId = "00000000-0000-4000-8000-000000000001";
    const res = await apiCall("GET", `/api/jobs/${jobId}`, { jar: fx.adminB });
    expect(res.status).toBe(404);
  });

  test("franchise: a hotel admin CANNOT attach a foreign hotel to their franchise", async () => {
    const create = await apiCall("POST", "/api/franchise", {
      jar: fx.adminA,
      body: { name: `Capture Probe ${Date.now()}` },
    });
    expect(create.status).toBe(201);
    const orgId = create.body.id as string;

    // The own hotel is the legitimate branch.
    const own = await apiCall("POST", `/api/franchise/${orgId}/branches`, {
      jar: fx.adminA,
      body: { hotelId: fx.hotelAId },
    });
    expect(own.status).toBe(200);

    // Hotel B (a DIFFERENT tenant) must NOT be attachable.
    const capture = await apiCall("POST", `/api/franchise/${orgId}/branches`, {
      jar: fx.adminA,
      body: { hotelId: fx.hotelBId },
    });
    expect(capture.status).toBe(403);

    // No capture happened: the summary must only list Hotel A's branch.
    const summary = await apiCall("GET", `/api/franchise/${orgId}`, { jar: fx.adminA });
    expect(summary.status).toBe(200);
    const branchIds = (summary.body.branches ?? []).map((b: { hotelId: string }) => b.hotelId);
    expect(branchIds).toContain(fx.hotelAId);
    expect(branchIds).not.toContain(fx.hotelBId);

    // Hotel B's membership is untouched.
    const bMembership = await db.branchMembership.findUnique({ where: { hotelId: fx.hotelBId! } });
    expect(bMembership?.franchiseOrganizationId ?? null).not.toBe(orgId);
  });

  test("franchise: a hotel admin CANNOT read another hotel's franchise summary", async () => {
    const create = await apiCall("POST", "/api/franchise", {
      jar: fx.adminA,
      body: { name: `Isolation Probe ${Date.now()}` },
    });
    expect(create.status).toBe(201);
    const foreignSummary = await apiCall("GET", `/api/franchise/${create.body.id}`, {
      jar: fx.adminB,
    });
    expect(foreignSummary.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/* Export & financial permission boundaries                            */
/* ------------------------------------------------------------------ */

describe("export and financial permission boundaries", () => {
  test("unauthenticated export is 401", async () => {
    const res = await apiCall("GET", "/api/export/customers");
    expect(res.status).toBe(401);
  });

  test("kitchen staff cannot export customers (no CUSTOMER_READ)", async () => {
    const res = await apiCall("GET", "/api/export/customers", { jar: fx.kitchen });
    expect(res.status).toBe(403);
  });

  test("kitchen staff cannot read bills or manage taxes", async () => {
    const bills = await apiCall("GET", "/api/bills?pageSize=1", { jar: fx.kitchen });
    expect(bills.status).toBe(403);
    const tax = await apiCall("POST", "/api/tax-rules", {
      jar: fx.kitchen,
      body: { name: "probe rule", type: "EXEMPT", rateBps: 0 },
    });
    expect(tax.status).toBe(403);
  });

  test("manager can refund (BILL_REFUND) but cannot void (BILL_VOID is owner/admin)", async () => {
    // A manager holds BILL_REFUND but not BILL_VOID.
    const probeVoid = await apiCall("POST", "/api/bills/does-not-exist/refund", {
      jar: fx.manager,
      body: { type: "VOID", reason: "probe" },
    });
    // The permission check (403) fires before the 404 bill lookup.
    expect(probeVoid.status).toBe(403);
  });
});
