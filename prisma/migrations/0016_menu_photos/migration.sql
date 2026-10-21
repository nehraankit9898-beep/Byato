-- Migration 0016 — Menu photo storage (PostgreSQL — production source of truth).
--
-- Adds the MediaAsset table that backs the food-photo feature. Menu photos are
-- re-encoded server-side (WebP, <=1600 px, EXIF stripped) and stored HERE, in
-- the same PostgreSQL database as the menu, so uploads do not depend on a
-- serverless filesystem (Vercel /tmp is ephemeral and read-only in the build
-- output) and need no bucket credentials.
--
-- Why this shape:
--   * `hotelId` FK with ON DELETE CASCADE — deleting a tenant removes its
--     photos with it; nothing is shared across tenants.
--   * UNIQUE (hotelId, checksum, kind) — re-uploading identical bytes reuses
--     the existing row instead of growing the table (idempotent re-saves).
--   * `data` BYTEA — the only place image bytes are kept; served from
--     /api/media/<id> with immutable caching.
--
-- Safe upgrade path: purely ADDITIVE (one new table, its indexes and its FK).
-- No existing column, row or index is touched, so existing installations keep
-- working and this migration can be applied while the app is serving traffic.
--
-- Safe to re-run: every statement checks before it mutates.

CREATE TABLE IF NOT EXISTS "MediaAsset" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'MENU_PHOTO',
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- De-duplication fence: identical bytes for the same tenant and kind.
CREATE UNIQUE INDEX IF NOT EXISTS "MediaAsset_hotelId_checksum_kind_key"
    ON "MediaAsset"("hotelId", "checksum", "kind");

-- Tenant listing / future quota + cleanup sweeps.
CREATE INDEX IF NOT EXISTS "MediaAsset_hotelId_createdAt_idx"
    ON "MediaAsset"("hotelId", "createdAt");

DO $$
BEGIN
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MediaAsset_hotelId_fkey') THEN
      ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   END IF;
END $$;
