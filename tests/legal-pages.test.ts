/**
 * Public legal + pricing pages — /privacy, /terms, /refund-policy, /pricing.
 *
 * Go-live gate 1 (docs/GO_LIVE_90_DAYS.md §2, item 8): no privacy notice, no
 * terms, no refund policy and no price list meant (a) the DPDP Act 2023
 * notice requirement was unmet and (b) payment providers refuse live KYC
 * without a reachable refund policy. These tests pin the pages AND the two
 * properties that are easy to get wrong:
 *
 *   1. PUBLIC — reachable without a session (a notice nobody can read before
 *      signing up is not a notice), and served with the nonce CSP.
 *   2. DB-DRIVEN PRICING — the price shown comes from the Plan table, so the
 *      marketing page can never advertise a price that billing does not charge.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

import { testDb } from "./helpers";

const BASE = process.env.TEST_BASE_URL || "";
const db = testDb();

const PAGES = [
  { path: "/privacy", marker: "Privacy Policy" },
  { path: "/terms", marker: "Terms of Service" },
  { path: "/refund-policy", marker: "Cancellation &amp; Refund Policy" },
  { path: "/pricing", marker: "Pricing" },
];

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store", redirect: "manual" });
  return { res, html: await res.text() };
}

const createdPlanIds: string[] = [];

afterAll(async () => {
  for (const id of createdPlanIds) {
    await db.plan.delete({ where: { id } }).catch(() => undefined);
  }
});

describe("public legal + pricing pages", () => {
  for (const page of PAGES) {
    test(`${page.path} is public, renders HTML and carries the CSP`, async () => {
      const { res, html } = await get(page.path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/html");
      // Behind the nonce-based CSP in src/proxy.ts — a page without it would
      // mean the proxy stopped covering new routes.
      expect(res.headers.get("content-security-policy") ?? "").toContain("default-src 'self'");
      expect(html).toContain(page.marker);
    });
  }

  test("privacy notice covers the DPDP data-principal rights and a grievance contact", async () => {
    const { html } = await get("/privacy");
    for (const required of [
      "Data Protection Board of India",
      "grievance",
      "withdraw consent",
      "erase",
      "retention",
      "contact",
    ]) {
      expect(html.toLowerCase()).toContain(required.toLowerCase());
    }
    // A notice without a working mailbox is not actionable.
    expect(html).toContain("mailto:");
  });

  test("terms state the governing law and link to the refund policy", async () => {
    const { html } = await get("/terms");
    expect(html).toContain("Governing law");
    expect(html).toContain("Jaipur, Rajasthan, India");
    expect(html).toContain('href="/refund-policy"');
  });

  test("refund policy covers cancellation, the refund window and processing time", async () => {
    const { html } = await get("/refund-policy");
    for (const required of ["Cancel", "refund", "7 business days", "5–10 business days", "GST"]) {
      expect(html.toLowerCase()).toContain(required.toLowerCase());
    }
  });

  test("the public footer links to pricing + every legal document", async () => {
    // /privacy is server-rendered, so this proves the footer ships in the HTML.
    const { html } = await get("/privacy");
    for (const href of [
      'href="/pricing"',
      'href="/privacy"',
      'href="/terms"',
      'href="/refund-policy"',
    ]) {
      expect(html).toContain(href);
    }
  });

  test("login and register screens link to the legal pages before signup", () => {
    // These screens are client components behind a session check, so they are
    // not in the server HTML — assert the links at the source instead of
    // pretending an HTTP check covers them.
    for (const file of [
      "src/components/app/login-screen.tsx",
      "src/components/app/register-screen.tsx",
    ]) {
      const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
      for (const href of ["/pricing", "/privacy", "/terms", "/refund-policy"]) {
        expect(source).toContain(`href="${href}"`);
      }
    }
  });
});

describe("pricing is read from the database (never hardcoded)", () => {
  test("a newly published plan appears with its own price", async () => {
    const suffix = randomUUID().slice(0, 8);
    const price = 4501; // a distinctive value that cannot match a static template
    const plan = await db.plan.create({
      data: {
        name: `TEST PLAN ${suffix}`,
        key: `test-plan-${suffix}`,
        description: "Temporary plan created by the legal/pricing regression test.",
        monthlyPrice: price,
        yearlyPrice: price * 10,
        currency: "INR",
        isActive: true,
        isPublic: true,
        isArchived: false,
        customerLimit: 1234,
        messageLimit: 4321,
      },
      select: { id: true },
    });
    createdPlanIds.push(plan.id);

    const { html } = await get("/pricing");
    const formatted = new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 0,
    }).format(price);

    expect(html).toContain(`TEST PLAN ${suffix}`);
    expect(html).toContain(formatted);
    // Plan limits come from the same row, not from copy in the template.
    expect(html).toContain("1,234");
    expect(html).toContain("4,321");
  });

  test("a private plan stays off the public page", async () => {
    const suffix = randomUUID().slice(0, 8);
    const plan = await db.plan.create({
      data: {
        name: `HIDDEN PLAN ${suffix}`,
        key: `hidden-plan-${suffix}`,
        monthlyPrice: 99999,
        currency: "INR",
        isActive: true,
        isPublic: false,
        customerLimit: 10,
      },
      select: { id: true },
    });
    createdPlanIds.push(plan.id);

    const { html } = await get("/pricing");
    expect(html).not.toContain(`HIDDEN PLAN ${suffix}`);
  });
});
