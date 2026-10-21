/**
 * GET /api/cron/sweep — fast automation tick (Vercel Cron: every 5 minutes).
 *
 * Without this route, a Vercel deployment (the primary production target) has
 * no worker process, so due campaigns, journey steps, webhook retries and the
 * DB job queue never move. See `src/lib/cron.ts` for the full rationale.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` (sent automatically by Vercel
 * Cron when CRON_SECRET is configured) or `x-cron-secret: <CRON_SECRET>`.
 * Missing CRON_SECRET in production fails closed with 503.
 *
 * Schedule lives in `vercel.json`; self-hosted deployments can use
 * `scripts/worker.ts` instead (both are safe to run together).
 */
import { handleCronRequest } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  return handleCronRequest(req, "sweep");
}

export async function POST(req: Request): Promise<Response> {
  return handleCronRequest(req, "sweep");
}
