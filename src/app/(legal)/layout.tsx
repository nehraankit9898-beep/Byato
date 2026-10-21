import { SiteShell } from "@/components/public/site-shell";

/**
 * Public marketing + legal pages (/pricing, /privacy, /terms, /refund-policy).
 * Route group only — the URLs stay flat.
 */
export default function PublicSiteLayout({ children }: { children: React.ReactNode }) {
  return <SiteShell>{children}</SiteShell>;
}
