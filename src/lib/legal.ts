/**
 * Public legal/marketing surface — shared, server-side values.
 *
 * The operator MUST confirm the contact mailbox and the legal entity name
 * before launch (`LEGAL_CONTACT_EMAIL`); nothing here is a secret and nothing
 * is rendered into JSON APIs.
 */

/** Product/brand name used on the public pages. */
export const PRODUCT_NAME = "Beyto";

/** Shown on legal documents; bump when the text materially changes. */
export const LEGAL_LAST_UPDATED = "21 October 2026";

/**
 * Monitored contact mailbox for privacy requests, grievances and billing
 * questions. Configurable because the platform operator (not the code) owns
 * the domain: set LEGAL_CONTACT_EMAIL in the deployment environment.
 */
export function legalContactEmail(): string {
  const configured = (process.env.LEGAL_CONTACT_EMAIL ?? "").trim();
  return configured || "support@beyto.in";
}

/** Governing-law jurisdiction for the terms (India). */
export const LEGAL_JURISDICTION = "Jaipur, Rajasthan, India";

export interface LegalDocumentMeta {
  slug: string;
  path: string;
  title: string;
  summary: string;
}

/** Used by the shell navigation and by the pages themselves. */
export const LEGAL_DOCUMENTS: LegalDocumentMeta[] = [
  {
    slug: "privacy",
    path: "/privacy",
    title: "Privacy Policy",
    summary: "What we collect, why, how long we keep it, and the rights you can exercise.",
  },
  {
    slug: "terms",
    path: "/terms",
    title: "Terms of Service",
    summary: "The agreement between your restaurant and Beyto when you use the platform.",
  },
  {
    slug: "refund-policy",
    path: "/refund-policy",
    title: "Cancellation & Refund Policy",
    summary: "How billing, cancellation, renewal and refunds work for paid plans.",
  },
];
