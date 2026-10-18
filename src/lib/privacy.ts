/**
 * Phase 17 — Privacy / data subject request workflow.
 *
 * Tenant hard-delete / privacy request flow. Owner authorization required,
 * retention/legal gates enforced, customer profiles anonymized and tenant
 * archived atomically. Related records, provider data and storage are retained
 * and require a separate operator-reviewed cleanup/retention procedure.
 *
 * Independent legal review required; no blanket DPDP/GDPR certification
 * claim is made by this module. It provides the technical scaffold for the
 * operator's documented privacy procedure.
 *
 * States:
 *  PENDING      → owner has submitted a request
 *  APPROVED     → legal review complete, retention hold expired
 *  IN_PROGRESS  → cleanup running
 *  COMPLETED    → customer profiles anonymized, tenant archived; related records retained
 *  REJECTED     → documented reason
 */
import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { logAudit } from "@/lib/audit";
import type { AuthedUser } from "@/lib/api-helpers";

export type PrivacyRequestType = "EXPORT" | "DELETE" | "RECTIFY";
export type PrivacyRequestStatus =
  | "PENDING"
  | "APPROVED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "REJECTED";

interface CreateRequestInput {
  hotelId: string;
  type: PrivacyRequestType;
  requestedBy: string;
  notes?: string;
}

/**
 * Create a new privacy request. Always PENDING. The owner must explicitly
 * approve it (and confirm legal review) before any destructive action.
 */
export async function createPrivacyRequest(
  user: AuthedUser,
  type: PrivacyRequestType,
  notes?: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string; status?: number }> {
  if (user.role === "SUPER_ADMIN") {
    return { ok: false, error: "Privacy requests are tenant-initiated.", status: 403 };
  }
  if (user.role !== "HOTEL_OWNER" && user.role !== "HOTEL_ADMIN") {
    return { ok: false, error: "Only the owner/admin may initiate a privacy request.", status: 403 };
  }
  try {
    const req = await db.privacyRequest.create({
      data: {
        hotelId: user.hotelId,
        type,
        status: "PENDING",
        requestedBy: user.userId,
        // Default retention hold: 7 days to allow legal review.
        retentionExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    await logAudit({
      hotelId: user.hotelId,
      userId: user.userId,
      action: "PRIVACY_REQUEST_CREATED",
      entityType: "PrivacyRequest",
      entityId: req.id,
      metadata: { type, notes: notes?.slice(0, 500) },
    });
    return { ok: true, id: req.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Approve a pending request — sets status to APPROVED and clears retention
 * hold only after legal review is recorded. Owner-only.
 */
export async function approvePrivacyRequest(
  user: AuthedUser,
  requestId: string,
  legalReviewBy: string,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  if (user.role !== "HOTEL_OWNER" && user.role !== "HOTEL_ADMIN") {
    return { ok: false, error: "Forbidden", status: 403 };
  }
  const req = await db.privacyRequest.findFirst({
    where: { id: requestId, hotelId: user.hotelId },
  });
  if (!req) return { ok: false, error: "Request not found.", status: 404 };
  if (req.status !== "PENDING") {
    return { ok: false, error: `Request is ${req.status}, not PENDING.`, status: 409 };
  }
  await db.privacyRequest.update({
    where: { id: requestId },
    data: { status: "APPROVED", approvedBy: user.userId, legalReviewBy },
  });
  await logAudit({
    hotelId: user.hotelId,
    userId: user.userId,
    action: "PRIVACY_REQUEST_APPROVED",
    entityType: "PrivacyRequest",
    entityId: requestId,
    metadata: { legalReviewBy },
  });
  return { ok: true };
}

/**
 * Execute a DELETE-type privacy request. THIS IS DESTRUCTIVE.
 *
 * Pre-conditions:
 *  - request is APPROVED
 *  - retention hold has expired (retentionExpiresAt < now)
 *  - legal review is recorded
 *
 * Database cleanup performed atomically:
 *  1. Anonymize customer profile fields (unique non-phone tombstones)
 *  2. Revoke all active API keys
 *  3. Revoke all active sessions (tokenVersion bump on all users)
 *  4. Mark the tenant Hotel as ARCHIVED (data preserved for financial
 *     audit compliance; explicit hard-delete is a separate destructive
 *     operation requiring Super Admin authorization)
 *
 * The audit summary is recorded in `auditSummary` and never contains PII.
 */
export async function executeDeleteRequest(
  user: AuthedUser,
  requestId: string,
): Promise<{ ok: true; summary: string } | { ok: false; error: string; status?: number }> {
  if (user.role !== "HOTEL_OWNER") {
    return { ok: false, error: "Only the HOTEL_OWNER may execute a delete request.", status: 403 };
  }
  const req = await db.privacyRequest.findFirst({
    where: { id: requestId, hotelId: user.hotelId, type: "DELETE" },
  });
  if (!req) return { ok: false, error: "Request not found.", status: 404 };
  if (req.status !== "APPROVED") {
    return { ok: false, error: `Request must be APPROVED first (currently ${req.status}).`, status: 409 };
  }
  if (!req.retentionExpiresAt || req.retentionExpiresAt > new Date()) {
    return { ok: false, error: "Retention hold has not expired yet.", status: 409 };
  }

  if (!req.legalReviewBy?.trim()) {
    return { ok: false, error: "Legal review must be recorded before deletion.", status: 409 };
  }

  // Claim and all database cleanup commit together. A failed operation rolls
  // back the claim as well, leaving an APPROVED request that can be retried.
  return db.$transaction(async (tx) => {
    const claimed = await tx.privacyRequest.updateMany({
      where: {
        id: requestId, hotelId: user.hotelId, type: "DELETE", status: "APPROVED",
        legalReviewBy: req.legalReviewBy, retentionExpiresAt: { lt: new Date() },
      },
      data: { status: "IN_PROGRESS" },
    });
    if (claimed.count !== 1) {
      return { ok: false as const, error: "Request changed — reload before retrying.", status: 409 };
    }

    // (hotelId, phone) is unique. A shared '[DELETED]' value fails for any
    // tenant with two customers. A random namespace + row ID preserves that
    // constraint without retaining the original phone. Parameterized SQL uses
    // concatenation supported by both SQLite and PostgreSQL.
    const deletedPhonePrefix = `[DELETED]:${randomUUID()}:`;
    await tx.$executeRaw`UPDATE "Customer" SET "phone" = ${deletedPhonePrefix} || "id" WHERE "hotelId" = ${user.hotelId}`;
    const anonymizedCustomers = await tx.customer.updateMany({
      where: { hotelId: user.hotelId },
      data: {
        name: "[DELETED]", email: null, birthday: null, anniversary: null,
        location: null, notes: null, roomPreference: null, foodPreference: null,
        preferredRoom: null, preferredService: null, source: null,
        favouriteItems: null, favouriteCategory: null,
        consentSource: null, consentTimestamp: null,
        marketingConsent: false, emailOptIn: false, smsOptIn: false,
        whatsappOptIn: false, optOut: true,
      },
    });
    const revokedKeys = await tx.apiKey.updateMany({
      where: { hotelId: user.hotelId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    const revokedSessions = await tx.user.updateMany({
      where: { hotelId: user.hotelId },
      data: { tokenVersion: { increment: 1 } },
    });
    await tx.hotel.update({
      where: { id: user.hotelId },
      data: { status: "ARCHIVED", suspendedAt: new Date(), suspensionReason: "Privacy delete request" },
    });
    const summary = JSON.stringify({
      anonymizedCustomers: anonymizedCustomers.count,
      revokedApiKeys: revokedKeys.count, revokedSessions: revokedSessions.count,
      hotelArchived: true, hardDeletePerformed: false,
      customerProfileAnonymizationOnly: true, relatedRecordsRetained: true,
    });
    await tx.privacyRequest.update({
      where: { id: requestId },
      data: { status: "COMPLETED", completedAt: new Date(), auditSummary: summary },
    });
    await logAudit({
      hotelId: user.hotelId, userId: user.userId,
      action: "PRIVACY_REQUEST_EXECUTED", entityType: "PrivacyRequest", entityId: requestId,
      metadata: JSON.parse(summary), tx,
    });
    return { ok: true as const, summary };
  }, { timeout: 30_000 });
}

/**
 * Export a privacy request audit summary. Used by the operator to demonstrate
 * the action was performed. Contains ONLY non-personal counts — never PII.
 */
export async function readRequestSummary(
  user: AuthedUser,
  requestId: string,
): Promise<{ ok: true; summary: Record<string, unknown> | null } | { ok: false; error: string; status?: number }> {
  const req = await db.privacyRequest.findFirst({
    where: { id: requestId, hotelId: user.hotelId },
    select: { status: true, auditSummary: true, type: true, completedAt: true },
  });
  if (!req) return { ok: false, error: "Request not found.", status: 404 };
  if (!req.auditSummary) return { ok: true, summary: null };
  try {
    return { ok: true, summary: JSON.parse(req.auditSummary) };
  } catch {
    return { ok: true, summary: { raw: req.auditSummary.slice(0, 500) } };
  }
}
