-- Add a typed business key for bill-paid outbox idempotency. The JSON payload
-- remains the worker input, but is no longer queried as a dedupe index.
ALTER TABLE "BackgroundJob" ADD COLUMN "billId" TEXT;

-- Preserve the existing bill association for already-enqueued follow-up jobs.
UPDATE "BackgroundJob"
SET "billId" = NULLIF(("payload"::jsonb ->> 'billId'), '')
WHERE "type" = 'RESTAURANT_BILL_PAID'
  AND "billId" IS NULL
  AND ("payload"::jsonb ? 'billId');

-- Historical concurrent enqueue races may have left duplicate rows. Keep the
-- most advanced job for each bill (completed > running > queued > other), and
-- cancel any duplicate still queued/running before installing the unique key.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "type", "billId"
      ORDER BY
        CASE "status"
          WHEN 'COMPLETED' THEN 0
          WHEN 'RUNNING' THEN 1
          WHEN 'QUEUED' THEN 2
          ELSE 3
        END,
        "createdAt" ASC,
        "id" ASC
    ) AS rn
  FROM "BackgroundJob"
  WHERE "type" = 'RESTAURANT_BILL_PAID'
    AND "billId" IS NOT NULL
)
UPDATE "BackgroundJob" AS job
SET
  "billId" = NULL,
  "status" = CASE
    WHEN job."status" IN ('QUEUED', 'RUNNING') THEN 'CANCELLED'
    ELSE job."status"
  END,
  "lockedAt" = CASE
    WHEN job."status" IN ('QUEUED', 'RUNNING') THEN NULL
    ELSE job."lockedAt"
  END,
  "lockedBy" = CASE
    WHEN job."status" IN ('QUEUED', 'RUNNING') THEN NULL
    ELSE job."lockedBy"
  END,
  "lastError" = CASE
    WHEN job."status" IN ('QUEUED', 'RUNNING') THEN 'Duplicate bill-paid job superseded during dedupe migration'
    ELSE job."lastError"
  END
FROM ranked
WHERE job."id" = ranked."id"
  AND ranked.rn > 1;

CREATE UNIQUE INDEX "BackgroundJob_type_billId_key"
ON "BackgroundJob"("type", "billId");
