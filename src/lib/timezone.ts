/**
 * Server-facing hotel calendar helpers.
 *
 * The pure date/timezone functions live in `timezone-core.ts` so client
 * components can format dashboard calendar labels without pulling Prisma and
 * the database adapter into the browser bundle.
 */

export * from "./timezone-core";

/** The hotel's IANA timezone, falling back to the platform default. */
export async function hotelTimezone(hotelId: string): Promise<string> {
  // Lazy import keeps the calendar helpers free of DB side effects and keeps
  // the server-only database dependency out of client bundles.
  const { db } = await import("@/lib/db");
  const hotel = await db.hotel.findUnique({
    where: { id: hotelId },
    select: { timezone: true },
  });
  const { DEFAULT_TIMEZONE, isValidTimeZone } = await import("./timezone-core");
  return isValidTimeZone(hotel?.timezone) ? hotel.timezone : DEFAULT_TIMEZONE;
}
