/**
 * Serverless cron driver — regression suite for the 2026-10-21 go-live gap:
 * the Vercel deployment (primary production target) has NO worker process, so
 * scheduled campaigns, journey steps, automation scans, owner reports, webhook
 * retries and the DB job queue never moved. `vercel.json` + `/api/cron/*` fix
 * that. These tests pin the properties that make the fix real:
 *
 *   1. SCHEDULE INVARIANTS — vercel.json exists, points at routes that exist,
 *      and both routes are bounded (maxDuration) and use the shared handler.
 *   2. AUTH FAIL-CLOSED — no secret → 401, wrong secret → 401, query-string
 *      secrets are not accepted (they were banned for the follow-up engine),
 *      valid Bearer / x-cron-secret → 200. Production without CRON_SECRET →
 *      503 (never "open"), asserted against the auth helper directly.
 *   3. IT ACTUALLY RUNS WORK — a queued job is claimed and COMPLETED by a cron
 *      invocation with no worker running (the entire point of the change).
 *   4. NO DOUBLE EXECUTION — two overlapping invocations still claim the job
 *      exactly once (lease fencing), so a 5-minute tick cannot double-send.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

import { testDb } from "./helpers";

const ROOT = resolve(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const BASE = process.env.TEST_BASE_URL || "";
const CRON_SECRET = process.env.CRON_SECRET || "";

const db = testDb();

/* ------------------------------------------------------------------ */
/* 1. Schedule + deployment invariants                                 */
/* ------------------------------------------------------------------ */

describe("vercel.json cron schedule", () => {
  const vercel = JSON.parse(read("vercel.json")) as {
    crons?: { path: string; schedule: string }[];
  };

  test("vercel.json exists and declares cron jobs", () => {
    expect(existsSync(join(ROOT, "vercel.json"))).toBe(true);
    expect(Array.isArray(vercel.crons)).toBe(true);
    expect((vercel.crons ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("every cron path resolves to a real route handler", () => {
    for (const cron of vercel.crons ?? []) {
      expect(cron.path.startsWith("/api/cron/")).toBe(true);
      const routeFile = join(ROOT, "src", "app", cron.path.replace(/^\//, ""), "route.ts");
      expect(existsSync(routeFile)).toBe(true);
    }
  });

  test("the fast tick runs every 5 minutes and the heavy scan runs hourly", () => {
    const byPath = Object.fromEntries((vercel.crons ?? []).map((c) => [c.path, c.schedule]));
    expect(byPath["/api/cron/sweep"]).toBe("*/5 * * * *");
    expect(byPath["/api/cron/maintenance"]).toBe("7 * * * *");
  });

  test("schedules are valid 5-field cron expressions", () => {
    const fields = (schedule: string) => schedule.trim().split(/\s+/);
    for (const cron of vercel.crons ?? []) {
      expect(fields(cron.schedule)).toHaveLength(5);
      for (const field of fields(cron.schedule)) {
        expect(field).toMatch(/^[0-9*/,:-]+$/);
      }
    }
  });

  test("both routes use the shared cron handler and stay bounded", () => {
    for (const path of ["/api/cron/sweep", "/api/cron/maintenance"]) {
      const route = read(join("src", "app", path.replace(/^\//, ""), "route.ts"));
      expect(route).toContain("handleCronRequest");
      expect(route).toContain("export const maxDuration = 60");
      expect(route).toContain("force-dynamic");
    }
  });

  test("CRON_SECRET is documented in the environment template and runbook", () => {
    expect(read(".env.example")).toContain("CRON_SECRET=");
    expect(read("docs/VERCEL_NEON_DEPLOYMENT.md")).toContain("CRON_SECRET");
  });
});

/* ------------------------------------------------------------------ */
/* 2. Authentication — fail closed                                     */
/* ------------------------------------------------------------------ */

async function cronGet(path: string, headers: Record<string, string> = {}) {
  return fetch(`${BASE}${path}`, { headers, cache: "no-store" });
}

describe("cron endpoint authentication", () => {
  beforeAll(() => {
    // The harness sets CRON_SECRET for the server AND for this process; if it
    // is missing the assertions below would be meaningless.
    expect(CRON_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  test("no credentials → 401 UNAUTHORIZED (and no work is run)", async () => {
    const res = await cronGet("/api/cron/sweep");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error?: { code?: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("UNAUTHORIZED");
  });

  test("wrong secret → 401", async () => {
    const res = await cronGet("/api/cron/sweep", {
      authorization: `Bearer ${"x".repeat(CRON_SECRET.length)}`,
    });
    expect(res.status).toBe(401);
  });

  test("a query-string secret is NOT accepted (banned pattern)", async () => {
    const res = await cronGet(`/api/cron/sweep?secret=${encodeURIComponent(CRON_SECRET)}`);
    expect(res.status).toBe(401);
  });

  test("Authorization: Bearer <CRON_SECRET> → 200 (Vercel Cron's own format)", async () => {
    const res = await cronGet("/api/cron/maintenance", {
      authorization: `Bearer ${CRON_SECRET}`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      task: string;
      auth: string;
      automation?: { hotelsScanned: number; executionsQueued: number; executionsRun: number };
      reports?: number;
      queue?: { workerId: string };
    };
    expect(body.ok).toBe(true);
    expect(body.task).toBe("maintenance");
    expect(body.auth).toBe("secret");
    // The hourly task must actually run the automation scan + report enqueue.
    expect(typeof body.automation?.hotelsScanned).toBe("number");
    expect(body.automation!.hotelsScanned).toBeGreaterThan(0);
    expect(typeof body.reports).toBe("number");
    expect(body.queue?.workerId.startsWith("cron-")).toBe(true);
  });

  test("x-cron-secret header → 200 (non-Vercel schedulers / manual ops run)", async () => {
    const res = await cronGet("/api/cron/sweep", { "x-cron-secret": CRON_SECRET });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; task: string; scheduler?: unknown };
    expect(body.ok).toBe(true);
    expect(body.task).toBe("sweep");
    expect(body.scheduler).toBeDefined();
  });
});

describe("authorizeCron fail-closed contract", () => {
  test("production without CRON_SECRET → 503, never open", async () => {
    const { authorizeCron } = await import("../src/lib/cron");
    const previous = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      const result = authorizeCron(new Request("http://localhost/api/cron/sweep"), {});
      expect(result.ok).toBe(false);
      expect(result.status).toBe(503);
      expect(result.code).toBe("CRON_SECRET_NOT_CONFIGURED");
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = previous;
    }
  });

  test("non-production without CRON_SECRET → allowed as dev-open (not as 'secret')", async () => {
    const { authorizeCron } = await import("../src/lib/cron");
    const result = authorizeCron(new Request("http://localhost/api/cron/sweep"), {});
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("dev-open");
  });

  test("Bearer parsing is case-insensitive and x-cron-secret wins", async () => {
    const { presentedCronSecret } = await import("../src/lib/cron");
    expect(
      presentedCronSecret(
        new Request("http://localhost/x", { headers: { authorization: "bearer  s3cr3t " } }),
      ),
    ).toBe("s3cr3t");
    expect(
      presentedCronSecret(new Request("http://localhost/x", { headers: { authorization: "Basic abc" } })),
    ).toBeNull();
    expect(
      presentedCronSecret(
        new Request("http://localhost/x", {
          headers: { authorization: "Bearer from-header", "x-cron-secret": "from-x-header" },
        }),
      ),
    ).toBe("from-x-header");
  });
});

/* ------------------------------------------------------------------ */
/* 3. The queue actually drains with no worker running                */
/* ------------------------------------------------------------------ */

async function waitForJob(jobId: string, predicate: (job: { status: string; attempts: number }) => boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last: { status: string; attempts: number } | null = null;
  while (Date.now() < deadline) {
    const job = await db.backgroundJob.findUnique({
      where: { id: jobId },
      select: { status: true, attempts: true },
    });
    if (job) {
      last = job;
      if (predicate(job)) return job;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`job ${jobId} did not reach the expected state; last=${JSON.stringify(last)}`);
}

describe("queue drain without a worker", () => {
  test("a queued job is executed and completed by one cron tick", async () => {
    const hotel = await db.hotel.findFirst({ select: { id: true } });
    expect(hotel?.id).toBeTruthy();

    const job = await db.backgroundJob.create({
      data: {
        type: "CSV_EXPORT",
        payload: JSON.stringify({ hotelId: hotel!.id }),
        hotelId: hotel!.id,
        status: "QUEUED",
        maxAttempts: 1,
      },
      select: { id: true },
    });

    const res = await cronGet("/api/cron/sweep", { "x-cron-secret": CRON_SECRET });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      queue?: { claimed: number; completed: number; stoppedReason: string };
    };
    // The job must be drained inside the SAME request that dispatched it.
    expect(body.queue).toBeDefined();
    expect(body.queue!.claimed).toBeGreaterThanOrEqual(1);
    expect(body.queue!.completed).toBeGreaterThanOrEqual(1);

    const settled = await waitForJob(job.id, (j) => j.status === "COMPLETED");
    expect(settled.attempts).toBe(1);

    const stored = await db.backgroundJob.findUnique({
      where: { id: job.id },
      select: { result: true, lastError: true, lockedBy: true },
    });
    expect(stored?.lockedBy).toBeNull();
    expect(stored?.lastError).toBeNull();
    expect(stored?.result ?? "").toContain("rows");
  });

  test("two overlapping ticks claim the same job exactly once", async () => {
    const hotel = await db.hotel.findFirst({ select: { id: true } });
    const job = await db.backgroundJob.create({
      data: {
        type: "CSV_EXPORT",
        payload: JSON.stringify({ hotelId: hotel!.id }),
        hotelId: hotel!.id,
        status: "QUEUED",
        maxAttempts: 1,
      },
      select: { id: true },
    });

    const [a, b] = await Promise.all([
      cronGet("/api/cron/sweep", { "x-cron-secret": CRON_SECRET }),
      cronGet("/api/cron/sweep", { "x-cron-secret": CRON_SECRET }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const settled = await waitForJob(job.id, (j) => j.status === "COMPLETED");
    // Lease fencing: the second invocation must not have claimed it again.
    expect(settled.attempts).toBe(1);
  });
});
