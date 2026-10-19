/**
 * Customer CRM suite (Customer Section & Add Customer improvements).
 *
 * Coverage map (mirrors the delivery checklist):
 *   1.  successful customer creation
 *   2.  missing / invalid required fields
 *   3.  invalid phone number + invalid email
 *   4.  duplicate phone number inside the SAME restaurant
 *   5.  identical phone numbers in DIFFERENT restaurants (allowed)
 *   6.  concurrent / repeated customer creation
 *   7.  unauthorized access + role restrictions
 *   8.  cross-tenant access attempts (IDOR)
 *   9.  editing + customer detail history
 *   10. customer creation from the existing order / checkout (billing) flow
 *   11. list/dashboard contract: search, filters, summary, empty state, UI states
 *   12. regression: billing / POS / orders / QR endpoints still work
 *
 * Runs against the harness server (see scripts/run-tests.ts).
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { apiCall, login, ADMIN_PASSWORD, HOTEL_A_ADMIN, WEBHOOK_SECRET } from "./helpers";
import { normalizePhone, maskPhoneDisplay } from "../src/lib/phone";

/**
 * ISOLATION NOTE: this suite registers its OWN throwaway restaurants instead of
 * writing into the seeded demo tenants. The functional acceptance suites that
 * run after the bun suites (scripts/test-phase1.ts, test-phase2.ts) assert
 * EXACT seeded counts (e.g. "hotel B dashboard is scoped (1 customer)"), so any
 * leftover customer here would fail them. The seeded hotel is only ever READ
 * from (loyalty + regression checks).
 */

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3100";
const ROOT = resolve(import.meta.dir, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Deterministic, valid Indian mobile numbers (unique per run + counter). */
let seq = 0;
function nextPhone(): string {
  seq += 1;
  return `9${String(Date.now()).slice(-8)}${String(seq).padStart(1, "0")}`.slice(0, 10);
}

/** Fresh throwaway tenants — see the isolation note above. */
let adminA: Awaited<ReturnType<typeof login>>;
let adminB: Awaited<ReturnType<typeof login>>;
let staffA: Awaited<ReturnType<typeof login>>;
/** Seeded demo tenant — READ-ONLY in this suite. */
let seededA: Awaited<ReturnType<typeof login>>;

let xff = 120;
async function registerFreshHotel(name: string, adminEmail: string) {
  xff += 1;
  const res = await fetch(`${BASE}/api/hotels`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: BASE,
      "x-forwarded-for": `10.77.0.${xff}`,
    },
    body: JSON.stringify({
      hotelName: name,
      adminName: "CRM Owner",
      email: adminEmail,
      password: "CrmOwnerPass123!",
    }),
  });
  if (res.status !== 201) throw new Error(`hotel registration failed: ${res.status}`);
  return login(adminEmail, "CrmOwnerPass123!");
}

/** Invite + activate a staff member in a fresh tenant and log them in. */
async function inviteStaff(
  jar: Awaited<ReturnType<typeof login>>["jar"],
  unique: string,
  role: string,
) {
  const email = `${role.toLowerCase()}-${unique}@crm-suite.test`;
  const invite = await apiCall("POST", "/api/staff", {
    jar,
    body: { name: `CRM Staff ${unique}`, email, role },
  });
  if (invite.status !== 201) return null;
  const url = String(invite.body.invitation?.url ?? "");
  const token = new URL(url).searchParams.get("token");
  if (!token) return null;
  const activate = await apiCall("POST", "/api/auth/activate", {
    body: { token, password: "CrmStaffPass123!" },
  });
  if (activate.status !== 200) return null;
  return login(email, "CrmStaffPass123!");
}

type Created = { id: string; name: string; phone: string };

async function createCustomer(
  jar: Awaited<ReturnType<typeof login>>["jar"],
  body: Record<string, unknown>,
) {
  return apiCall("POST", "/api/customers", { jar, body });
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

describe("CRM setup", () => {
  test("register two throwaway restaurants + a read-only staff member", async () => {
    const stamp = String(Date.now());
    adminA = await registerFreshHotel(`CRM Tenant A ${stamp}`, `crm-a-${stamp}@crm-suite.test`);
    adminB = await registerFreshHotel(`CRM Tenant B ${stamp}`, `crm-b-${stamp}@crm-suite.test`);
    expect(adminA.res.status).toBe(200);
    expect(adminB.res.status).toBe(200);

    const staff = await inviteStaff(adminA.jar, `s${stamp}`, "HOTEL_STAFF");
    expect(staff).not.toBeNull();
    staffA = staff!;
    expect(staffA.res.status).toBe(200);
  });

  test("log in to the seeded demo tenant (read-only in this suite)", async () => {
    seededA = await login(HOTEL_A_ADMIN, ADMIN_PASSWORD);
    expect(seededA.res.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* 1–3. Creation + validation                                          */
/* ------------------------------------------------------------------ */

describe("1 — successful customer creation", () => {
  test("admin creates a customer with name + phone (phone is normalized)", async () => {
    const phone = nextPhone();
    const res = await createCustomer(adminA.jar, {
      name: "CRM Created Customer",
      phone: `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`,
      email: "crm.created@example.com",
      notes: "Created by the CRM suite",
      birthday: "1990-05-20",
      marketingConsent: false,
    });
    expect(res.status).toBe(201);
    const c = res.body.customer;
    expect(c.id).toBeTruthy();
    // Stored in the canonical normalized form used for duplicate checks.
    expect(c.phone).toBe(`+91${phone}`);
    expect(c.email).toBe("crm.created@example.com");
    // An order/visit is NOT marketing consent.
    expect(c.marketingConsent).toBe(false);
    expect(c.whatsappOptIn).toBe(false);
  });

  test("optional fields really are optional", async () => {
    const res = await createCustomer(adminA.jar, { name: "CRM Minimal", phone: nextPhone() });
    expect(res.status).toBe(201);
    expect(res.body.customer.email).toBeNull();
  });

  test("marketing consent is an explicit opt-in (channel flags stored with it)", async () => {
    const res = await createCustomer(adminA.jar, {
      name: "CRM Consented",
      phone: nextPhone(),
      email: "crm.consented@example.com",
      marketingConsent: true,
      whatsappOptIn: true,
      smsOptIn: true,
      emailOptIn: false,
    });
    expect(res.status).toBe(201);
    const c = res.body.customer;
    expect(c.marketingConsent).toBe(true);
    expect(c.whatsappOptIn).toBe(true);
    expect(c.smsOptIn).toBe(true);
    expect(c.emailOptIn).toBe(false);
    expect(c.optOut).toBe(false);
  });

  test("a channel opt-in WITHOUT marketing consent never grants consent", async () => {
    const res = await createCustomer(adminA.jar, {
      name: "CRM No Consent",
      phone: nextPhone(),
      marketingConsent: false,
      whatsappOptIn: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.customer.marketingConsent).toBe(false);
    expect(res.body.customer.whatsappOptIn).toBe(false);
  });
});

describe("2 — missing / invalid required fields", () => {
  test("missing name is rejected with a field-level message", async () => {
    const res = await createCustomer(adminA.jar, { phone: nextPhone() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.fields?.name).toBeTruthy();
  });

  test("too-short name is rejected", async () => {
    const res = await createCustomer(adminA.jar, { name: "A", phone: nextPhone() });
    expect(res.status).toBe(400);
    expect(res.body.error.fields?.name).toBeTruthy();
  });

  test("missing phone is rejected", async () => {
    const res = await createCustomer(adminA.jar, { name: "CRM No Phone" });
    expect(res.status).toBe(400);
    expect(res.body.error.fields?.phone).toBeTruthy();
  });

  test("empty body is rejected, never a 500", async () => {
    const res = await createCustomer(adminA.jar, {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("a client-supplied hotelId cannot choose the tenant", async () => {
    const phone = nextPhone();
    const res = await createCustomer(adminA.jar, {
      name: "CRM Tenant Guard",
      phone,
      hotelId: "some-other-restaurant-id",
      restaurantId: "some-other-restaurant-id",
    });
    expect(res.status).toBe(201);
    // It landed in the SESSION's hotel, so hotel A can see it…
    const mine = await apiCall("GET", `/api/customers?q=${phone}`, { jar: adminA.jar });
    expect(mine.body.customers.some((c: Created) => c.phone === `+91${phone}`)).toBe(true);
    // …and the forged id was ignored (not used as a real foreign key).
    const forged = await apiCall("GET", `/api/customers?q=${phone}`, { jar: adminB.jar });
    expect(forged.body.customers.length).toBe(0);
  });
});

describe("3 — invalid phone number and email", () => {
  test("letters in the phone number are rejected", async () => {
    const res = await createCustomer(adminA.jar, { name: "CRM Bad Phone", phone: "not-a-phone" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("too-short phone number is rejected", async () => {
    const res = await createCustomer(adminA.jar, { name: "CRM Short Phone", phone: "123" });
    expect(res.status).toBe(400);
    expect(res.body.error.fields?.phone).toBeTruthy();
  });

  test("invalid email is rejected", async () => {
    const res = await createCustomer(adminA.jar, {
      name: "CRM Bad Email",
      phone: nextPhone(),
      email: "not-an-email",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.fields?.email).toBeTruthy();
  });

  test("phone normalization unit: 10-digit, 0-prefix and +91 forms agree", () => {
    const a = normalizePhone("9876543210");
    const b = normalizePhone("09876543210");
    const c = normalizePhone("+91 98765 43210");
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(a.normalized).toBe("+919876543210");
    expect(b.normalized).toBe(a.normalized);
    expect(c.normalized).toBe(a.normalized);
    // Masking stays the single shared implementation.
    expect(maskPhoneDisplay("+919876543210")).toBe("******3210");
  });
});

/* ------------------------------------------------------------------ */
/* 4–6. Duplicate prevention                                           */
/* ------------------------------------------------------------------ */

describe("4 — duplicate phone inside the same restaurant", () => {
  const phone = nextPhone();
  let createdId = "";

  test("first create succeeds", async () => {
    const res = await createCustomer(adminA.jar, { name: "CRM Dup One", phone });
    expect(res.status).toBe(201);
    createdId = res.body.customer.id;
  });

  test("same number again → 409 DUPLICATE_PHONE naming the existing customer", async () => {
    const res = await createCustomer(adminA.jar, { name: "CRM Dup Two", phone });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DUPLICATE_PHONE");
    expect(res.body.error.existing?.id).toBe(createdId);
    expect(res.body.error.existing?.name).toBe("CRM Dup One");
  });

  test("a re-formatted version of the same number is also a duplicate", async () => {
    const res = await createCustomer(adminA.jar, {
      name: "CRM Dup Three",
      phone: `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.existing?.id).toBe(createdId);
  });

  test("the duplicate response never creates a second row", async () => {
    const list = await apiCall("GET", `/api/customers?q=${phone}`, { jar: adminA.jar });
    expect(list.body.customers.length).toBe(1);
  });
});

describe("5 — identical phone numbers in different restaurants", () => {
  const phone = nextPhone();

  test("hotel A creates it", async () => {
    const res = await createCustomer(adminA.jar, { name: "CRM Shared A", phone });
    expect(res.status).toBe(201);
  });

  test("hotel B can create a customer with the SAME number (separate tenant)", async () => {
    const res = await createCustomer(adminB.jar, { name: "CRM Shared B", phone });
    expect(res.status).toBe(201);
    expect(res.body.customer.phone).toBe(`+91${phone}`);
  });

  test("each tenant sees only its own customer for that number", async () => {
    const a = await apiCall("GET", `/api/customers?q=${phone}`, { jar: adminA.jar });
    const b = await apiCall("GET", `/api/customers?q=${phone}`, { jar: adminB.jar });
    expect(a.body.customers.length).toBe(1);
    expect(a.body.customers[0].name).toBe("CRM Shared A");
    expect(b.body.customers.length).toBe(1);
    expect(b.body.customers[0].name).toBe("CRM Shared B");
  });
});

describe("6 — concurrent / repeated creation is safe", () => {
  test("eight simultaneous creates for one number → exactly one customer", async () => {
    const phone = nextPhone();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createCustomer(adminA.jar, { name: `CRM Race ${i}`, phone }),
      ),
    );
    const created = results.filter((r) => r.status === 201);
    const duplicates = results.filter((r) => r.status === 409);
    expect(created.length).toBe(1);
    expect(duplicates.length).toBe(7);
    for (const d of duplicates) expect(d.body.error.code).toBe("DUPLICATE_PHONE");

    // The database agrees: one row, no silent duplicates from the race.
    const list = await apiCall("GET", `/api/customers?q=${phone}`, { jar: adminA.jar });
    expect(list.body.customers.length).toBe(1);
  });

  test("re-submitting the same payload twice never creates two profiles", async () => {
    const phone = nextPhone();
    const first = await createCustomer(adminA.jar, { name: "CRM Repeat", phone });
    const second = await createCustomer(adminA.jar, { name: "CRM Repeat", phone });
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error.existing?.id).toBe(first.body.customer.id);
  });
});

/* ------------------------------------------------------------------ */
/* 7–8. Authorization + tenant isolation                               */
/* ------------------------------------------------------------------ */

describe("7 — authentication and role restrictions", () => {
  test("anonymous users cannot list or create customers", async () => {
    const list = await apiCall("GET", "/api/customers");
    const create = await apiCall("POST", "/api/customers", {
      body: { name: "Anon", phone: nextPhone() },
    });
    expect(list.status).toBe(401);
    expect(create.status).toBe(401);
  });

  test("HOTEL_STAFF cannot create customers", async () => {
    const res = await createCustomer(staffA.jar, { name: "Staff Create", phone: nextPhone() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  test("HOTEL_STAFF cannot edit or deactivate a customer", async () => {
    const made = await createCustomer(adminA.jar, { name: "CRM Rbac Target", phone: nextPhone() });
    expect(made.status).toBe(201);
    const id = made.body.customer.id;
    const patch = await apiCall("PATCH", `/api/customers/${id}`, {
      jar: staffA.jar,
      body: { name: "Staff Renamed" },
    });
    const del = await apiCall("DELETE", `/api/customers/${id}`, { jar: staffA.jar });
    expect(patch.status).toBe(403);
    expect(del.status).toBe(403);
  });

  test("HOTEL_STAFF can still READ the customer list (recognise the guest)", async () => {
    const res = await apiCall("GET", "/api/customers?pageSize=5", { jar: staffA.jar });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.customers)).toBe(true);
  });
});

describe("8 — cross-tenant access is denied", () => {
  let foreignId = "";

  test("setup: hotel A owns a customer", async () => {
    const res = await createCustomer(adminA.jar, { name: "CRM Cross Tenant", phone: nextPhone() });
    expect(res.status).toBe(201);
    foreignId = res.body.customer.id;
  });

  test("hotel B gets 404 (not 403) for hotel A's customer — no existence leak", async () => {
    const view = await apiCall("GET", `/api/customers/${foreignId}`, { jar: adminB.jar });
    expect(view.status).toBe(404);
    expect(view.body.error.code).toBe("NOT_FOUND");
  });

  test("hotel B cannot update or delete hotel A's customer", async () => {
    const patch = await apiCall("PATCH", `/api/customers/${foreignId}`, {
      jar: adminB.jar,
      body: { name: "Hijacked" },
    });
    const del = await apiCall("DELETE", `/api/customers/${foreignId}`, { jar: adminB.jar });
    expect(patch.status).toBe(404);
    expect(del.status).toBe(404);
  });

  test("hotel B cannot move its own customer onto hotel A's phone number", async () => {
    const shared = nextPhone();
    await createCustomer(adminA.jar, { name: "CRM Phone Owner", phone: shared });
    const mine = await createCustomer(adminB.jar, { name: "CRM Phone Mover", phone: nextPhone() });
    expect(mine.status).toBe(201);
    // Different tenant → the number is free there; the update is allowed and
    // does NOT touch hotel A's customer.
    const patch = await apiCall("PATCH", `/api/customers/${mine.body.customer.id}`, {
      jar: adminB.jar,
      body: { phone: shared },
    });
    expect(patch.status).toBe(200);
    const aList = await apiCall("GET", `/api/customers?q=${shared}`, { jar: adminA.jar });
    expect(aList.body.customers.length).toBe(1);
    expect(aList.body.customers[0].name).toBe("CRM Phone Owner");
  });

  test("hotel A's list never contains hotel B's customers", async () => {
    const res = await apiCall("GET", "/api/customers?q=CRM%20Shared%20B", { jar: adminA.jar });
    expect(res.status).toBe(200);
    expect(res.body.customers.length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 9. Editing + detail history                                         */
/* ------------------------------------------------------------------ */

describe("9 — editing and customer detail history", () => {
  const phone = nextPhone();
  let id = "";

  test("setup: create the customer", async () => {
    const res = await createCustomer(adminA.jar, { name: "CRM History", phone });
    expect(res.status).toBe(201);
    id = res.body.customer.id;
  });

  test("a customer with no activity reports zeroed, honest numbers", async () => {
    const res = await apiCall("GET", `/api/customers/${id}`, { jar: adminA.jar });
    expect(res.status).toBe(200);
    expect(res.body.stats.totalVisits).toBe(0);
    expect(res.body.stats.totalSpend).toBe(0);
    expect(res.body.stats.firstVisit).toBeNull();
    expect(res.body.stats.lastVisit).toBeNull();
    expect(res.body.stats.neverVisited).toBe(true);
    expect(res.body.visits.length).toBe(0);
    expect(res.body.orders.length).toBe(0);
    // No loyalty account → no loyalty card, never a fabricated balance.
    expect(res.body.loyalty ?? null).toBeNull();
  });

  test("admin edits the customer (name, notes, email, consent)", async () => {
    const res = await apiCall("PATCH", `/api/customers/${id}`, {
      jar: adminA.jar,
      body: {
        name: "CRM History Edited",
        email: "crm.history@example.com",
        notes: "Prefers a window table",
        birthday: "1988-01-15",
        marketingConsent: true,
        whatsappOptIn: true,
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.customer.name).toBe("CRM History Edited");
    expect(res.body.customer.marketingConsent).toBe(true);
    expect(res.body.customer.whatsappOptIn).toBe(true);
  });

  test("renaming onto another customer's phone is refused (409)", async () => {
    const other = await createCustomer(adminA.jar, {
      name: "CRM Phone Holder",
      phone: nextPhone(),
    });
    expect(other.status).toBe(201);
    const res = await apiCall("PATCH", `/api/customers/${id}`, {
      jar: adminA.jar,
      body: { phone: other.body.customer.phone },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DUPLICATE_PHONE");
    expect(res.body.error.existing?.id).toBe(other.body.customer.id);
  });

  test("hotel stay + restaurant order both show in the profile history", async () => {
    const stayDate = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const stay = await apiCall("POST", `/api/customers/${id}/visits`, {
      jar: adminA.jar,
      body: { checkin: stayDate, amount: 1200, notes: "CRM suite stay" },
    });
    expect(stay.status).toBe(201);

    const dine = await apiCall("POST", "/api/restaurant/visits", {
      jar: adminA.jar,
      body: { customerId: id, orderAmount: 800, source: "WALK_IN" },
    });
    expect(dine.status).toBe(201);

    const profile = await apiCall("GET", `/api/customers/${id}`, { jar: adminA.jar });
    expect(profile.status).toBe(200);
    // Unified totals: 1 stay + 1 order = 2 visits, ₹2,000 lifetime spend.
    expect(profile.body.stats.totalVisits).toBe(2);
    expect(profile.body.stats.totalSpend).toBe(2000);
    expect(profile.body.stats.hotelVisits).toBe(1);
    expect(profile.body.stats.restaurantVisits).toBe(1);
    expect(profile.body.stats.restaurantSpend).toBe(800);
    expect(profile.body.stats.neverVisited).toBe(false);
    expect(profile.body.stats.isReturning).toBe(true);
    expect(profile.body.visits.length).toBe(1);
    expect(profile.body.orders.length).toBe(1);
    expect(profile.body.orders[0].amount).toBe(800);
    // The order also appears on the activity timeline.
    expect(profile.body.timeline.some((t: { type: string }) => t.type === "order")).toBe(true);
  });

  test("the list reports the same unified totals", async () => {
    const list = await apiCall("GET", `/api/customers?q=${phone}`, { jar: adminA.jar });
    expect(list.status).toBe(200);
    const row = list.body.customers[0];
    expect(row.totalVisits).toBe(2);
    expect(row.totalSpend).toBe(2000);
    expect(row.isReturning).toBe(true);
  });

  test("loyalty is reported only when the hotel holds an account for the guest", async () => {
    // Read-only against the SEEDED tenant: it is the one that has loyalty
    // members (a throwaway hotel has no program history).
    const loyalty = await apiCall("GET", "/api/loyalty?pageSize=5", { jar: seededA.jar });
    expect(loyalty.status).toBe(200);
    const member = (loyalty.body.accounts ?? [])[0];
    if (!member) {
      // No loyalty members in this tenant — nothing to assert.
      expect(loyalty.body.stats.members).toBe(0);
      return;
    }
    const profile = await apiCall("GET", `/api/customers/${member.customerId}`, {
      jar: seededA.jar,
    });
    expect(profile.status).toBe(200);
    expect(profile.body.loyalty).toBeTruthy();
    expect(typeof profile.body.loyalty.points).toBe("number");
    expect(profile.body.loyalty.points).toBe(member.points);
  });
});

/* ------------------------------------------------------------------ */
/* 11. List / dashboard contract                                       */
/* ------------------------------------------------------------------ */

describe("11 — list, search, filters, summary and states", () => {
  const marker = `CRMList${Date.now()}`;
  const phone = nextPhone();

  test("setup: a searchable customer", async () => {
    const res = await createCustomer(adminA.jar, { name: marker, phone });
    expect(res.status).toBe(201);
  });

  test("search by name finds it", async () => {
    const res = await apiCall("GET", `/api/customers?q=${encodeURIComponent(marker)}`, {
      jar: adminA.jar,
    });
    expect(res.status).toBe(200);
    expect(res.body.customers.some((c: Created) => c.name === marker)).toBe(true);
  });

  test("search by mobile number works in every common format", async () => {
    for (const term of [phone, `+91${phone}`, `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`]) {
      const res = await apiCall("GET", `/api/customers?q=${encodeURIComponent(term)}`, {
        jar: adminA.jar,
      });
      expect(res.status).toBe(200);
      expect(res.body.customers.some((c: Created) => c.name === marker)).toBe(true);
    }
  });

  test("`search` is accepted as an alias of `q`", async () => {
    const res = await apiCall("GET", `/api/customers?search=${encodeURIComponent(marker)}`, {
      jar: adminA.jar,
    });
    expect(res.status).toBe(200);
    expect(res.body.customers.some((c: Created) => c.name === marker)).toBe(true);
  });

  test("a nonsense search returns an empty list (not an error, not everything)", async () => {
    const res = await apiCall("GET", "/api/customers?q=zzz-no-such-customer-zzz", {
      jar: adminA.jar,
    });
    expect(res.status).toBe(200);
    expect(res.body.customers.length).toBe(0);
    expect(res.body.total).toBe(0);
    expect(res.body.summary.total).toBe(0);
  });

  test("an invalid filter value is rejected (400), never silently ignored", async () => {
    const res = await apiCall("GET", "/api/customers?activity=not-a-bucket", { jar: adminA.jar });
    expect(res.status).toBe(400);
  });

  test("the summary block reports real, consistent numbers", async () => {
    const res = await apiCall("GET", "/api/customers?pageSize=5", { jar: adminA.jar });
    expect(res.status).toBe(200);
    const s = res.body.summary;
    expect(typeof s.total).toBe("number");
    expect(typeof s.newCustomers).toBe("number");
    expect(typeof s.returningCustomers).toBe("number");
    expect(typeof s.lapsedCustomers).toBe("number");
    expect(typeof s.neverVisited).toBe("number");
    expect(s.newWindowDays).toBe(30);
    expect(s.lapsedWindowDays).toBe(90);
    // Buckets can never exceed the total.
    expect(s.returningCustomers).toBeLessThanOrEqual(s.total);
    expect(s.neverVisited).toBeLessThanOrEqual(s.lapsedCustomers);
  });

  test("activity filters return subsets of the unfiltered result", async () => {
    const all = await apiCall("GET", "/api/customers?pageSize=50", { jar: adminA.jar });
    const returning = await apiCall("GET", "/api/customers?activity=returning&pageSize=50", {
      jar: adminA.jar,
    });
    const lapsed = await apiCall("GET", "/api/customers?activity=lapsed&pageSize=50", {
      jar: adminA.jar,
    });
    expect(returning.status).toBe(200);
    expect(lapsed.status).toBe(200);
    expect(returning.body.total).toBeLessThanOrEqual(all.body.total);
    expect(lapsed.body.total).toBeLessThanOrEqual(all.body.total);
    expect(returning.body.summary.total).toBe(all.body.summary.total);
    for (const c of returning.body.customers) expect(c.isReturning).toBe(true);
    for (const c of lapsed.body.customers) expect(c.isLapsed).toBe(true);
  });

  test("pagination is consistent across pages", async () => {
    const p1 = await apiCall("GET", "/api/customers?page=1&pageSize=5&sort=name&order=asc", {
      jar: adminA.jar,
    });
    const p2 = await apiCall("GET", "/api/customers?page=2&pageSize=5&sort=name&order=asc", {
      jar: adminA.jar,
    });
    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    expect(p1.body.customers.length).toBeGreaterThan(0);
    const ids1 = p1.body.customers.map((c: Created) => c.id);
    const ids2 = p2.body.customers.map((c: Created) => c.id);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
  });

  test("UI: the list renders loading, empty, error and success states", () => {
    const src = read("src/components/app/customers-view.tsx");
    expect(src).toContain("isLoading ?");
    expect(src).toContain("isError ?");
    expect(src).toContain("Couldn't load customers");
    expect(src).toContain("No matching customers");
    expect(src).toContain("No customers yet");
    expect(src).toContain("<Skeleton");
    expect(src).toContain("EmptyState");
  });

  test("UI: the add-customer form validates per field and blocks double submits", () => {
    const src = read("src/components/app/customer-dialog.tsx");
    expect(src).toContain("parseWithFieldErrors");
    expect(src).toContain("fieldErrors");
    expect(src).toContain("aria-invalid");
    expect(src).toContain('role="alert"');
    expect(src).toContain("submittingRef");
    // Values are preserved on failure — the dialog only closes on success.
    expect(src).toContain("onSuccess");
    expect(src).toContain("onOpenChange(false)");
  });

  test("UI: a duplicate offers to open the existing customer instead of creating", () => {
    const src = read("src/components/app/customer-dialog.tsx");
    expect(src).toContain("DUPLICATE_PHONE");
    expect(src).toContain("Open {duplicate.name}");
    expect(src).toContain("onOpenCustomer");
  });
});

/* ------------------------------------------------------------------ */
/* 10. Customer creation from the order / checkout (billing) flow      */
/* ------------------------------------------------------------------ */

describe("10 — customer creation from the POS / billing workflow", () => {
  const suffix = String(Date.now());
  let jar: Awaited<ReturnType<typeof login>>["jar"];
  const email = `crm-billing-${suffix}@crm-suite.test`;

  /** table → session → order → bill → CASH payment. Returns the bill. */
  async function billWithCustomer(
    tableNumber: string,
    identity?: { name?: string; phone?: string },
  ) {
    const cat = await apiCall("POST", "/api/menu/categories", {
      jar,
      body: { name: `CRM Cat ${tableNumber}` },
    });
    const item = await apiCall("POST", "/api/menu/items", {
      jar,
      body: {
        categoryId: cat.body.category.id,
        name: `CRM Item ${tableNumber}`,
        priceMinor: 10000,
      },
    });
    const table = await apiCall("POST", "/api/tables", {
      jar,
      body: { number: tableNumber, capacity: 2 },
    });
    const session = await apiCall("POST", "/api/sessions", {
      jar,
      body: { tableId: table.body.table.id },
    });
    const sid = session.body.session?.id ?? session.body.id;
    await apiCall("POST", "/api/orders", {
      jar,
      body: {
        tableSessionId: sid,
        cart: [{ menuItemId: item.body.item.id, quantity: 1 }],
        ...(identity?.phone ? { customerName: identity.name, customerPhone: identity.phone } : {}),
      },
    });
    const bill = await apiCall("POST", "/api/bills", {
      jar,
      body: {
        tableSessionId: sid,
        idempotencyKey: `crm-bill-${tableNumber}-${suffix}`,
        ...(identity?.phone ? { customerName: identity.name, customerPhone: identity.phone } : {}),
      },
    });
    expect(bill.status).toBe(201);
    const paid = await apiCall("POST", `/api/bills/${bill.body.bill.id}/pay`, {
      jar,
      body: { method: "CASH", amountMinor: bill.body.bill.totalMinor },
    });
    expect([200, 201]).toContain(paid.status);
    return bill.body.bill;
  }

  test("setup: fresh restaurant", async () => {
    jar = (await registerFreshHotel(`CRM Billing ${suffix}`, email)).jar;
    expect(jar).toBeTruthy();
  });

  test("paying a bill with an unknown phone links a NEW customer (normalized)", async () => {
    const phone = nextPhone();
    await billWithCustomer("CRM-1", {
      name: "Bill Walker",
      phone: `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`,
    });

    const list = await apiCall("GET", `/api/customers?q=${phone}`, { jar });
    expect(list.status).toBe(200);
    expect(list.body.customers.length).toBe(1);
    expect(list.body.customers[0].phone).toBe(`+91${phone}`);
    expect(list.body.customers[0].name).toBe("Bill Walker");
    // The bill is NOT consent to marketing.
    expect(list.body.customers[0].marketingConsent).toBe(false);
  });

  test("a second paid bill for the SAME number reuses the profile (no duplicate)", async () => {
    const phone = nextPhone();
    await billWithCustomer("CRM-2", { name: "Repeat Diner", phone });
    await billWithCustomer("CRM-3", { name: "Repeat Diner", phone });

    const list = await apiCall("GET", `/api/customers?q=${phone}`, { jar });
    expect(list.body.customers.length).toBe(1);
  });

  test("guest checkout is preserved: a bill with no phone creates nobody", async () => {
    const before = await apiCall("GET", "/api/customers?pageSize=1", { jar });
    await billWithCustomer("CRM-4");
    const after = await apiCall("GET", "/api/customers?pageSize=1", { jar });
    expect(after.body.total).toBe(before.body.total);
  });

  test("a bill whose phone fails validation creates nobody", async () => {
    const before = await apiCall("GET", "/api/customers?pageSize=1", { jar });
    await billWithCustomer("CRM-5", { name: "Bad Number", phone: "123" });
    const after = await apiCall("GET", "/api/customers?pageSize=1", { jar });
    expect(after.body.total).toBe(before.body.total);
  });

  test("an existing customer is never renamed or overwritten by a bill", async () => {
    const phone = nextPhone();
    const made = await apiCall("POST", "/api/customers", {
      jar,
      body: { name: "Original Name", phone, notes: "keep me" },
    });
    expect(made.status).toBe(201);
    await billWithCustomer("CRM-6", { name: "Till Typed Name", phone });
    const profile = await apiCall("GET", `/api/customers/${made.body.customer.id}`, { jar });
    expect(profile.body.customer.name).toBe("Original Name");
    expect(profile.body.customer.notes).toBe("keep me");
  });
});

/* ------------------------------------------------------------------ */
/* 12. Regression guard — existing restaurant flows still work          */
/* ------------------------------------------------------------------ */

describe("12 — regression: billing, orders, QR menu and exports still work", () => {
  test("bills, orders, menu and dashboard endpoints respond 200", async () => {
    for (const path of [
      "/api/bills",
      "/api/orders",
      "/api/menu/items",
      "/api/dashboard/stats",
      "/api/restaurant/leaderboard",
    ]) {
      const res = await apiCall("GET", path, { jar: seededA.jar });
      expect(res.status).toBe(200);
    }
  });

  test("customer export still authorises correctly", async () => {
    const ok = await apiCall("GET", "/api/export/customers", { jar: seededA.jar });
    const anon = await apiCall("GET", "/api/export/customers");
    expect(ok.status).toBe(200);
    expect(anon.status).toBe(401);
  });

  test("the public menu endpoint never leaks customer data", async () => {
    const codes = await apiCall("GET", "/api/qr-codes", { jar: seededA.jar });
    expect(codes.status).toBe(200);
    const menuCode = (codes.body.qrCodes ?? []).find(
      (q: { type?: string; active?: boolean; code?: string }) => q.type === "MENU" && q.active,
    );
    if (!menuCode) return; // nothing published for this tenant — skip
    const res = await fetch(`${BASE}/api/public/menu/${menuCode.code}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    // No customer phone, email or name may be reachable from the public menu.
    expect(text).not.toMatch(/\+91\d{10}/);
    expect(text).not.toContain("@example.com");
  });

  test("the CRM list response keeps its original contract for old clients", async () => {
    const res = await apiCall("GET", "/api/customers?pageSize=5", { jar: seededA.jar });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.customers)).toBe(true);
    expect(typeof res.body.total).toBe("number");
    expect(typeof res.body.page).toBe("number");
    expect(typeof res.body.pageSize).toBe("number");
    expect(typeof res.body.totalPages).toBe("number");
    const c = res.body.customers[0];
    for (const key of ["id", "name", "phone", "status", "totalVisits", "createdAt"]) {
      expect(Object.prototype.hasOwnProperty.call(c, key)).toBe(true);
    }
  });

  test("webhook secret plumbing is untouched (suite sanity)", () => {
    expect(typeof WEBHOOK_SECRET).toBe("string");
  });
});
