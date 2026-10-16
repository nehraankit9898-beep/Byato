-- 0014_schema_drift_parity_fix
--
-- Reconciles the PostgreSQL migrations with prisma/schema.postgres.prisma.
--
-- ROOT CAUSE (production HTTP 500 contributor): migrations 0004–0010 were
-- hand-written SQL that drifted from the Prisma schema in three ways:
--   1. CRITICAL — migration 0009 added "BranchMembership"."orgId", but the
--      Prisma schema (and application code, src/lib/franchise.ts) use
--      "franchiseOrganizationId". After `prisma migrate deploy` on Neon, every
--      franchise/branch query touching that column failed at runtime with
--      Prisma P2021/P2022 ("column does not exist") → HTTP 500 on
--      /api/branches and franchise routes.
--   2. FK constraints were created with ON DELETE only — the schema's
--      implicit default also requires ON UPDATE CASCADE → perpetual drift
--      and broken future `migrate dev` baselines.
--   3. Missing/extra indexes: Reservation.publicToken had no unique index
--      (schema declares @unique); ABExperiment.active and
--      WhiteLabelConfig.customDomain indexes were never created;
--      Campaign.messageTemplateId index exists but is not in the schema;
--      the JourneyStepDelivery unique index name was hand-truncated
--      differently than Prisma truncates it.
--
-- SAFETY:
--   - FORWARD-ONLY and DATA-PRESERVING: the column change is a RENAME
--     (BranchMembership.orgId → franchiseOrganizationId) — no data is
--     dropped, reset, or rewritten.
--   - IDEMPOTENT: every statement is guarded (IF EXISTS / IF NOT EXISTS /
--     DO-block with duplicate_object handling) so re-runs and partially
--     reconciled databases are safe.
--   - Validated afterwards with `prisma migrate diff` (must be empty):
--     see tests/deployment-config.test.ts and .github/workflows/ci.yml.

-- ---------------------------------------------------------------------------
-- 1. Drop the affected foreign keys (re-created below with the exact
--    referential actions the schema declares).
-- ---------------------------------------------------------------------------

ALTER TABLE "ABAssignment" DROP CONSTRAINT IF EXISTS "ABAssignment_experimentId_fkey";
ALTER TABLE "ABAssignment" DROP CONSTRAINT IF EXISTS "ABAssignment_userId_fkey";
ALTER TABLE "BranchMembership" DROP CONSTRAINT IF EXISTS "BranchMembership_orgId_fkey";
ALTER TABLE "BranchMembership" DROP CONSTRAINT IF EXISTS "BranchMembership_franchiseOrganizationId_fkey";
ALTER TABLE "BranchMenuOverride" DROP CONSTRAINT IF EXISTS "BranchMenuOverride_hotelId_fkey";
ALTER TABLE "BranchMenuOverride" DROP CONSTRAINT IF EXISTS "BranchMenuOverride_templateItemId_fkey";
ALTER TABLE "CentralMenuRollout" DROP CONSTRAINT IF EXISTS "CentralMenuRollout_orgId_fkey";
ALTER TABLE "CentralMenuRollout" DROP CONSTRAINT IF EXISTS "CentralMenuRollout_templateId_fkey";
ALTER TABLE "CentralMenuTemplate" DROP CONSTRAINT IF EXISTS "CentralMenuTemplate_orgId_fkey";
ALTER TABLE "CentralMenuTemplateItem" DROP CONSTRAINT IF EXISTS "CentralMenuTemplateItem_templateId_fkey";
ALTER TABLE "CompetitorBenchmark" DROP CONSTRAINT IF EXISTS "CompetitorBenchmark_hotelId_fkey";
ALTER TABLE "CustomRole" DROP CONSTRAINT IF EXISTS "CustomRole_hotelId_fkey";
ALTER TABLE "CustomRoleAssignment" DROP CONSTRAINT IF EXISTS "CustomRoleAssignment_customRoleId_fkey";
ALTER TABLE "CustomRoleAssignment" DROP CONSTRAINT IF EXISTS "CustomRoleAssignment_userId_fkey";
ALTER TABLE "FranchiseOrganizationAdmin" DROP CONSTRAINT IF EXISTS "FranchiseOrganizationAdmin_orgId_fkey";
ALTER TABLE "FranchiseOrganizationAdmin" DROP CONSTRAINT IF EXISTS "FranchiseOrganizationAdmin_userId_fkey";
ALTER TABLE "PrivacyRequest" DROP CONSTRAINT IF EXISTS "PrivacyRequest_hotelId_fkey";
ALTER TABLE "SubscriptionMandate" DROP CONSTRAINT IF EXISTS "SubscriptionMandate_hotelId_fkey";
ALTER TABLE "SubscriptionRefund" DROP CONSTRAINT IF EXISTS "SubscriptionRefund_hotelId_fkey";
ALTER TABLE "WebhookDelivery" DROP CONSTRAINT IF EXISTS "WebhookDelivery_endpointId_fkey";
ALTER TABLE "WebhookEndpoint" DROP CONSTRAINT IF EXISTS "WebhookEndpoint_hotelId_fkey";
ALTER TABLE "WhiteLabelConfig" DROP CONSTRAINT IF EXISTS "WhiteLabelConfig_hotelId_fkey";

-- ---------------------------------------------------------------------------
-- 2. BranchMembership: rename orgId → franchiseOrganizationId (DATA KEPT).
--    Guarded: only renames when the old column exists and the new one does
--    not (databases already reconciled — or fresh db push installs — are
--    untouched).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'BranchMembership'
          AND column_name = 'orgId'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'BranchMembership'
          AND column_name = 'franchiseOrganizationId'
    ) THEN
        ALTER TABLE "BranchMembership" RENAME COLUMN "orgId" TO "franchiseOrganizationId";
    END IF;
END $$;

-- The old orgId index (if present) referenced the old name; the schema
-- declares no standalone index on this column.
DROP INDEX IF EXISTS "BranchMembership_orgId_idx";

-- ---------------------------------------------------------------------------
-- 3. Index reconciliation.
-- ---------------------------------------------------------------------------

-- Reservation.publicToken is @unique in the schema but was never given a
-- unique index by migration 0007. NULLs are allowed (publicToken String?)
-- and do not conflict in PostgreSQL.
CREATE UNIQUE INDEX IF NOT EXISTS "Reservation_publicToken_key" ON "Reservation"("publicToken");

CREATE INDEX IF NOT EXISTS "ABExperiment_active_idx" ON "ABExperiment"("active");
CREATE INDEX IF NOT EXISTS "WhiteLabelConfig_customDomain_idx" ON "WhiteLabelConfig"("customDomain");

-- Present in migration 0004 but not declared by the schema.
DROP INDEX IF EXISTS "Campaign_messageTemplateId_idx";

-- Normalize the hand-truncated 63-byte name to Prisma's own truncation.
ALTER INDEX IF EXISTS "JourneyStepDelivery_enrollmentId_journeyStepId_occurrenceKey_ke"
    RENAME TO "JourneyStepDelivery_enrollmentId_journeyStepId_occurrenceKe_key";

-- ---------------------------------------------------------------------------
-- 4. Re-create the foreign keys with the schema's exact referential actions
--    (ON DELETE … ON UPDATE CASCADE — the previous migrations omitted
--    ON UPDATE, leaving the database in permanent drift).
-- ---------------------------------------------------------------------------

DO $$ BEGIN
    ALTER TABLE "ABAssignment"
        ADD CONSTRAINT "ABAssignment_experimentId_fkey"
        FOREIGN KEY ("experimentId") REFERENCES "ABExperiment"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "ABAssignment"
        ADD CONSTRAINT "ABAssignment_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "BranchMembership"
        ADD CONSTRAINT "BranchMembership_franchiseOrganizationId_fkey"
        FOREIGN KEY ("franchiseOrganizationId") REFERENCES "FranchiseOrganization"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "BranchMenuOverride"
        ADD CONSTRAINT "BranchMenuOverride_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "BranchMenuOverride"
        ADD CONSTRAINT "BranchMenuOverride_templateItemId_fkey"
        FOREIGN KEY ("templateItemId") REFERENCES "CentralMenuTemplateItem"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "CentralMenuRollout"
        ADD CONSTRAINT "CentralMenuRollout_orgId_fkey"
        FOREIGN KEY ("orgId") REFERENCES "FranchiseOrganization"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "CentralMenuRollout"
        ADD CONSTRAINT "CentralMenuRollout_templateId_fkey"
        FOREIGN KEY ("templateId") REFERENCES "CentralMenuTemplate"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "CentralMenuTemplate"
        ADD CONSTRAINT "CentralMenuTemplate_orgId_fkey"
        FOREIGN KEY ("orgId") REFERENCES "FranchiseOrganization"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "CentralMenuTemplateItem"
        ADD CONSTRAINT "CentralMenuTemplateItem_templateId_fkey"
        FOREIGN KEY ("templateId") REFERENCES "CentralMenuTemplate"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "CompetitorBenchmark"
        ADD CONSTRAINT "CompetitorBenchmark_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "CustomRole"
        ADD CONSTRAINT "CustomRole_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "CustomRoleAssignment"
        ADD CONSTRAINT "CustomRoleAssignment_customRoleId_fkey"
        FOREIGN KEY ("customRoleId") REFERENCES "CustomRole"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "CustomRoleAssignment"
        ADD CONSTRAINT "CustomRoleAssignment_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "FranchiseOrganizationAdmin"
        ADD CONSTRAINT "FranchiseOrganizationAdmin_orgId_fkey"
        FOREIGN KEY ("orgId") REFERENCES "FranchiseOrganization"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "FranchiseOrganizationAdmin"
        ADD CONSTRAINT "FranchiseOrganizationAdmin_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "PrivacyRequest"
        ADD CONSTRAINT "PrivacyRequest_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "SubscriptionMandate"
        ADD CONSTRAINT "SubscriptionMandate_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "SubscriptionRefund"
        ADD CONSTRAINT "SubscriptionRefund_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "WebhookDelivery"
        ADD CONSTRAINT "WebhookDelivery_endpointId_fkey"
        FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "WebhookEndpoint"
        ADD CONSTRAINT "WebhookEndpoint_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "WhiteLabelConfig"
        ADD CONSTRAINT "WhiteLabelConfig_hotelId_fkey"
        FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
