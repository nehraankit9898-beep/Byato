import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { normalizePhone } from "@/lib/phone";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import {
  parseWithFieldErrors,
  customerCreateSchema,
  customerListQuerySchema,
} from "@/lib/validation";
import {
  classifyActivity,
  createCustomerForTenant,
  emptySummary,
  type CustomerSummary,
} from "@/lib/customers";

/**
 * GET /api/customers — server-side search / filter / sort / pagination.
 * Query: q (or search), consent (all|opted_in|opted_out), status (all|active|inactive),
 *        activity (all|new|returning|lapsed|never),
 *        sort (created|name|visits|last_visit), order (asc|desc), page, pageSize
 *
 * Every filter is scoped to the session's hotel — a customer from another
 * restaurant is indistinguishable from one that does not exist.
 *
 * The response also carries a `summary` block used by the CRM dashboard cards.
 * The numbers are computed from real rows (hotel stays + restaurant bills) —
 * nothing is estimated and nothing is hardcoded.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOMER_READ");
    if (denied) return denied;
    const { hotelId } = auth.user;

    const url = new URL(req.url);
    const parsedQuery = customerListQuerySchema.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!parsedQuery.success) {
      return jsonError("Those filters are not valid. Please reset them and try again.");
    }
    const { q, search, consent, status, activity, sort, order, page, pageSize } = parsedQuery.data;

    // `search` is accepted as an alias of `q` (older clients use it).
    const term = (q || search).trim();

    const where: Record<string, unknown> = { hotelId };
    if (term) {
      const digits = term.replace(/[\s\-()+]/g, "");
      const phoneCandidates = new Set<string>([digits]);
      // "9876543210" and "+91 98765 43210" must both find the customer, so the
      // search term is normalized the same way stored numbers are.
      const normalized = normalizePhone(term);
      if (normalized.ok && normalized.normalized) {
        phoneCandidates.add(normalized.normalized);
        phoneCandidates.add(normalized.normalized.replace(/^\+/, ""));
      }
      where.OR = [
        { name: { contains: term } },
        { email: { contains: term } },
        ...[...phoneCandidates].filter(Boolean).map((p) => ({ phone: { contains: p } })),
      ];
    }
    if (consent === "opted_in") where.AND = [{ marketingConsent: true }, { optOut: false }];
    else if (consent === "opted_out") where.optOut = true;
    if (status === "active") where.status = "ACTIVE";
    else if (status === "inactive") where.status = "INACTIVE";

    // One pass over the matching customers collects every metric the list, the
    // sort and the summary cards need:
    //   - hotel stays (Visit) and restaurant bills (RestaurantVisit) BOTH count
    //     toward visits and spend, so a café workspace sees real numbers while
    //     a hotel workspace is unaffected (the split stays available under the
    //     …Restaurant-suffixed fields).
    const rows = await db.customer.findMany({
      where,
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        marketingConsent: true,
        whatsappOptIn: true,
        smsOptIn: true,
        emailOptIn: true,
        optOut: true,
        consentTimestamp: true,
        status: true,
        createdAt: true,
        vip: true,
        lastRestaurantVisit: true,
        totalRestaurantSpend: true,
        visits: { select: { checkin: true, amount: true } },
        restaurantVisits: { select: { visitDate: true, orderAmount: true } },
      },
    });

    const now = new Date();
    type Row = (typeof rows)[number] & {
      __visits: number;
      __spend: number;
      __first: Date | null;
      __last: Date | null;
      __lastStay: Date | null;
      __new: boolean;
      __returning: boolean;
      __lapsed: boolean;
      __never: boolean;
    };

    const computed: Row[] = rows.map((c) => {
      const stayCount = c.visits.length;
      const dineCount = c.restaurantVisits.length;
      const staySpend = c.visits.reduce((s, v) => s + (v.amount ?? 0), 0);
      const dineSpend = c.restaurantVisits.reduce((s, v) => s + v.orderAmount, 0);

      let lastStay: Date | null = null;
      for (const v of c.visits) {
        if (!lastStay || v.checkin > lastStay) lastStay = v.checkin;
      }
      let firstStay: Date | null = null;
      for (const v of c.visits) {
        if (!firstStay || v.checkin < firstStay) firstStay = v.checkin;
      }
      let lastDine: Date | null = null;
      let firstDine: Date | null = null;
      for (const v of c.restaurantVisits) {
        if (!lastDine || v.visitDate > lastDine) lastDine = v.visitDate;
        if (!firstDine || v.visitDate < firstDine) firstDine = v.visitDate;
      }

      const first =
        firstStay && firstDine
          ? firstStay < firstDine
            ? firstStay
            : firstDine
          : (firstStay ?? firstDine);
      const last =
        lastStay && lastDine ? (lastStay > lastDine ? lastStay : lastDine) : (lastStay ?? lastDine);

      const flags = classifyActivity(
        {
          visits: stayCount + dineCount,
          spend: staySpend + dineSpend,
          firstVisit: first,
          lastVisit: last,
        },
        now,
      );

      return {
        ...c,
        __visits: stayCount + dineCount,
        __spend: Math.round((staySpend + dineSpend) * 100) / 100,
        __first: first,
        __last: last,
        __lastStay: lastStay,
        __new: flags.newCustomers === 1,
        __returning: flags.returningCustomers === 1,
        __lapsed: flags.lapsedCustomers === 1,
        __never: flags.neverVisited === 1,
      };
    });

    // ---- Summary cards (over everything that matched search/consent/status) ----
    const summary: CustomerSummary = computed.reduce((acc, c) => {
      acc.total += 1;
      acc.newCustomers += c.__new ? 1 : 0;
      acc.returningCustomers += c.__returning ? 1 : 0;
      acc.lapsedCustomers += c.__lapsed ? 1 : 0;
      acc.neverVisited += c.__never ? 1 : 0;
      return acc;
    }, emptySummary());

    // ---- Activity filter (applied AFTER the summary so the cards always show
    //      the full breakdown of the current result set) ----
    const filtered =
      activity === "all"
        ? computed
        : computed.filter((c) =>
            activity === "new"
              ? c.__new
              : activity === "returning"
                ? c.__returning
                : activity === "never"
                  ? c.__never
                  : c.__lapsed,
          );

    const sorted = [...filtered];
    const dir = order === "asc" ? 1 : -1;
    if (sort === "name") {
      sorted.sort((a, b) => dir * a.name.localeCompare(b.name));
    } else if (sort === "visits") {
      sorted.sort((a, b) => dir * (a.__visits - b.__visits));
    } else if (sort === "last_visit") {
      sorted.sort((a, b) => {
        const at = a.__last?.getTime() ?? 0;
        const bt = b.__last?.getTime() ?? 0;
        return dir * (at - bt);
      });
    } else {
      sorted.sort((a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime()));
    }

    const total = sorted.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const skip = (page - 1) * pageSize;
    const pageRows = sorted.slice(skip, skip + pageSize);

    return Response.json({
      customers: pageRows.map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        marketingConsent: c.marketingConsent,
        whatsappOptIn: c.whatsappOptIn,
        smsOptIn: c.smsOptIn,
        emailOptIn: c.emailOptIn,
        optOut: c.optOut,
        consentTimestamp: c.consentTimestamp,
        status: c.status,
        createdAt: c.createdAt,
        // Unified (hotel stays + restaurant bills):
        totalVisits: c.__visits,
        lastVisit: c.__last,
        campaignEligible: c.marketingConsent && !c.optOut && c.status === "ACTIVE",
        vip: c.vip,
        totalSpend: c.__spend,
        // Domain-separated views (hotel stays only / restaurant only):
        hotelVisits: c.visits.length,
        lastHotelVisit: c.__lastStay,
        restaurantVisits: c.restaurantVisits.length,
        lastRestaurantVisit: c.lastRestaurantVisit,
        totalRestaurantSpend: c.totalRestaurantSpend,
        // Activity buckets (same definitions as the summary cards) — lets the
        // list render a "New"/"Returning" chip without a second request.
        isNew: c.__new,
        isReturning: c.__returning,
        isLapsed: c.__lapsed,
        neverVisited: c.__never,
      })),
      total,
      page,
      pageSize,
      totalPages,
      summary,
    });
  } catch (err) {
    return serverError(err, "Could not load customers right now. Please refresh the page.");
  }
}

/**
 * POST /api/customers — create a customer (phone normalized + duplicate check).
 *
 * The tenant is ALWAYS the session's hotel. A `hotelId`/`restaurantId` field in
 * the body is ignored on purpose — a client can never choose where a customer
 * is stored.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOMER_CREATE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;

    // The plan limit is enforced ATOMICALLY with the create (a pre-check was
    // not enforcement — concurrent creates bypassed it). See lib/customers.ts.

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const parsed = parseWithFieldErrors(customerCreateSchema, body);
    if (!parsed.ok || !parsed.data) {
      return NextResponse.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: parsed.message ?? "Please check the details and try again.",
            fields: parsed.errors ?? {},
          },
        },
        { status: 400 },
      );
    }
    const input = parsed.data;

    const phoneResult = normalizePhone(input.phone);
    if (!phoneResult.ok) {
      return NextResponse.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: phoneResult.error || "Please enter a valid phone number.",
            fields: { phone: phoneResult.error || "Please enter a valid phone number." },
          },
        },
        { status: 400 },
      );
    }
    if (phoneResult.normalized && phoneResult.normalized.length > 20) {
      return NextResponse.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Phone number is too long.",
            fields: { phone: "Phone number is too long." },
          },
        },
        { status: 400 },
      );
    }

    const result = await createCustomerForTenant(hotelId, {
      name: input.name,
      phone: input.phone,
      email: input.email || null,
      marketingConsent: input.marketingConsent,
      consentSource: input.consentSource || "MANUAL_ENTRY",
      whatsappOptIn: input.whatsappOptIn,
      smsOptIn: input.smsOptIn,
      emailOptIn: input.emailOptIn,
      roomPreference: input.roomPreference?.trim() || null,
      foodPreference: input.foodPreference?.trim() || null,
      location: input.location?.trim() || null,
      birthday: parseDateOrNull(input.birthday),
      anniversary: parseDateOrNull(input.anniversary),
      source: input.source ?? null,
      notes: input.notes?.trim() || null,
      vip: input.vip,
    });

    if (!result.ok) {
      if (result.code === "DUPLICATE_PHONE") {
        return NextResponse.json(
          {
            error: {
              code: "DUPLICATE_PHONE",
              message: result.message,
              // The client offers "open the existing profile" instead of
              // silently creating a second profile for the same guest.
              existing: result.existing,
            },
          },
          { status: 409 },
        );
      }
      return jsonError(result.message, 403, "SUBSCRIPTION_LIMIT_REACHED");
    }
    const customer = result.customer;

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.CUSTOMER_CREATED,
      entityType: "customer",
      entityId: customer.id,
      // NOTE: no phone number / email in the audit payload — the row is linked
      // by entityId, and personal data is never duplicated into logs.
      metadata: {
        name: customer.name,
        consent: input.marketingConsent,
        source: input.source ?? "MANUAL",
      },
    });

    return Response.json({ customer }, { status: 201 });
  } catch (err) {
    return serverError(err, "Customer could not be saved. Please check the details and try again.");
  }
}

/**
 * Parse a DATE-ONLY customer field (birthday / anniversary).
 *
 * BUG FIX (2026-10-21, BUG_REPORT_NEW M-4): `new Date("1990-05-15")` is UTC
 * midnight, `new Date("1990-05-15T00:00")` is LOCAL midnight — the same user
 * input produced different instants depending on the string form. Calendar
 * labels are now normalised to UTC midnight, and impossible dates
 * ("2026-02-30") are rejected instead of silently rolling over.
 */
function parseDateOrNull(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw ? null : d;
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}
