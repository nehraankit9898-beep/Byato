/**
 * Serverless cron driver — makes the automation stack run WITHOUT the worker.
 *
 * Why this exists (2026-10-21 go-live audit): every scheduled behaviour in the
 * product lived inside `scripts/worker.ts`'s loop —
 *   - due SCHEDULED campaigns were claimed + enqueued there,
 *   - journey steps were delivered there,
 *   - automation trigger scans ran there,
 *   - owner report schedules were enqueued there,
 *   - outbound webhook deliveries were retried there,
 *   - and the DB job queue (CAMPAIGN_SEND / CSV_EXPORT / OWNER_REPORT …) was
 *     only ever CONSUMED there.
 *
 * The primary production target is Vercel + Neon, where no long-lived worker
 * process exists. Result: an owner could schedule a campaign and it stayed in
 * `SCHEDULED` forever, silently. This module closes that gap with two
 * authenticated HTTP triggers (see `app/api/cron/*` and `vercel.json`):
 *
 *   /api/cron/sweep        (every 5 min)  — recover stale leases, dispatch due
 *                                           campaigns + journey steps, retry
 *                                           outbound webhooks, then DRAIN the
 *                                           job queue inline.
 *   /api/cron/maintenance  (hourly)       — automation trigger scan (+ pending
 *                                           execution drain) and owner report
 *                                           enqueue.
 *
 * Safety properties (all reused from the worker, not re-implemented):
 * - Every sweep is idempotent and safe to run concurrently: due campaigns are
 *   claimed with a status re-check, journey/automation deliveries are fenced
 *   by unique constraints, report schedules by a conditional cut-off update.
 * - Queue claims use the same lease fencing as the worker (`claimNextJob` →
 *   `completeJob`/`failJob`/`deadLetterJob` with the minted lease). A cron
 *   invocation that is killed mid-job (function timeout) leaves a RUNNING row
 *   whose 10-minute staleness TTL is recovered by the next invocation via
 *   `recoverStaleJobs()`; the handlers themselves are idempotent, so the retry
 *   cannot double-send.
 * - Each invocation is BOUNDED (budget + max jobs) so it fits inside a
 *   serverless function's `maxDuration`. Leftovers are picked up next tick.
 * - Auth is fail-closed: `CRON_SECRET` is required in production (503 when
 *   missing), and the comparison is constant-time. Vercel Cron sends
 *   `Authorization: Bearer <CRON_SECRET>` automatically.
 *
 * Self-hosted/Docker deployments keep using `scripts/worker.ts`; both drivers
 * can run side by side because the coordination primitives live in the DB.
 */

import { randomUUID, timingSafeEqual } from "crypto";

import { isProduction, MIN_SECRET_LENGTH } from "./config";
import { db } from "./db";
import { logger } from "./logger";
import {
  claimNextJob,
  completeJob,
  deadLetterJob,
  failJob,
  recoverStaleJobs,
  type ClaimedJob,
} from "./queue";
import { runJob } from "./jobs/handlers";
import {
  sweepAutomationTriggers,
  sweepDueCampaigns,
  sweepJourneys,
} from "./scheduler";
import { sweepOwnerReports } from "./report-sweep";
import { sweepDueWebhookDeliveries } from "./webhooks-out";

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

export const CRON_TASKS = ["sweep", "maintenance", "all"] as const;
export type CronTask = (typeof CRON_TASKS)[number];

export function isCronTask(value: string): value is CronTask {
  return (CRON_TASKS as readonly string[]).includes(value);
}

/** Env name read by the auth check and by Vercel Cron. */
export const CRON_SECRET_ENV = "CRON_SECRET";

/** Default per-invocation queue drain budget (fits a 60 s function). */
export const DEFAULT_QUEUE_BUDGET_MS = 25_000;
export const MAX_QUEUE_BUDGET_MS = 45_000;
/** Default jobs executed per invocation (the rest wait for the next tick). */
export const DEFAULT_MAX_JOBS = 20;
export const MAX_MAX_JOBS = 100;

/* ------------------------------------------------------------------ */
/* Authentication                                                      */
/* ------------------------------------------------------------------ */

export interface CronAuthResult {
  ok: boolean;
  /**
   * `secret` — a valid CRON_SECRET was presented.
   * `dev-open` — no CRON_SECRET is configured and we are NOT in production
   *              (local development / test). Never possible in production.
   */
  mode?: "secret" | "dev-open";
  status?: number;
  code?: string;
  message?: string;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false; // length is not secret-dependent here
  return timingSafeEqual(ba, bb);
}

/** Extract a presented secret from `Authorization: Bearer …` or `x-cron-secret`. */
export function presentedCronSecret(req: Request): string | null {
  const header = req.headers.get("x-cron-secret");
  if (header) return header.trim() || null;

  const authorization = req.headers.get("authorization");
  if (!authorization) return null;
  const match = /^bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1].trim() || null : null;
}

/**
 * Authorize a cron invocation.
 *
 * - `CRON_SECRET` set → the presented value must match exactly (constant time).
 * - `CRON_SECRET` missing in PRODUCTION → fail closed with 503. Unlike optional
 *   webhook secrets, an unauthenticated endpoint here could mass-send messages,
 *   so "not configured" must never mean "open".
 * - `CRON_SECRET` missing outside production → allowed (`dev-open`) so a fresh
 *   checkout can be exercised locally without extra setup.
 */
export function authorizeCron(
  req: Request,
  env: Record<string, string | undefined> = process.env,
): CronAuthResult {
  const configured = (env[CRON_SECRET_ENV] ?? "").trim();

  if (!configured) {
    if (isProduction()) {
      return {
        ok: false,
        status: 503,
        code: "CRON_SECRET_NOT_CONFIGURED",
        message:
          "Cron is disabled: CRON_SECRET is not set. Set CRON_SECRET (openssl rand -hex 32) and redeploy.",
      };
    }
    return { ok: true, mode: "dev-open" };
  }

  // A short/placeholder secret is treated as MISCONFIGURED (not merely wrong):
  // it would let a trivially guessable value unlock mass-sending endpoints.
  if (configured.length < MIN_SECRET_LENGTH) {
    return {
      ok: false,
      status: 503,
      code: "CRON_SECRET_WEAK",
      message: `Cron is disabled: CRON_SECRET must be at least ${MIN_SECRET_LENGTH} characters (openssl rand -hex 32).`,
    };
  }

  const presented = presentedCronSecret(req);
  if (!presented || !constantTimeEqual(presented, configured)) {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      message: "Invalid or missing cron credentials.",
    };
  }
  return { ok: true, mode: "secret" };
}

/* ------------------------------------------------------------------ */
/* Queue drain (the part the worker used to own)                        */
/* ------------------------------------------------------------------ */

export interface QueueDrainResult {
  workerId: string;
  claimed: number;
  completed: number;
  retried: number;
  deadLettered: number;
  leaseLost: number;
  /** Why the drain stopped — `empty` means the queue is fully drained. */
  stoppedReason: "empty" | "budget" | "max_jobs";
  durationMs: number;
}

export interface DrainQueueOptions {
  budgetMs?: number;
  maxJobs?: number;
  /** Injectable for tests. */
  workerId?: string;
  now?: () => number;
}

function positiveIntFromEnv(name: string, fallback: number, max: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

/** Execute one already-claimed job with the same retry semantics as the worker. */
async function executeClaimedJob(
  job: ClaimedJob,
): Promise<"completed" | "retried" | "dead_lettered" | "lease_lost"> {
  try {
    const outcome = await runJob({
      jobId: job.id,
      type: job.type,
      payload: job.payload,
      hotelId: job.hotelId,
      createdBy: job.createdBy,
    });

    if (outcome.ok) {
      const won = await completeJob(job.id, outcome.result ?? {}, job.leaseId);
      return won ? "completed" : "lease_lost";
    }
    if (outcome.permanent) {
      // Validation errors can never succeed on retry — dead-letter immediately.
      const won = await deadLetterJob(
        job.id,
        String(outcome.result?.error ?? "Permanent failure"),
        job.leaseId,
      );
      return won ? "dead_lettered" : "lease_lost";
    }
    const result = await failJob(
      job.id,
      String(outcome.result?.error ?? "Job failed"),
      job.leaseId,
    );
    if (result === "retried") return "retried";
    if (result === "dead_letter") return "dead_lettered";
    return "lease_lost";
  } catch (err) {
    const result = await failJob(job.id, err, job.leaseId);
    if (result === "retried") return "retried";
    if (result === "dead_letter") return "dead_lettered";
    return "lease_lost";
  }
}

/**
 * Claim and execute queued jobs until the queue is empty or the bound is hit.
 *
 * Concurrency-safe: `claimNextJob`'s status re-check means a worker and a cron
 * invocation (or two overlapping cron invocations) never own the same job.
 */
export async function drainQueue(opts: DrainQueueOptions = {}): Promise<QueueDrainResult> {
  const budgetMs =
    opts.budgetMs ?? positiveIntFromEnv("CRON_QUEUE_BUDGET_MS", DEFAULT_QUEUE_BUDGET_MS, MAX_QUEUE_BUDGET_MS);
  const maxJobs =
    opts.maxJobs ?? positiveIntFromEnv("CRON_QUEUE_MAX_JOBS", DEFAULT_MAX_JOBS, MAX_MAX_JOBS);
  const now = opts.now ?? Date.now;
  const workerId = opts.workerId ?? `cron-${randomUUID().slice(0, 8)}`;
  const startedAt = now();

  const result: QueueDrainResult = {
    workerId,
    claimed: 0,
    completed: 0,
    retried: 0,
    deadLettered: 0,
    leaseLost: 0,
    stoppedReason: "empty",
    durationMs: 0,
  };

  for (;;) {
    if (result.claimed >= maxJobs) {
      result.stoppedReason = "max_jobs";
      break;
    }
    if (now() - startedAt >= budgetMs) {
      result.stoppedReason = "budget";
      break;
    }

    const job = await claimNextJob(workerId);
    if (!job) {
      result.stoppedReason = "empty";
      break;
    }

    result.claimed += 1;
    const outcome = await executeClaimedJob(job);
    if (outcome === "completed") result.completed += 1;
    else if (outcome === "retried") result.retried += 1;
    else if (outcome === "dead_lettered") result.deadLettered += 1;
    else result.leaseLost += 1;
  }

  result.durationMs = now() - startedAt;
  if (result.claimed > 0) {
    logger.info("cron.queue_drained", {
      workerId,
      claimed: result.claimed,
      completed: result.completed,
      retried: result.retried,
      deadLettered: result.deadLettered,
      stoppedReason: result.stoppedReason,
    });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Task orchestration                                                  */
/* ------------------------------------------------------------------ */

export interface CronError {
  task: string;
  message: string;
}

export interface CronRunResult {
  ok: boolean;
  task: CronTask;
  startedAt: string;
  durationMs: number;
  stale?: { requeued: number; deadLettered: number };
  scheduler?: {
    campaignsDispatched: number;
    journeyDeliveriesSent: number;
    journeyDeliveriesSkipped: number;
    journeyDeliveriesFailed: number;
    journeyEnrollmentsCompleted: number;
  };
  automation?: { hotelsScanned: number; executionsQueued: number; executionsRun: number };
  reports?: number;
  webhooks?: number;
  queue?: QueueDrainResult;
  errors: CronError[];
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface RunCronOptions {
  budgetMs?: number;
  maxJobs?: number;
  now?: Date;
  /** Skip the inline queue drain (used by tests / diagnostics). */
  skipQueue?: boolean;
}

/**
 * Run one cron task. Individual steps are isolated: a failing sweep is
 * reported in `errors` and does not prevent the other steps (or the queue
 * drain) from running — a scheduled campaign must still go out when, say, the
 * webhook sweep hits a bad endpoint.
 */
export async function runCronTask(
  task: CronTask,
  opts: RunCronOptions = {},
): Promise<CronRunResult> {
  const now = opts.now ?? new Date();
  const startedAt = Date.now();
  const result: CronRunResult = {
    ok: true,
    task,
    startedAt: now.toISOString(),
    durationMs: 0,
    errors: [],
  };

  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      result.errors.push({ task: name, message: messageOf(err) });
      logger.error("cron.step_failed", { task: name, error: messageOf(err) });
    }
  };

  const runFast = task === "sweep" || task === "all";
  const runSlow = task === "maintenance" || task === "all";

  if (runFast) {
    // Crash recovery first: a previous invocation killed by the function
    // timeout leaves RUNNING rows behind; requeue them before claiming more.
    await step("recoverStaleJobs", async () => {
      result.stale = await recoverStaleJobs();
    });

    // Due SCHEDULED campaigns + journey step deliveries. Performed individually
    // (not via runSchedulerSweep) so the heavier automation trigger scan stays
    // on the hourly maintenance cadence instead of every 5 minutes.
    const scheduler = {
      campaignsDispatched: 0,
      journeyDeliveriesSent: 0,
      journeyDeliveriesSkipped: 0,
      journeyDeliveriesFailed: 0,
      journeyEnrollmentsCompleted: 0,
    };
    result.scheduler = scheduler;

    await step("sweepDueCampaigns", async () => {
      scheduler.campaignsDispatched = await sweepDueCampaigns(now);
    });

    await step("sweepJourneys", async () => {
      const journey = await sweepJourneys(now);
      scheduler.journeyDeliveriesSent = journey.sent;
      scheduler.journeyDeliveriesSkipped = journey.skipped;
      scheduler.journeyDeliveriesFailed = journey.failed;
      scheduler.journeyEnrollmentsCompleted = journey.completed;
    });

    // Outbound webhook retries (third-party integrations expect at-least-once).
    await step("sweepDueWebhookDeliveries", async () => {
      result.webhooks = await sweepDueWebhookDeliveries(50);
    });
  }

  if (runSlow) {
    // Automation trigger scan (birthdays, checkouts, win-back…) + drain of due
    // PENDING executions + stale PROCESSING reaper.
    await step("sweepAutomationTriggers", async () => {
      result.automation = await sweepAutomationTriggers(now);
    });

    // Owner report schedules → OWNER_REPORT jobs.
    await step("sweepOwnerReports", async () => {
      result.reports = await sweepOwnerReports(now);
    });
  }

  // Drain LAST so jobs enqueued by the sweeps above execute in this same
  // invocation instead of waiting for the next 5-minute tick.
  if (!opts.skipQueue) {
    await step("drainQueue", async () => {
      result.queue = await drainQueue({ budgetMs: opts.budgetMs, maxJobs: opts.maxJobs });
    });
  }

  result.durationMs = Date.now() - startedAt;
  result.ok = result.errors.length === 0;

  logger.info("cron.task_completed", {
    task,
    ok: result.ok,
    durationMs: result.durationMs,
    errors: result.errors.length,
    campaignsDispatched: result.scheduler?.campaignsDispatched ?? 0,
    journeyDeliveriesSent: result.scheduler?.journeyDeliveriesSent ?? 0,
    jobsCompleted: result.queue?.completed ?? 0,
  });

  return result;
}

/* ------------------------------------------------------------------ */
/* HTTP glue shared by both route handlers                             */
/* ------------------------------------------------------------------ */

/**
 * Full request handling for a cron route: auth → run → JSON.
 *
 * Returns 401 (bad/missing secret), 503 (production without CRON_SECRET),
 * 500 (one or more steps failed — so uptime monitoring and Vercel's cron
 * history surface it) and 200 otherwise.
 */
export async function handleCronRequest(req: Request, task: CronTask): Promise<Response> {
  const auth = authorizeCron(req);
  if (!auth.ok) {
    return Response.json(
      { ok: false, error: { code: auth.code, message: auth.message } },
      { status: auth.status ?? 401, headers: { "cache-control": "no-store" } },
    );
  }

  if (auth.mode === "dev-open") {
    logger.warn("cron.unauthenticated_dev_invocation", { task });
  }

  try {
    const result = await runCronTask(task);
    return Response.json(
      { auth: auth.mode, ...result },
      { status: result.ok ? 200 : 500, headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    logger.error("cron.invocation_failed", { task, error: messageOf(err) });
    return Response.json(
      {
        ok: false,
        auth: auth.mode,
        error: { code: "CRON_FAILED", message: "The cron task could not run." },
      },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

/** Diagnostics used by the health endpoint and tests (no secrets, counts only). */
export async function cronQueueDepth(): Promise<{ queued: number; running: number; failed: number }> {
  const [queued, running, failed] = await Promise.all([
    db.backgroundJob.count({ where: { status: "QUEUED" } }),
    db.backgroundJob.count({ where: { status: "RUNNING" } }),
    db.backgroundJob.count({ where: { status: "FAILED" } }),
  ]);
  return { queued, running, failed };
}
