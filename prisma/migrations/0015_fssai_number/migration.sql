-- FSSAI licence number on HotelSettings (PostgreSQL) — re-runnable.
--
-- India compliance + reputation feature:
--   * fssaiNumber — 14-digit FSSAI licence/registration number, displayed on
--     the public digital menu footer (display is required for Indian food
--     businesses). Nullable: tenants outside India / without a licence yet.
--   * reviewUrl already exists from Phase 14/15/16; it is now also offered to
--     guests who leave 4-5 star QR feedback ("Rate us on Google" CTA), so no
--     new column is needed for it.
--
-- Rollback:
--   ALTER TABLE "HotelSettings" DROP COLUMN IF EXISTS "fssaiNumber";

ALTER TABLE "HotelSettings" ADD COLUMN IF NOT EXISTS "fssaiNumber" TEXT;
