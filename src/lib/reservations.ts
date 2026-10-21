/**
 * Phase 16 — table reservations.
 *
 * CONCURRENCY SAFETY: booking runs inside a transaction that re-checks
 * overlapping ACTIVE reservations for the same table; the DB-level
 * (tableId, date, startTime, activeFence) unique index is the final fence.
 * Two concurrent requests for the same slot can never both win — the loser
 * gets a clear CONFLICT response. activeFence is 1 only while a reservation
 * is ACTIVE, so cancelled / no-show / completed rows never block a slot.
 * Party capacity is checked against the hotel's reservationMaxPartySize
 * setting.
 *
 * Time model: local business date "YYYY-MM-DD" + "HH:MM" strings in the
 * TENANT timezone (matches the financial-day convention from Phase 14).
 *
 * AUDIT FIX (2026-10-21, BUG_REPORT_NEW H-1): overlap math was minutes-of-day
 * ONLY and the conflict query only loaded reservations of the SAME `date`.
 * A 23:30 booking (90 min) and a 00:30 booking the next day therefore never
 * compared as a conflict — the same physical table could be double-booked
 * across midnight. Intervals are now resolved onto an absolute minute
 * timeline (local date + time-of-day), multi-day-tolerant, and the conflict
 * query also loads the neighbouring business dates.
 */

import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";

const ACTIVE_STATUSES = ["PENDING", "CONFIRMED", "SEATED"] as const;

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_DAY = 86_400_000;

export function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** Split an interval at midnight into 1-2 [start, end) segments of the day. */
function daySegments(startMinute: number, duration: number): Array<[number, number]> {
  const end = startMinute + duration;
  if (end <= MINUTES_PER_DAY) return [[startMinute, end]];
  const segments: Array<[number, number]> = [[startMinute, MINUTES_PER_DAY]];
  // A duration can span more than one day (defensive; the API caps at 300m).
  let leftover = end - MINUTES_PER_DAY;
  while (leftover > 0) {
    segments.push([0, Math.min(leftover, MINUTES_PER_DAY)]);
    leftover -= MINUTES_PER_DAY;
  }
  return segments;
}

/**
 * Same-date overlap test. A reservation that runs past midnight is treated as
 * continuing into the next day (23:30 + 90m → 23:30–24:00 and 00:00–01:00).
 * Invalid input fails CLOSED (reports a conflict) — a malformed booking must
 * never be able to bypass the availability check.
 */
export function overlaps(aStart: string, aDur: number, bStart: string, bDur: number): boolean {
  const a0 = timeToMinutes(aStart);
  const b0 = timeToMinutes(bStart);
  if (![a0, b0, aDur, bDur].every(Number.isFinite) || aDur <= 0 || bDur <= 0) return true;
  return daySegments(a0, aDur).some(([as, ae]) =>
    daySegments(b0, bDur).some(([bs, be]) => as < be && bs < ae),
  );
}

/** "YYYY-MM-DD" shifted by whole days (UTC arithmetic — no DST surprises). */
export function shiftIsoDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const base = Date.UTC(y, (m ?? 1) - 1, d ?? 1);
  return new Date(base + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Absolute minute index of a hotel-local date + time. Multiplying the UTC day
 * number by 1440 lets intervals that cross midnight compare correctly across
 * business dates.
 */
export function absoluteStartMinute(date: string, time: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const dayIndex = Math.floor(Date.UTC(y, (m ?? 1) - 1, d ?? 1) / MS_PER_DAY);
  return dayIndex * MINUTES_PER_DAY + timeToMinutes(time);
}

/** True when two dated intervals overlap (half-open, midnight-safe). */
export function intervalsOverlap(
  aDate: string,
  aStart: string,
  aDur: number,
  bDate: string,
  bStart: string,
  bDur: number,
): boolean {
  const a0 = absoluteStartMinute(aDate, aStart);
  const b0 = absoluteStartMinute(bDate, bStart);
  if (![a0, b0, aDur, bDur].every(Number.isFinite) || aDur <= 0 || bDur <= 0) return true;
  return a0 < b0 + bDur && b0 < a0 + aDur;
}

export interface CreateReservationInput {
  hotelId: string;
  tableId?: string | null;
  date: string;
  startTime: string;
  durationMinutes?: number;
  partySize: number;
  guestName: string;
  guestPhone: string;
  notes?: string | null;
  source?: "STAFF" | "PUBLIC";
  createdByUserId?: string | null;
  /** Auto-confirm staff bookings; public requests stay PENDING. */
  autoConfirm?: boolean;
}

export class ReservationConflictError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * BUG FIX (API contract): malformed input used to be thrown as a
 * ReservationConflictError, so a payload with a wrong date/time format or a
 * non-positive party size was answered with `409 SLOT_CONFLICT` — the code
 * that means "that table slot is already taken". Clients (and the booking UI)
 * could not tell a typo apart from a real double-booking. Shape/type problems
 * are now a distinct error the route maps to `422 VALIDATION_ERROR`; genuine
 * availability and policy conflicts stay 409.
 */
export class ReservationValidationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export async function createReservation(input: CreateReservationInput) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new ReservationValidationError("date must be YYYY-MM-DD (tenant-local).");
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.startTime)) {
    throw new ReservationValidationError("startTime must be HH:MM (tenant-local).");
  }
  const partySize = Math.floor(input.partySize);
  if (!Number.isFinite(partySize) || partySize <= 0) {
    throw new ReservationValidationError("partySize must be a positive integer.");
  }
  const duration = Math.min(Math.max(Math.floor(input.durationMinutes ?? 90), 30), 300);

  const hotel = await db.hotel.findUnique({ where: { id: input.hotelId }, select: { status: true } });
  if (!hotel || hotel.status !== "ACTIVE") {
    throw new ReservationConflictError("This restaurant is not accepting reservations.");
  }
  const settings = await db.hotelSettings.findUnique({ where: { hotelId: input.hotelId } });
  if (partySize > (settings?.reservationMaxPartySize ?? 20)) {
    throw new ReservationConflictError(`Party size above the maximum (${settings?.reservationMaxPartySize ?? 20}).`);
  }
  if (input.tableId) {
    const table = await db.diningTable.findFirst({ where: { id: input.tableId, hotelId: input.hotelId, active: true } });
    if (!table) throw new ReservationConflictError("Table not found.");
    // AUDIT FIX (P16-RSV-1): only a hotel-wide party cap was enforced — a
    // party of 12 could book a 2-top. Per-table capacity is also binding.
    if (partySize > table.capacity) {
      throw new ReservationConflictError(`That table seats ${table.capacity} guests — party of ${partySize} will not fit.`);
    }
  }

  try {
    return await db.$transaction(
      async (tx) => {
        if (input.tableId) {
          // Overlap re-check INSIDE the transaction (SQLite serializes writes;
          // on PostgreSQL the unique index below is the authoritative fence).
          // Neighbouring dates are included: a late-night reservation on the
          // previous evening can run into this one, and an early-morning
          // reservation on the next date can overlap a booking that runs past
          // midnight.
          const candidateDates = [
            shiftIsoDate(input.date, -1),
            input.date,
            shiftIsoDate(input.date, 1),
          ];
          const nearby = await tx.reservation.findMany({
            where: {
              hotelId: input.hotelId,
              tableId: input.tableId,
              date: { in: candidateDates },
              status: { in: [...ACTIVE_STATUSES] },
            },
            select: { date: true, startTime: true, durationMinutes: true },
          });
          for (const r of nearby) {
            if (
              intervalsOverlap(
                input.date,
                input.startTime,
                duration,
                r.date,
                r.startTime,
                r.durationMinutes,
              )
            ) {
              throw new ReservationConflictError("That table is already reserved for an overlapping time.");
            }
          }
        }
        return tx.reservation.create({
          data: {
            hotelId: input.hotelId,
            tableId: input.tableId ?? null,
            date: input.date,
            startTime: input.startTime,
            durationMinutes: duration,
            partySize,
            status: input.autoConfirm ? "CONFIRMED" : "PENDING",
            guestName: input.guestName.slice(0, 120),
            guestPhone: input.guestPhone.slice(0, 20),
            notes: input.notes?.slice(0, 500) ?? null,
            source: input.source ?? "STAFF",
            createdByUserId: input.createdByUserId ?? null,
            activeFence: 1,
          },
        });
      },
      { timeout: 30_000 },
    );
  } catch (err) {
    // Unique fence: (tableId, date, startTime, activeFence) — the concurrent loser lands here.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      throw new ReservationConflictError("That table is already reserved for this slot.");
    }
    throw err;
  }
}

/** Staff lifecycle transitions with audit. */
export async function transitionReservation(
  hotelId: string,
  reservationId: string,
  to: "CONFIRMED" | "SEATED" | "CANCELLED" | "NO_SHOW" | "COMPLETED",
  actorUserId: string,
  cancelReason?: string,
) {
  const ALLOWED: Record<string, string[]> = {
    PENDING: ["CONFIRMED", "CANCELLED", "NO_SHOW"],
    CONFIRMED: ["SEATED", "CANCELLED", "NO_SHOW", "COMPLETED"],
    SEATED: ["COMPLETED", "CANCELLED"],
    CANCELLED: [],
    NO_SHOW: [],
    COMPLETED: [],
  };
  const reservation = await db.reservation.findFirst({ where: { id: reservationId, hotelId } });
  if (!reservation) return { ok: false as const, reason: "Reservation not found." };
  if (!ALLOWED[reservation.status].includes(to)) {
    return { ok: false as const, reason: `Cannot move a ${reservation.status.toLowerCase()} reservation to ${to.toLowerCase()}.` };
  }
  // CLEANUP (2026-10-21): the guard read
  //   `(CANCELLED || NO_SHOW) && !cancelReason && to === "CANCELLED"`
  // — the NO_SHOW branch was dead code. Cancellation keeps requiring a
  // reason (the documented policy); the redundant condition is gone.
  if (to === "CANCELLED" && !cancelReason?.trim()) {
    return { ok: false as const, reason: "A reason is required to cancel." };
  }

  // AUDIT FIX (P16-RSV-2): the update was not status-conditional — two
  // concurrent transitions both succeeded (last-writer-wins) with two audit
  // rows. The state machine is now enforced at the DB level: the update only
  // lands while the row is still in the observed FROM state.
  const updated = await db.reservation.updateMany({
    where: { id: reservationId, hotelId, status: reservation.status },
    data: {
      status: to,
      confirmedByUserId: to === "CONFIRMED" ? actorUserId : reservation.confirmedByUserId,
      seatedAt: to === "SEATED" ? new Date() : reservation.seatedAt,
      cancelledAt: to === "CANCELLED" ? new Date() : reservation.cancelledAt,
      cancelReason:
        to === "CANCELLED" || to === "NO_SHOW"
          ? (cancelReason?.trim() ?? reservation.cancelReason)
          : reservation.cancelReason,
      // BUG FIX: inactive reservations kept holding the (tableId, date,
      // startTime) unique slot, so a cancelled slot could never be re-booked.
      activeFence: (ACTIVE_STATUSES as readonly string[]).includes(to) ? 1 : null,
    },
  });
  if (updated.count !== 1) {
    return { ok: false as const, reason: "Reservation was just updated by someone else — reload and retry." };
  }
  const fresh = await db.reservation.findUnique({ where: { id: reservationId } });
  await logAudit({
    hotelId,
    userId: actorUserId,
    action: "RESERVATION_UPDATED",
    entityType: "Reservation",
    entityId: reservationId,
    metadata: { from: reservation.status, to, reason: cancelReason ?? null },
  });
  return { ok: true as const, reservation: fresh ?? reservation };
}
