import { readJsonCapped } from "@/lib/body";
import { jsonError, serverError } from "@/lib/api-helpers";
import { resolvePublicMenu } from "@/lib/menu";
import { checkRateLimit } from "@/lib/rate-limit";
import { requestIp } from "@/lib/login-security";
import { loadVoiceCatalog, parseVoiceTranscript } from "@/lib/ai/voice";
import { logAIInteraction } from "@/lib/ai/governance";
import { db } from "@/lib/db";

/**
 * Phase 18 — PUBLIC voice-cart parsing for the QR menu (capability = the QR
 * code, same trust level as browsing the menu itself).
 *
 * POST /api/public/menu/[code]/voice { transcript }
 *
 * Guarantees:
 *  - Rate-limited per QR code (20/min) with a 10x per-IP abuse backstop.
 *  - Only works when the tenant explicitly enabled voice AND the QR is valid.
 *  - Returns a cart PROPOSAL only — submission still requires the standard
 *    session flow with explicit user confirmation. Voice can never place an
 *    order or touch a payment by itself.
 *  - The transcript is processed in-memory; nothing is stored (no audio, no
 *    text, no customer identity — the QR code is anonymous).
 */
export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await ctx.params;

    const codeBucket = /^[A-Za-z0-9_-]{16,64}$/.test(code) ? code : "invalid";
    const [codeBurst, ipBackstop] = await Promise.all([
      checkRateLimit(`public-voice:code:${codeBucket}`, 20, 60 * 1000),
      checkRateLimit(`public-voice:ip:${requestIp(req)}`, 200, 60 * 1000),
    ]);
    if (!codeBurst.allowed || !ipBackstop.allowed) {
      return jsonError("Too many requests. Please wait a moment.", 429, "RATE_LIMITED");
    }

    const menu = await resolvePublicMenu(code);
    if (!menu.ok) return jsonError("Menu unavailable.", 404, "MENU_UNAVAILABLE");

    const settings = await db.aISettings.findUnique({ where: { hotelId: menu.restaurant.id } }).catch(() => null);
    if (!settings?.voiceEnabled) {
      return jsonError("Voice ordering is not available here.", 403, "VOICE_DISABLED");
    }

    let body: { transcript?: unknown };
    try {
      const parsedBody = await readJsonCapped(req);
      if (!parsedBody) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");
      body = parsedBody;
    } catch {
      return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");
    }
    const transcript = typeof body.transcript === "string" ? body.transcript : "";
    if (!transcript.trim()) return jsonError("transcript is required.", 422, "MISSING_TRANSCRIPT");
    if (transcript.length > 500) return jsonError("transcript too long (max 500 chars).", 422, "TRANSCRIPT_TOO_LONG");

    const catalog = await loadVoiceCatalog(menu.restaurant.id);
    const result = parseVoiceTranscript(transcript, catalog);

    await logAIInteraction({
      hotelId: menu.restaurant.id, kind: "VOICE", subtype: "PUBLIC_PARSE",
      status: result.lines.length ? "OK" : "REFUSED",
      reason: result.lines.length ? null : "NO_ITEMS_RECOGNIZED",
      channel: "VOICE",
      meta: { recognized: result.lines.length, unrecognized: result.unrecognized.length },
    });

    return Response.json({ ...result });
  } catch (err) {
    return serverError(err, "Voice parsing failed.");
  }
}
