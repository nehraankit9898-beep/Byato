import { readBodyCapped, MAX_JSON_BODY_BYTES } from "@/lib/body";
import { createHmac, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { jsonError } from "@/lib/api-helpers";
import { recordGatewayCapture } from "@/lib/billing";
import { logAudit } from "@/lib/audit";
import { settlePaymentLinkForIntent } from "@/lib/payment-link-settle";

/**
 * Phase 14 — Razorpay webhook for RESTAURANT bill payments (provider-native).
 * SEPARATE from the SaaS subscription webhook (/api/webhooks/billing).
 *
 * Security model (documented, provider-accurate):
 *  - Resolve the provider order to our persisted BillPayment first. The tenant
 *    id and tenant webhook secret always come from our database, never notes.
 *  - Verify `x-razorpay-signature` = HMAC-SHA256(rawBody, webhookSecret), using
 *    the connected tenant's webhook_secret or the platform webhook secret.
 *  - Duplicate event ids are recorded and answered 200 without re-allocating
 *    (RestaurantWebhookEvent unique fence) — replay protection.
 *  - Amount/currency binding: only `payment.captured` events for our own
 *    order ids allocate money, and only after both values match the intent.
 */

type RazorpayEntity = {
  id?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
};

type RazorpayPayload = {
  event?: string;
  payload?: { payment?: { entity?: RazorpayEntity } };
};

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "P2002";
}

function hasValidSignature(raw: string, signature: string, secrets: string[]): boolean {
  return secrets.some((secret) => {
    const expected = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"));
    const provided = Buffer.from(signature);
    if (expected.length !== provided.length || provided.length === 0) return false;
    return timingSafeEqual(expected, provided);
  });
}

export async function POST(req: Request) {
  const raw = await readBodyCapped(req, MAX_JSON_BODY_BYTES);
  if (raw === null) return Response.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large." } }, { status: 413 });
  const signature = req.headers.get("x-razorpay-signature") ?? "";

  let payload: RazorpayPayload;
  try {
    payload = JSON.parse(raw) as RazorpayPayload;
  } catch {
    return jsonError("Invalid JSON payload.", 400, "BAD_REQUEST");
  }

  const entity = payload.payload?.payment?.entity;
  const gatewayOrderId = typeof entity?.order_id === "string" ? entity.order_id : "";
  const gatewayPaymentId = typeof entity?.id === "string" ? entity.id : "";
  if (!entity || !gatewayOrderId || !gatewayPaymentId || !payload.event) {
    return jsonError("Unrecognized webhook payload.", 400, "BAD_REQUEST");
  }

  // The provider order is the only untrusted value used to resolve a tenant.
  // Do not use entity.notes.hotelId (or any other payload tenant binding).
  const resolvedIntent = await db.billPayment.findFirst({
    where: { gatewayOrderId, gateway: "RAZORPAY" },
    select: { id: true, hotelId: true },
  });

  // Unknown orders cannot be associated with a tenant secret. The platform
  // secret can authenticate and safely ignore them, but they never allocate.
  if (!resolvedIntent) {
    const platformSecret = process.env.RAZORPAY_RESTAURANT_WEBHOOK_SECRET;
    if (!platformSecret || !hasValidSignature(raw, signature, [platformSecret])) {
      return jsonError("Signature verification failed.", 401, "SIGNATURE_INVALID");
    }
    return Response.json({ ok: true, ignored: "unknown order intent" });
  }

  const hotelId = resolvedIntent.hotelId;
  const integration = await db.integration.findFirst({
    where: { hotelId, type: "RAZORPAY", enabled: true, status: "CONNECTED" },
    select: { credentials: true },
  });
  if (!integration) {
    return jsonError("Razorpay integration is not connected.", 503, "WEBHOOK_NOT_CONFIGURED");
  }

  const secretCandidates: string[] = [];
  const platformSecret = process.env.RAZORPAY_RESTAURANT_WEBHOOK_SECRET;
  if (platformSecret) secretCandidates.push(platformSecret);
  if (integration.credentials) {
    try {
      const { decryptCredentials } = await import("@/lib/crypto");
      const decrypted = decryptCredentials({ hotelId, integrationType: "RAZORPAY" }, integration.credentials) as Record<string, unknown>;
      const tenantSecret = decrypted.webhook_secret ?? decrypted.webhookSecret;
      if (typeof tenantSecret === "string" && tenantSecret) secretCandidates.push(tenantSecret);
    } catch {
      /* A decryption failure falls through to the platform secret, if set. */
    }
  }

  if (secretCandidates.length === 0) {
    return jsonError("Webhook secret not configured; cannot verify.", 503, "WEBHOOK_NOT_CONFIGURED");
  }
  if (!hasValidSignature(raw, signature, secretCandidates)) {
    return jsonError("Signature verification failed.", 401, "SIGNATURE_INVALID");
  }

  // Re-read the complete intent with the database-resolved tenant bound into
  // the predicate. This also closes the gap if the order mapping changes while
  // the signature is being checked.
  const intent = await db.billPayment.findFirst({
    where: { id: resolvedIntent.id, hotelId, gatewayOrderId, gateway: "RAZORPAY" },
  });
  if (!intent) {
    return Response.json({ ok: true, ignored: "unknown order intent" });
  }

  // Namespace the local dedupe key by tenant so identical provider identifiers
  // from separate merchant accounts cannot suppress one another.
  const eventId = `${hotelId}:${gatewayPaymentId}:${payload.event}:${gatewayOrderId}`;
  try {
    await db.restaurantWebhookEvent.create({
      data: {
        hotelId,
        provider: "RAZORPAY",
        eventId,
        type: payload.event,
        payload: raw.slice(0, 8000),
        status: "PROCESSED",
      },
    });
  } catch (err) {
    // Only a UNIQUE violation means "replay". Other DB failures must surface so
    // Razorpay retries rather than silently dropping a captured payment.
    if (isUniqueViolation(err)) {
      return Response.json({ ok: true, duplicate: true });
    }
    throw err;
  }

  if (payload.event !== "payment.captured") {
    return Response.json({ ok: true, ignored: payload.event });
  }

  const releaseDedupeFence = () =>
    db.restaurantWebhookEvent.deleteMany({ where: { hotelId, provider: "RAZORPAY", eventId } });
  if (intent.amountMinor !== entity.amount) {
    // A mismatched delivery must not block a later corrected delivery.
    await releaseDedupeFence();
    return jsonError("Webhook amount does not match the intent.", 422, "AMOUNT_MISMATCH");
  }
  if (typeof entity.currency !== "string" || entity.currency.toUpperCase() !== intent.currency.toUpperCase()) {
    await releaseDedupeFence();
    return jsonError("Webhook currency does not match the intent.", 422, "CURRENCY_MISMATCH");
  }

  // Release the dedupe fence on transient allocation errors so Razorpay can
  // retry. recordGatewayCapture also binds its intent and bill reads to hotelId.
  let result: Awaited<ReturnType<typeof recordGatewayCapture>>;
  try {
    result = await recordGatewayCapture({
      hotelId,
      intentPaymentId: intent.id,
      gatewayOrderId,
      gatewayPaymentId,
      expectedAmountMinor: intent.amountMinor,
    });
  } catch (err) {
    await releaseDedupeFence();
    throw err;
  }
  if (!result.ok) {
    await releaseDedupeFence();
    await logAudit({
      hotelId,
      action: "RESTAURANT_WEBHOOK_ALLOCATION_FAILED",
      entityType: "BillPayment",
      entityId: intent.id,
      metadata: { eventId, reason: result.reason ?? "Capture rejected.", gatewayOrderId, gatewayPaymentId },
    });
    return jsonError(result.reason ?? "Capture rejected.", 422, "CAPTURE_REJECTED");
  }

  // PAY-001 follow-up: settle the payment link that created this intent, so it
  // does not stay ACTIVE when the customer never returns to the page. The
  // allocation above is idempotent, so on failure we release the dedupe fence
  // and answer 503 — Razorpay re-delivers and only the link update is retried.
  const linkSettled = await settlePaymentLinkForIntent(intent);
  if (!linkSettled) {
    await releaseDedupeFence();
    return jsonError("Payment allocated; payment link settlement failed, please retry.", 503, "LINK_SETTLE_PENDING");
  }
  return Response.json({ ok: true });
}
