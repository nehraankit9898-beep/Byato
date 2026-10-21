import type { Metadata } from "next";
import Link from "next/link";

import { listPublicPlans, type PublicPlan } from "@/lib/saas/plans";
import { PRODUCT_NAME, legalContactEmail } from "@/lib/legal";

export const metadata: Metadata = {
  title: `Pricing — ${PRODUCT_NAME}`,
  description:
    "Simple per-outlet pricing for Beyto: guest CRM, consent-based WhatsApp/SMS/email campaigns, loyalty and win-back reporting.",
};

/**
 * Public pricing page.
 *
 * IMPORTANT: prices come from the database (`listPublicPlans()`), never from a
 * hardcoded array — the Super Admin console is the single source of truth and
 * this page must never advertise a price different from what billing charges.
 * If no public plan exists yet, the page says so instead of inventing one.
 *
 * Rendered per request (the root layout already opts into dynamic rendering via
 * headers()), so a price edit in the console shows up on the next load.
 */

function inr(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: currency || "INR",
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `₹${Math.round(amount).toLocaleString("en-IN")}`;
  }
}

/** 0 means "unlimited" throughout the plan model. */
function limitLabel(value: number): string {
  return value === 0 ? "Unlimited" : value.toLocaleString("en-IN");
}

const FEATURE_LABELS: Record<string, string> = {
  ROOM_CRM: "Hotel guest CRM",
  RESTAURANT_CRM: "Restaurant guest CRM",
  CUSTOMER_CRM: "Customer profiles & history",
  CAMPAIGNS: "Consent-based campaigns",
  WHATSAPP: "WhatsApp messaging",
  SMS: "SMS messaging",
  EMAIL: "Email messaging",
  OFFERS: "Offers & promotions",
  AUTOMATION: "Automations & journeys",
  ANALYTICS: "Analytics & reports",
  ADVANCED_ANALYTICS: "Advanced analytics",
  REPORTS: "Scheduled owner reports",
  AI_ASSISTANT: "AI assist",
  API: "Developer API & webhooks",
  POS_INTEGRATION: "POS & billing integration",
  LOYALTY: "Loyalty & rewards",
};

function planHighlights(plan: PublicPlan): string[] {
  const rows = [
    `${limitLabel(plan.limits.customers)} guests`,
    `${limitLabel(plan.limits.staff)} staff ${plan.limits.staff === 1 ? "login" : "logins"}`,
    `${limitLabel(plan.limits.messages)} messages / month`,
    `${limitLabel(plan.limits.campaigns)} campaigns / month`,
  ];
  return rows;
}

function PlanCard({ plan }: { plan: PublicPlan }) {
  const yearlyIsDiscounted = plan.yearlyPrice > 0 && plan.yearlyPrice < plan.monthlyPrice * 12;
  const isFree = plan.monthlyPrice === 0;

  return (
    <div
      className={`relative flex flex-col rounded-[6px] border p-7 ${
        plan.recommended
          ? "border-[color:var(--gold)]/60 bg-[color:var(--card)] shadow-[0_24px_60px_-40px_oklch(0.2_0.02_75/45%)]"
          : "border-[color:var(--border)]/80 bg-[color:var(--card)]/70"
      }`}
    >
      {plan.recommended && (
        <span className="absolute -top-2.5 left-7 rounded-[2px] bg-[color:var(--gold)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-[color:var(--ink)]">
          Recommended
        </span>
      )}

      <p className="lux-eyebrow">{plan.name}</p>
      <div className="mt-4 flex items-baseline gap-1.5">
        <span className="font-serif text-[36px] leading-none text-[color:var(--ink)]">
          {inr(plan.monthlyPrice, plan.currency)}
        </span>
        <span className="text-[12px] text-[color:var(--muted-foreground)]">
          {isFree ? "forever" : "/ outlet / month"}
        </span>
      </div>
      {yearlyIsDiscounted && (
        <p className="mt-2 text-[12px] text-[color:var(--muted-foreground)]">
          Or {inr(plan.yearlyPrice, plan.currency)} billed yearly
        </p>
      )}
      {plan.trialDays > 0 && (
        <p className="mt-1 text-[12px] text-[color:var(--gold-ink)]">{plan.trialDays}-day free trial</p>
      )}

      {plan.description && (
        <p className="mt-4 text-[12.5px] leading-relaxed text-[color:var(--muted-foreground)]">
          {plan.description}
        </p>
      )}

      <ul className="mt-6 space-y-2.5 text-[12.5px] text-[color:var(--ink)]/85">
        {planHighlights(plan).map((row) => (
          <li key={row} className="flex items-start gap-2.5">
            <span aria-hidden className="mt-[7px] h-[3px] w-[3px] shrink-0 rounded-full bg-[color:var(--gold)]" />
            <span>{row}</span>
          </li>
        ))}
        {plan.features
          .filter((feature) => FEATURE_LABELS[feature])
          .slice(0, 6)
          .map((feature) => (
            <li key={feature} className="flex items-start gap-2.5">
              <span aria-hidden className="mt-[7px] h-[3px] w-[3px] shrink-0 rounded-full bg-[color:var(--gold)]" />
              <span>{FEATURE_LABELS[feature]}</span>
            </li>
          ))}
      </ul>

      <Link
        href="/"
        className={`mt-8 block rounded-[3px] px-4 py-2.5 text-center text-[11px] font-medium uppercase tracking-[0.16em] transition-colors ${
          plan.recommended
            ? "bg-[color:var(--ink)] text-[color:var(--porcelain)] hover:bg-[color:var(--ink)]/90"
            : "border border-[color:var(--gold)]/50 text-[color:var(--gold-ink)] hover:bg-[color:var(--gold)]/10"
        }`}
      >
        {isFree ? "Start free" : "Start with this plan"}
      </Link>
    </div>
  );
}

export default async function PricingPage() {
  let plans: PublicPlan[] = [];
  let loadFailed = false;
  try {
    plans = await listPublicPlans();
  } catch {
    loadFailed = true;
  }

  return (
    <>
      <section className="lux-sheen border-b border-[color:var(--border)]/60">
        <div className="mx-auto max-w-6xl px-6 pt-16 pb-14">
          <p className="lux-eyebrow">Pricing</p>
          <h1 className="lux-display mt-4 max-w-2xl text-[42px] text-[color:var(--ink)] sm:text-[54px]">
            One flat price per outlet. No per-message surprises.
          </h1>
          <p className="mt-6 max-w-xl text-[14px] leading-[1.85] text-[color:var(--muted-foreground)]">
            Every plan includes guest profiles, visit history, consent tracking, QR feedback and the
            dashboard that tells you who came back. Upgrade only when your guest list outgrows it.
          </p>
          <p className="mt-4 text-[11px] uppercase tracking-[0.16em] text-[color:var(--gold-ink)]">
            Prices in INR, exclusive of GST · No setup fee · Cancel anytime
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-14">
        {plans.length > 0 ? (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan) => (
              <PlanCard key={plan.id} plan={plan} />
            ))}
          </div>
        ) : (
          <div className="rounded-[6px] border border-[color:var(--border)]/80 bg-[color:var(--card)] p-10 text-center">
            <h2 className="font-serif text-[26px] text-[color:var(--ink)]">
              {loadFailed ? "Pricing is temporarily unavailable" : "Plans are being finalised"}
            </h2>
            <p className="mx-auto mt-3 max-w-md text-[13px] leading-relaxed text-[color:var(--muted-foreground)]">
              We publish prices only from live billing data, so nothing here can drift from what you would
              actually be charged. Write to us for a current quote.
            </p>
            <a
              href={`mailto:${legalContactEmail()}`}
              className="mt-6 inline-block rounded-[3px] border border-[color:var(--gold)]/50 px-5 py-2.5 text-[11px] uppercase tracking-[0.16em] text-[color:var(--gold-ink)]"
            >
              Ask for pricing
            </a>
          </div>
        )}

        <div className="mt-14 grid gap-10 border-t border-[color:var(--border)]/60 pt-10 md:grid-cols-3">
          <div>
            <h2 className="lux-eyebrow">What is always included</h2>
            <p className="mt-3 text-[12.5px] leading-relaxed text-[color:var(--muted-foreground)]">
              Guest CRM, visit history, QR feedback, consent records, segmentation, owner reports and the
              full audit trail — on every plan, including the free one.
            </p>
          </div>
          <div>
            <h2 className="lux-eyebrow">Messaging costs</h2>
            <p className="mt-3 text-[12.5px] leading-relaxed text-[color:var(--muted-foreground)]">
              WhatsApp, SMS and email are billed by their providers. Your dashboard shows the estimated
              cost before a campaign is sent, and plan message limits are enforced so a trial can never
              run up an unexpected bill.
            </p>
          </div>
          <div>
            <h2 className="lux-eyebrow">Billing questions</h2>
            <p className="mt-3 text-[12.5px] leading-relaxed text-[color:var(--muted-foreground)]">
              See the{" "}
              <Link href="/refund-policy" className="text-[color:var(--gold-ink)] underline underline-offset-4">
                Cancellation &amp; Refund Policy
              </Link>{" "}
              or write to{" "}
              <a
                href={`mailto:${legalContactEmail()}`}
                className="text-[color:var(--gold-ink)] underline underline-offset-4"
              >
                {legalContactEmail()}
              </a>
              .
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
