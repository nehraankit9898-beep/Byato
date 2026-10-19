/**
 * Customer-domain helpers shared by the CRM routes and the order/billing
 * workflows.
 *
 * Design rules (security / tenant isolation):
 *  - Every function takes an explicit `hotelId` that the CALLER derives from
 *    the authenticated session. Nothing here ever reads a tenant id from a
 *    request body — a client-supplied `hotelId`/`restaurantId` can never
 *    decide where a customer is stored.
 *  - Phone numbers are always normalized (lib/phone.ts) before they are
 *    compared or written, so "+91 98765 43210" and "09876543210" are the
 *    SAME customer.
 *  - Duplicate detection is enforced BOTH by an explicit lookup and by the
 *    database unique constraint (`@@unique([hotelId, phone])`). The frontend
 *    check is UX only; a race is resolved by the constraint and translated
 *    into the same friendly 409 contract.
 *  - Nothing is merged or deleted automatically: when a possible duplicate is
 *    found the caller is told about the EXISTING customer and decides.
 *
 * Note on scope: the `Customer` model is shared across the whole platform, but
 * a customer row always belongs to exactly one hotel (tenant). Two different
 * restaurants may therefore hold customers with the same phone number — that
 * is not a duplicate.
 */
import { db } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { createCustomerWithinLimit } from "@/lib/saas/limits";

/** Summary-card windows (days). Exposed to the UI so the copy stays honest. */
export const NEW_CUSTOMER_WINDOW_DAYS = 30;
export const LAPSED_CUSTOMER_WINDOW_DAYS = 90;

/** Minimal customer shape used by the helpers below. */
export interface CustomerRecord {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  status: "ACTIVE" | "INACTIVE";
  createdAt: Date;
}

/**
 * Prisma's unique-constraint violation (`P2002`).
 *
 * `instanceof Prisma.PrismaClientKnownRequestError` is intentionally NOT used:
 * the test/dev build runs the pure-JS query engine through a driver adapter
 * and the error object can arrive from a different module instance, which
 * makes `instanceof` unreliable. The error CODE is stable across engines.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/** True when the violated constraint is the per-tenant (hotelId, phone) pair. */
export function isPhoneUniqueViolation(err: unknown): boolean {
  if (!isUniqueConstraintError(err)) return false;
  const meta = (err as { meta?: unknown }).meta;
  const target = (meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) {
    const fields = target.map((t) => String(t).toLowerCase());
    return fields.includes("phone");
  }
  if (typeof target === "string") return target.toLowerCase().includes("phone");
  // Without usable metadata we still treat it as a phone clash: (hotelId,
  // phone) is the only unique constraint on Customer besides the primary key.
  return true;
}

/** Tenant-scoped lookup by normalized phone. Never crosses tenants. */
export async function findCustomerByPhone(
  hotelId: string,
  phone: string,
  excludeCustomerId?: string,
): Promise<CustomerRecord | null> {
  const result = normalizePhone(phone);
  if (!result.ok || !result.normalized) return null;
  return db.customer.findFirst({
    where: {
      hotelId,
      phone: result.normalized,
      ...(excludeCustomerId ? { NOT: { id: excludeCustomerId } } : {}),
    },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      status: true,
      createdAt: true,
    },
  });
}

export interface CreateCustomerInput {
  name: string;
  phone: string;
  email?: string | null;
  marketingConsent?: boolean;
  consentSource?: string | null;
  whatsappOptIn?: boolean;
  smsOptIn?: boolean;
  emailOptIn?: boolean;
  roomPreference?: string | null;
  foodPreference?: string | null;
  location?: string | null;
  birthday?: Date | null;
  anniversary?: Date | null;
  source?: string | null;
  notes?: string | null;
  vip?: boolean;
}

export type CreateCustomerResult =
  | { ok: true; customer: CustomerRecord }
  | {
      ok: false;
      code: "DUPLICATE_PHONE";
      message: string;
      existing: { id: string; name: string };
    }
  | {
      ok: false;
      code: "SUBSCRIPTION_LIMIT_REACHED";
      message: string;
      used: number;
      limit: number;
    };

/**
 * Create a customer for a tenant with a duplicate-safe, race-safe strategy:
 *
 *   1. normalize the phone (invalid → caller validates first),
 *   2. explicit same-tenant lookup (friendly UX, no error surfaced as a 500),
 *   3. create INSIDE the plan-limit transaction (capacity is enforced
 *      atomically, so concurrent creates cannot bypass the plan cap),
 *   4. if the database constraint wins the race, re-read the existing row and
 *      return the SAME DUPLICATE_PHONE contract the lookup would have.
 *
 * The customer is never merged, renamed or deleted by this function.
 */
export async function createCustomerForTenant(
  hotelId: string,
  input: CreateCustomerInput,
): Promise<CreateCustomerResult> {
  const phoneResult = normalizePhone(input.phone);
  if (!phoneResult.ok || !phoneResult.normalized) {
    // Defensive: routes validate before calling. Never write an unvalidated,
    // un-normalized phone number.
    throw new Error(phoneResult.error || "Invalid phone number.");
  }
  const phone = phoneResult.normalized;

  const duplicate = await db.customer.findFirst({
    where: { hotelId, phone },
    select: { id: true, name: true },
  });
  if (duplicate) {
    return {
      ok: false,
      code: "DUPLICATE_PHONE",
      message:
        "A customer with this phone number already exists in your list. Open the existing profile instead of creating a duplicate.",
      existing: { id: duplicate.id, name: duplicate.name },
    };
  }

  const marketingConsent = input.marketingConsent === true;
  try {
    const result = await createCustomerWithinLimit(hotelId, (tx) =>
      tx.customer.create({
        data: {
          hotelId,
          name: input.name,
          phone,
          email: input.email || null,
          marketingConsent,
          consentTimestamp: marketingConsent ? new Date() : null,
          consentSource: marketingConsent ? input.consentSource || null : null,
          optOut: false,
          // Channel opt-ins are only ever true together with marketing consent.
          whatsappOptIn: marketingConsent && input.whatsappOptIn === true,
          smsOptIn: marketingConsent && input.smsOptIn === true,
          emailOptIn: marketingConsent && input.emailOptIn === true,
          roomPreference: input.roomPreference || null,
          foodPreference: input.foodPreference || null,
          location: input.location || null,
          birthday: input.birthday ?? null,
          anniversary: input.anniversary ?? null,
          source: input.source || null,
          notes: input.notes || null,
          vip: input.vip === true,
        },
        // No `select`: the caller (POST /api/customers) has always returned the
        // full created row, and the UI/tests read marketing consent + channel
        // flags straight off it.
      }),
    );
    if (!result.ok) {
      return {
        ok: false,
        code: "SUBSCRIPTION_LIMIT_REACHED",
        message: result.failure.message,
        used: result.failure.used,
        limit: result.failure.limit,
      };
    }
    return { ok: true, customer: result.value };
  } catch (err) {
    if (isPhoneUniqueViolation(err)) {
      const existing = await db.customer.findFirst({
        where: { hotelId, phone },
        select: { id: true, name: true },
      });
      if (existing) {
        return {
          ok: false,
          code: "DUPLICATE_PHONE",
          message:
            "A customer with this phone number already exists in your list. Open the existing profile instead of creating a duplicate.",
          existing: { id: existing.id, name: existing.name },
        };
      }
    }
    throw err;
  }
}

export interface LinkOrCreateCustomerInput {
  hotelId: string;
  /** Guest name captured on the order/bill. Required — we never invent names. */
  name?: string | null;
  /** Raw phone captured on the order/bill. */
  phone?: string | null;
  /** Where the identifier came from (audit trail). */
  source?: "BILL" | "ORDER" | "QR_MENU";
}

export type LinkOrCreateCustomerOutcome =
  | { customer: CustomerRecord; created: boolean; reason: "linked" | "created" }
  | { customer: null; created: false; reason: "no_identifier" | "limit_reached" };

/**
 * Link an order/bill to the right customer WITHOUT creating duplicates.
 *
 * Used by the paid-bill follow-up job (lib/retention.ts). Guest checkout is
 * preserved: when the bill carries no usable identity (no phone, or a phone
 * that fails validation) NOTHING is created and the flow continues exactly as
 * before.
 *
 * Rules:
 *  - phone must normalize (a verified identifier) — otherwise no match, no
 *    create (never treat "no phone" as "same as every other empty phone");
 *  - an existing customer with that phone in THIS tenant is reused as-is —
 *    their name, consent and notes are never overwritten by an order;
 *  - a new customer is created only when a real name AND a valid phone are
 *    both present;
 *  - if the plan's customer limit is full the order still succeeds — we skip
 *    the profile and report `limit_reached`.
 */
export async function linkOrCreateCustomerFromOrder(
  input: LinkOrCreateCustomerInput,
): Promise<LinkOrCreateCustomerOutcome> {
  const phoneResult = normalizePhone(input.phone ?? "");
  if (!phoneResult.ok || !phoneResult.normalized) {
    return { customer: null, created: false, reason: "no_identifier" };
  }
  const phone = phoneResult.normalized;
  const name = (input.name ?? "").trim();

  const existing = await db.customer.findFirst({
    where: { hotelId: input.hotelId, phone },
    select: { id: true, name: true, phone: true, email: true, status: true, createdAt: true },
  });
  if (existing) {
    return { customer: existing, created: false, reason: "linked" };
  }

  // No profile yet: only create one when the business rules are satisfied.
  if (name.length < 2) {
    return { customer: null, created: false, reason: "no_identifier" };
  }

  const result = await createCustomerForTenant(input.hotelId, {
    name: name.slice(0, 100),
    phone,
    source: input.source === "QR_MENU" ? "WEBSITE" : "WALK_IN",
    // An order is NOT marketing consent. Consent stays false until the guest
    // explicitly opts in (or is captured at the till with their permission).
    marketingConsent: false,
    consentSource: null,
  });

  if (result.ok) {
    return { customer: result.customer, created: true, reason: "created" };
  }
  if (result.code === "DUPLICATE_PHONE") {
    // Lost the race by a hair — reuse the winner instead of failing the job.
    const winner = await db.customer.findFirst({
      where: { hotelId: input.hotelId, phone },
      select: { id: true, name: true, phone: true, email: true, status: true, createdAt: true },
    });
    if (winner) return { customer: winner, created: false, reason: "linked" };
  }
  return { customer: null, created: false, reason: "limit_reached" };
}

/* ------------------------------------------------------------------ */
/* CRM summary maths (shared by the list + UI copy)                     */
/* ------------------------------------------------------------------ */

export interface CustomerActivity {
  /** Hotel stays (Visit) + restaurant bills (RestaurantVisit). */
  visits: number;
  spend: number;
  firstVisit: Date | null;
  lastVisit: Date | null;
}

export interface CustomerSummary {
  total: number;
  /** First-ever visit/order within the last NEW_CUSTOMER_WINDOW_DAYS days. */
  newCustomers: number;
  /** Two or more recorded visits/orders. */
  returningCustomers: number;
  /** No visit/order in the last LAPSED_CUSTOMER_WINDOW_DAYS days (includes never). */
  lapsedCustomers: number;
  /** Customers who have never had a visit or an order recorded. */
  neverVisited: number;
  newWindowDays: number;
  lapsedWindowDays: number;
}

/**
 * Classify a customer's activity.
 *
 * Definitions are deliberately documented and deterministic — the UI repeats
 * them verbatim so no number is ever guessed:
 *  - "new"       → HAS at least one visit/order and the FIRST one was within
 *                  the last 30 days. Creating a profile is not a visit, so a
 *                  guest with no activity is never "new".
 *  - "returning" → 2+ recorded visits/orders (any time).
 *  - "lapsed"    → no visit/order in the last 90 days. This INCLUDES guests who
 *                  never visited; `neverVisited` breaks that subset out.
 *  - "never"     → 0 recorded visits/orders (a subset of "lapsed").
 */
export function classifyActivity(
  activity: CustomerActivity,
  now: Date,
): Pick<
  CustomerSummary,
  "newCustomers" | "returningCustomers" | "lapsedCustomers" | "neverVisited"
> {
  const dayMs = 86_400_000;
  const newSince = now.getTime() - NEW_CUSTOMER_WINDOW_DAYS * dayMs;
  const lapsedSince = now.getTime() - LAPSED_CUSTOMER_WINDOW_DAYS * dayMs;

  const neverVisited = activity.visits === 0;
  const isReturning = activity.visits >= 2;
  const isNew = !neverVisited && !!activity.firstVisit && activity.firstVisit.getTime() >= newSince;

  const last = activity.lastVisit;
  const isLapsed = !last || last.getTime() < lapsedSince;

  return {
    newCustomers: isNew ? 1 : 0,
    returningCustomers: isReturning ? 1 : 0,
    lapsedCustomers: isLapsed ? 1 : 0,
    neverVisited: neverVisited ? 1 : 0,
  };
}

export function emptySummary(): CustomerSummary {
  return {
    total: 0,
    newCustomers: 0,
    returningCustomers: 0,
    lapsedCustomers: 0,
    neverVisited: 0,
    newWindowDays: NEW_CUSTOMER_WINDOW_DAYS,
    lapsedWindowDays: LAPSED_CUSTOMER_WINDOW_DAYS,
  };
}
