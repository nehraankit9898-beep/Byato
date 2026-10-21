/**
 * Promotion window validation + PATCH payload building (pure, DB-free).
 *
 * BUG FIX (2026-10-21) — the promotions PATCH endpoint only understood
 * `name / percentBps / valueMinor / priority / stackable / active /
 * startTime / endTime`. Every other documented field (`type`, `daysOfWeek`,
 * `itemIds`, `categoryIds`, `startDate`, `endDate`) was SILENTLY IGNORED: the
 * API answered 200, bumped `version` and returned the unchanged row, so a
 * client "edit" looked successful while the data was never saved.
 *
 * The builder below is the single source of truth for both POST and PATCH
 * validation. It is pure so the rules can be unit-tested without a database
 * or HTTP server.
 */

export const PROMO_TYPES = ["PERCENT", "FLAT", "HAPPY_HOUR", "COMBO"] as const;
export type PromotionType = (typeof PROMO_TYPES)[number];

export const PROMO_DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;

export const PROMO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const PROMO_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface PromotionWindowFields {
  type: string;
  percentBps: number | null;
  valueMinor: number | null;
  daysOfWeek: string | null;
  startTime: string | null;
  endTime: string | null;
  startDate: Date | null;
  endDate: Date | null;
}

export type PromotionPatchResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; code: string; message: string };

/**
 * Parse a promotion date field.
 *
 * `edge: "end"` makes a DATE-ONLY value inclusive: "2026-12-31" becomes
 * 2026-12-31T23:59:59.999Z, not midnight. The billing engine skips a
 * promotion when `endDate <= now`, so parsing the end date as midnight made
 * an "until 31 Dec" offer stop applying at 00:00 UTC on the 31st (the whole
 * final day was lost — an off-by-one-day bug).
 *
 * `null` and `""` explicitly CLEAR the field (PATCH semantics); `undefined`
 * means "not provided" and is handled by the caller.
 */
export function parsePromoDate(
  value: unknown,
  edge: "start" | "end",
): { ok: true; date: Date | null } | { ok: false } {
  if (value === null || value === "") return { ok: true, date: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (PROMO_DATE_ONLY_RE.test(trimmed)) {
    const iso = edge === "end" ? `${trimmed}T23:59:59.999Z` : `${trimmed}T00:00:00.000Z`;
    const date = new Date(iso);
    // Reject impossible calendar dates: JS would roll "2026-02-30" over to
    // 2 March and silently start/end the promotion on the wrong day.
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== trimmed) {
      return { ok: false };
    }
    return { ok: true, date };
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? { ok: false } : { ok: true, date };
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return out.length > 0 ? [...new Set(out)].slice(0, 200) : null;
}

function fail(code: string, message: string): PromotionPatchResult {
  return { ok: false, code, message };
}

/**
 * Build the `data` object for a promotion PATCH from the raw request body.
 * Only provided fields are written; every provided field is validated against
 * the MERGED result (e.g. switching type to FLAT requires a valueMinor).
 */
export function buildPromotionPatch(
  existing: PromotionWindowFields,
  body: Record<string, unknown>,
): PromotionPatchResult {
  const data: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 3) return fail("INVALID_NAME", "Promotion name is required (min 3 chars).");
    data.name = name;
  }

  if (body.type !== undefined) {
    if (typeof body.type !== "string" || !(PROMO_TYPES as readonly string[]).includes(body.type)) {
      return fail("INVALID_TYPE", `type must be one of ${PROMO_TYPES.join(", ")}.`);
    }
    data.type = body.type;
    // Keep the row self-consistent: only the unit that belongs to the new
    // type survives (a PERCENT→FLAT switch must not leave a stale
    // percentBps behind that a later edit could silently apply).
    const percentType = body.type === "PERCENT" || body.type === "HAPPY_HOUR";
    if (percentType && body.valueMinor === undefined) data.valueMinor = null;
    if (!percentType && body.percentBps === undefined) data.percentBps = null;
    if (body.type !== "HAPPY_HOUR") {
      if (body.startTime === undefined) data.startTime = null;
      if (body.endTime === undefined) data.endTime = null;
    }
  }

  if (body.percentBps !== undefined) {
    const bps = Math.floor(Number(body.percentBps));
    if (!Number.isFinite(bps) || bps <= 0 || bps > 10_000) {
      return fail("INVALID_PERCENT", "percentBps must be between 1 and 10000 (0.01%–100%).");
    }
    data.percentBps = bps;
  }

  if (body.valueMinor !== undefined) {
    const value = Math.floor(Number(body.valueMinor));
    if (!Number.isFinite(value) || value <= 0) {
      return fail("INVALID_VALUE", "valueMinor must be a positive integer (minor units).");
    }
    data.valueMinor = value;
  }

  if (body.priority !== undefined) {
    const priority = Math.floor(Number(body.priority));
    if (!Number.isFinite(priority) || priority < 0 || priority > 1000) {
      return fail("INVALID_PRIORITY", "priority must be between 0 and 1000.");
    }
    data.priority = priority;
  }

  if (body.stackable !== undefined) {
    if (typeof body.stackable !== "boolean") return fail("INVALID_STACKABLE", "stackable must be a boolean.");
    data.stackable = body.stackable;
  }

  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") return fail("INVALID_ACTIVE", "active must be a boolean.");
    data.active = body.active;
  }

  if (body.startTime !== undefined) {
    if (body.startTime === null || body.startTime === "") data.startTime = null;
    else if (typeof body.startTime === "string" && PROMO_TIME_RE.test(body.startTime)) data.startTime = body.startTime;
    else return fail("INVALID_WINDOW", "startTime must be HH:MM (hotel-local).");
  }
  if (body.endTime !== undefined) {
    if (body.endTime === null || body.endTime === "") data.endTime = null;
    else if (typeof body.endTime === "string" && PROMO_TIME_RE.test(body.endTime)) data.endTime = body.endTime;
    else return fail("INVALID_WINDOW", "endTime must be HH:MM (hotel-local).");
  }

  if (body.daysOfWeek !== undefined) {
    if (body.daysOfWeek !== null && !Array.isArray(body.daysOfWeek)) {
      return fail("INVALID_DAYS", "daysOfWeek must be an array of MON..SUN (or null to clear).");
    }
    const days = parseStringArray(body.daysOfWeek ?? []);
    const invalid = (body.daysOfWeek as unknown[] | null)?.find(
      (d) => typeof d === "string" && !(PROMO_DAYS as readonly string[]).includes(d),
    );
    if (invalid !== undefined) {
      return fail("INVALID_DAYS", `daysOfWeek entries must be one of ${PROMO_DAYS.join(", ")}.`);
    }
    data.daysOfWeek = days ? JSON.stringify(days) : null;
  }

  if (body.itemIds !== undefined) {
    if (body.itemIds !== null && !Array.isArray(body.itemIds)) {
      return fail("INVALID_SCOPE", "itemIds must be an array of menu item ids (or null to clear).");
    }
    const ids = parseStringArray(body.itemIds ?? []);
    data.itemIdsJson = ids ? JSON.stringify(ids) : null;
  }
  if (body.categoryIds !== undefined) {
    if (body.categoryIds !== null && !Array.isArray(body.categoryIds)) {
      return fail("INVALID_SCOPE", "categoryIds must be an array of category ids (or null to clear).");
    }
    const ids = parseStringArray(body.categoryIds ?? []);
    data.categoryIdsJson = ids ? JSON.stringify(ids) : null;
  }

  let nextStart: Date | null = existing.startDate;
  let nextEnd: Date | null = existing.endDate;
  if (body.startDate !== undefined) {
    const parsed = parsePromoDate(body.startDate, "start");
    if (!parsed.ok) return fail("INVALID_WINDOW", "startDate is not a valid date.");
    nextStart = parsed.date;
    data.startDate = parsed.date;
  }
  if (body.endDate !== undefined) {
    const parsed = parsePromoDate(body.endDate, "end");
    if (!parsed.ok) return fail("INVALID_WINDOW", "endDate is not a valid date.");
    nextEnd = parsed.date;
    data.endDate = parsed.date;
  }
  if (nextStart && nextEnd && nextEnd < nextStart) {
    return fail("INVALID_WINDOW", "endDate must be after startDate.");
  }

  // -------- Consistency against the MERGED result --------
  // `??` would treat an explicit `null` (clear) as "not provided" and fall
  // back to the existing value, so use presence in `data` to decide.
  const merged = (key: string, fallback: unknown): unknown =>
    Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback;
  const nextType = merged("type", existing.type) as string;
  const nextPercent = merged("percentBps", existing.percentBps) as number | null;
  const nextValue = merged("valueMinor", existing.valueMinor) as number | null;
  const nextStartTime = merged("startTime", existing.startTime) as string | null;
  const nextEndTime = merged("endTime", existing.endTime) as string | null;

  if ((nextType === "PERCENT" || nextType === "HAPPY_HOUR") && nextPercent == null) {
    return fail("MISSING_PERCENT", `${nextType} promotions require percentBps.`);
  }
  if ((nextType === "FLAT" || nextType === "COMBO") && nextValue == null) {
    return fail("MISSING_VALUE", `${nextType} promotions require valueMinor.`);
  }
  if (nextType === "HAPPY_HOUR" && (!nextStartTime || !nextEndTime)) {
    return fail("INVALID_WINDOW", "Happy-hour promotions need startTime/endTime as HH:MM.");
  }

  return { ok: true, data };
}
