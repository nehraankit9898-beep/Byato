import Link from "next/link";
import type { ReactNode } from "react";

import { LEGAL_DOCUMENTS, PRODUCT_NAME, legalContactEmail } from "@/lib/legal";

/**
 * Public site shell for the marketing/legal pages (/pricing, /privacy,
 * /terms, /refund-policy).
 *
 * Server component — no client JavaScript, no session, no data access. The
 * pages are fully public so a prospective customer can read the terms and the
 * price list BEFORE creating an account (and so the payment provider has a
 * reachable refund policy), which is also what India's DPDP Act 2023 expects
 * from a privacy notice.
 */

const navItems = [
  { href: "/pricing", label: "Pricing" },
  ...LEGAL_DOCUMENTS.map((doc) => ({ href: doc.path, label: doc.title })),
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-[color:var(--border)]/70 bg-[color:var(--background)]/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-6">
        <Link href="/" className="flex items-baseline gap-2.5" aria-label={`${PRODUCT_NAME} home`}>
          <span className="font-serif text-[20px] font-semibold uppercase tracking-[0.26em] text-[color:var(--ink)]">
            {PRODUCT_NAME}
          </span>
          <span className="hidden text-[10px] uppercase tracking-[0.2em] text-[color:var(--gold-ink)] sm:inline">
            Guest retention
          </span>
        </Link>

        <nav aria-label="Public pages" className="hidden items-center gap-7 md:flex">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-[12.5px] tracking-[0.02em] text-[color:var(--muted-foreground)] transition-colors hover:text-[color:var(--ink)]"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <Link
          href="/"
          className="rounded-[3px] border border-[color:var(--gold)]/50 px-4 py-2 text-[11px] font-medium uppercase tracking-[0.16em] text-[color:var(--gold-ink)] transition-colors hover:bg-[color:var(--gold)]/10"
        >
          Sign in
        </Link>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="mt-24 border-t border-[color:var(--border)]/70 bg-[color:var(--porcelain)]/60">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-3">
          <p className="font-serif text-[18px] font-semibold uppercase tracking-[0.24em] text-[color:var(--ink)]">
            {PRODUCT_NAME}
          </p>
          <p className="max-w-[26ch] text-[12.5px] leading-relaxed text-[color:var(--muted-foreground)]">
            Customer retention for independent hotels and restaurants — visits, consent, loyalty and
            win-back in one quiet dashboard.
          </p>
        </div>

        <div className="space-y-2.5">
          <p className="lux-eyebrow">Product</p>
          <Link href="/pricing" className="block text-[12.5px] text-[color:var(--muted-foreground)] hover:text-[color:var(--ink)]">
            Pricing
          </Link>
          <Link href="/" className="block text-[12.5px] text-[color:var(--muted-foreground)] hover:text-[color:var(--ink)]">
            Sign in / Create account
          </Link>
        </div>

        <div className="space-y-2.5">
          <p className="lux-eyebrow">Legal</p>
          {LEGAL_DOCUMENTS.map((doc) => (
            <Link
              key={doc.path}
              href={doc.path}
              className="block text-[12.5px] text-[color:var(--muted-foreground)] hover:text-[color:var(--ink)]"
            >
              {doc.title}
            </Link>
          ))}
        </div>

        <div className="space-y-2.5">
          <p className="lux-eyebrow">Contact</p>
          <a
            href={`mailto:${legalContactEmail()}`}
            className="block break-all text-[12.5px] text-[color:var(--muted-foreground)] hover:text-[color:var(--ink)]"
          >
            {legalContactEmail()}
          </a>
          <p className="text-[12.5px] text-[color:var(--muted-foreground)]">Jaipur, Rajasthan, India</p>
        </div>
      </div>

      <div className="border-t border-[color:var(--border)]/60">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-5 text-[11px] uppercase tracking-[0.16em] text-[color:var(--muted-foreground)] sm:flex-row sm:items-center sm:justify-between">
          <span>
            © {year} {PRODUCT_NAME}
          </span>
          <span>Made for Indian hospitality</span>
        </div>
      </div>
    </footer>
  );
}

export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-[color:var(--background)]">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}

/**
 * Shared document layout for legal pages: eyebrow, serif title, summary, the
 * "last updated" line, then prose. Child headings are styled centrally so
 * every policy reads the same without a typography plugin.
 */
export function LegalArticle({
  eyebrow,
  title,
  summary,
  lastUpdated,
  children,
}: {
  eyebrow: string;
  title: string;
  summary: string;
  lastUpdated: string;
  children: ReactNode;
}) {
  return (
    <article className="mx-auto max-w-3xl px-6 pt-16 pb-4">
      <p className="lux-eyebrow">{eyebrow}</p>
      <h1 className="lux-display mt-4 text-[38px] text-[color:var(--ink)] sm:text-[46px]">{title}</h1>
      <p className="mt-5 text-[14.5px] leading-[1.8] text-[color:var(--muted-foreground)]">{summary}</p>
      <p className="mt-4 text-[11px] uppercase tracking-[0.18em] text-[color:var(--gold-ink)]">
        Last updated · {lastUpdated}
      </p>
      <hr className="lux-rule my-10" />
      <div
        className="space-y-5 text-[13.5px] leading-[1.85] text-[color:var(--ink)]/85
          [&_h2]:mt-10 [&_h2]:font-serif [&_h2]:text-[24px] [&_h2]:font-medium [&_h2]:tracking-[-0.01em] [&_h2]:text-[color:var(--ink)]
          [&_h3]:mt-7 [&_h3]:text-[11px] [&_h3]:font-semibold [&_h3]:uppercase [&_h3]:tracking-[0.16em] [&_h3]:text-[color:var(--gold-ink)]
          [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-5
          [&_a]:text-[color:var(--gold-ink)] [&_a]:underline [&_a]:decoration-[color:var(--gold)]/40 [&_a]:underline-offset-4
          [&_strong]:font-semibold [&_strong]:text-[color:var(--ink)]"
      >
        {children}
      </div>
    </article>
  );
}
