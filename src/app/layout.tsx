import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { headers } from "next/headers";
import { Toaster } from "@/components/ui/toaster";
import { CspNonceProvider } from "@/components/app/csp-nonce";

// Licensed under the SIL Open Font License (see fonts/LICENSE.txt). Local
// assets avoid a build-time dependency on Google's font service.
const geistSans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
});

const geistMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
});

/**
 * LUXURY TYPE SYSTEM — Cormorant Garamond (SIL OFL) for editorial headings,
 * paired with Geist for all functional UI text. Self-hosted so the build has
 * no dependency on Google Fonts (same reason as the Geist files above).
 */
const cormorant = localFont({
  src: [
    { path: "./fonts/cormorant-garamond-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/cormorant-garamond-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/cormorant-garamond-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-cormorant",
  display: "swap",
  fallback: ["Cormorant Garamond", "Georgia", "Times New Roman", "serif"],
});

export const metadata: Metadata = {
  title: "Beyto — Restaurant CRM, Loyalty & QR Ordering",
  description:
    "Turn first-time diners into regulars. Manage customer visits, consent-based campaigns, loyalty, and restaurant operations in one dashboard.",
  keywords: ["hotel", "customer retention", "loyalty", "visits", "hospitality"],
  icons: {
    // DEPLOY FIX (Netlify 404 on /favicon.ico): the icon must be served from
    // our own origin. The previous value pointed at a third-party CDN logo
    // (z-cdn.chatglm.cn) and public/ had no favicon file at all, so browsers
    // requesting /favicon.ico got a 404. public/favicon.ico now ships with
    // the app; metadata.icons also emits a <link rel="icon"> in every page.
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#171310",
};

/**
 * SECURITY FIX (CSP nonce): the nonce is generated per request in src/proxy.ts.
 * Statically prerendered HTML cannot carry it, so every page must render per
 * request — reading headers() below opts the whole tree into dynamic rendering.
 */
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${cormorant.variable} antialiased bg-background text-foreground`}
      >
        <CspNonceProvider nonce={nonce}>
          {children}
          <Toaster />
        </CspNonceProvider>
      </body>
    </html>
  );
}
