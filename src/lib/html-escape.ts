/**
 * Shared HTML escaping — THE single implementation for the codebase.
 *
 * MERGE CONSOLIDATION (2026-10): four divergent copies previously existed
 * (src/components/app/qr-codes-view.tsx, src/lib/providers/email.ts,
 * src/lib/retention.ts, src/app/api/bills/[id]/receipt/route.ts). The
 * email.ts copy did NOT escape single quotes — a latent inconsistency in
 * any single-quoted attribute context. All four now import this function:
 * null-safe and escapes the full set & < > " '.
 *
 * This function is for interpolation into HTML TEXT and double/single-quoted
 * ATTRIBUTE contexts. It does NOT make arbitrary HTML safe, sanitize URLs,
 * or neutralize javascript: schemes — use context-appropriate validation for
 * those (see src/lib/qr.ts buildPublicUrl for scheme validation).
 */
export function escapeHtml(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
