import { db } from "@/lib/db";
import { clientIp } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { logSecurityEvent } from "@/lib/saas/security";

/**
 * Login security — Phase 10.
 *
 * Authoritative, DB-backed (shared across processes/instances):
 *   - per-account+IP lockout via recent AuthAttempt rows (never a global
 *     account lock an attacker can trigger from a different network)
 *   - per-IP throttling via the AuthAttempt table
 *   - every attempt recorded (AuthAttempt + AuditLog with IP)
 *
 * The in-process sliding-window limiter is used as an additional cheap
 * damping layer, never as the sole control.
 */

const MAX_FAILURES = 5;
const IP_WINDOW_MS = 15 * 60_000;
// Volume cap: protects against enumeration bursts while staying friendly to
// shared/NAT offices where many legitimate users sign in from one IP.
// Failure-driven throttling (below) remains the primary brute-force control.
const IP_MAX_ATTEMPTS = 200;
const IP_MAX_FAILURES = 25;

export interface LockoutStatus {
  locked: boolean;
  failures: number;
  retryAfterSeconds?: number;
  lockLevel?: number;
}

/** Is this email currently locked from this IP? */
export async function getLockoutStatus(params: { email: string; ip: string }): Promise<LockoutStatus> {
  const where = {
    email: params.email.trim().toLowerCase(),
    ipAddress: params.ip === "unknown" ? null : params.ip,
    success: false,
    createdAt: { gte: new Date(Date.now() - IP_WINDOW_MS) },
  };
  const failures = await db.authAttempt.count({ where });
  if (failures < MAX_FAILURES) return { locked: false, failures };

  const oldestFailure = await db.authAttempt.findFirst({
    where,
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  if (!oldestFailure) return { locked: false, failures };

  const retryAt = oldestFailure.createdAt.getTime() + IP_WINDOW_MS;
  return {
    locked: retryAt > Date.now(),
    failures,
    retryAfterSeconds: Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)),
    lockLevel: Math.floor(failures / MAX_FAILURES),
  };
}

/** Per-IP throttling from the shared AuthAttempt table. */
export async function isIpThrottled(
  ip: string,
): Promise<{ throttled: boolean; reason?: "volume" | "failures" }> {
  const unknownIp = ip === "unknown";
  const ipAddress = unknownIp ? null : ip;
  const maxAttempts = unknownIp ? 10 : IP_MAX_ATTEMPTS;
  const maxFailures = unknownIp ? 5 : IP_MAX_FAILURES;
  const since = new Date(Date.now() - IP_WINDOW_MS);
  const [total, failures] = await Promise.all([
    db.authAttempt.count({ where: { ipAddress, createdAt: { gte: since } } }),
    db.authAttempt.count({ where: { ipAddress, success: false, createdAt: { gte: since } } }),
  ]);
  if (failures >= maxFailures) return { throttled: true, reason: "failures" };
  if (total >= maxAttempts) return { throttled: true, reason: "volume" };
  return { throttled: false };
}

export interface FailureRecordResult {
  justLocked: boolean;
  lockedForSeconds?: number;
}

/** Record a failed login (known or unknown); lockout is scoped to email + IP. */
export async function recordFailedLogin(params: {
  userId?: string | null;
  email: string;
  ip: string;
  hotelId?: string | null;
}): Promise<FailureRecordResult> {
  // Security events and attempts are recorded for both known and unknown
  // emails, keeping their failure paths the same shape and maintaining the
  // shared per-IP throttle.
  await logSecurityEvent({
    type: "FAILED_LOGIN",
    severity: "WARNING",
    userId: params.userId ?? null,
    email: params.email,
    hotelId: params.hotelId ?? null,
    ipAddress: params.ip,
    details: { email: params.email },
  });
  await recordAuthAttempt({ email: params.email, success: false, ip: params.ip });

  const lockout = await getLockoutStatus({ email: params.email, ip: params.ip });
  const justLocked = lockout.locked && lockout.failures === MAX_FAILURES;
  const lockedForSeconds = lockout.locked ? lockout.retryAfterSeconds : undefined;

  await logAudit({
    hotelId: params.hotelId ?? null,
    userId: params.userId ?? null,
    action: "LOGIN_FAILED",
    entityType: params.userId ? "user" : undefined,
    entityId: params.userId ?? undefined,
    metadata: {
      failures: lockout.failures,
      locked: lockout.locked,
      lockMinutes: lockedForSeconds ? Math.ceil(lockedForSeconds / 60) : null,
    },
    ipAddress: params.ip,
  });

  if (justLocked) {
    await logSecurityEvent({
      type: "LOCKOUT",
      severity: "CRITICAL",
      userId: params.userId ?? null,
      email: params.email,
      hotelId: params.hotelId ?? null,
      ipAddress: params.ip,
      details: { failures: lockout.failures, lockedForSeconds },
    });
  }

  return { justLocked, lockedForSeconds };
}

/** Record a successful login: clear counters, stamp lastLogin*. */
export async function recordSuccessfulLogin(params: {
  userId: string;
  email: string;
  ip: string;
  hotelId?: string | null;
}): Promise<void> {
  await db.user.update({
    where: { id: params.userId },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      lastLoginIp: params.ip,
    },
  });
  await recordAuthAttempt({ email: params.email, success: true, ip: params.ip });
}

/**
 * Persist one attempt for the shared per-IP throttle. Used for BOTH known and
 * unknown accounts: previously unknown-email failures were never counted, so
 * an attacker could probe arbitrary addresses without touching the IP limit.
 */
export async function recordAuthAttempt(params: {
  email: string;
  success: boolean;
  ip: string;
}): Promise<void> {
  await db.authAttempt.create({
    data: {
      email: params.email.toLowerCase(),
      success: params.success,
      ipAddress: params.ip === "unknown" ? null : params.ip,
    },
  });
}

/**
 * Housekeeping: AuthAttempt rows older than the throttle window are never read
 * again. Deleting them keeps the table (and the per-login IP count) small.
 */
export async function purgeOldAuthAttempts(olderThanMs = 7 * 24 * 60 * 60_000): Promise<number> {
  const res = await db.authAttempt.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - olderThanMs) } },
  });
  return res.count;
}

/** Shared request-context helper. */
export function requestIp(req: Request): string {
  return clientIp(req);
}

export const LOGIN_LIMITS = { MAX_FAILURES, IP_MAX_ATTEMPTS, IP_MAX_FAILURES, IP_WINDOW_MS };
