/**
 * GET /api/cron/maintenance — hourly automation tick (Vercel Cron).
 *
 * Runs the heavier, day-granularity work that must not block the 5-minute
 * tick: the automation trigger scan (birthdays / checkouts / win-back) with
 * its due-execution drain and stale-PROCESSING reaper, plus owner report
 * schedule enqueue. Then it drains the job queue inline so the enqueued
 * OWNER_REPORT jobs actually run without a worker.
 *
 * Auth: same CRON_SECRET contract as `/api/cron/sweep`.
 */
import { handleCronRequest } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  return handleCronRequest(req, "maintenance");
}

export async function POST(req: Request): Promise<Response> {
  return handleCronRequest(req, "maintenance");
}
