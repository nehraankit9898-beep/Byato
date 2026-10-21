import type { Metadata } from "next";

import { LegalArticle } from "@/components/public/site-shell";
import { LEGAL_LAST_UPDATED, PRODUCT_NAME, legalContactEmail } from "@/lib/legal";

export const metadata: Metadata = {
  title: `Cancellation & Refund Policy — ${PRODUCT_NAME}`,
  description:
    "How Beyto handles free trials, monthly and annual subscriptions, cancellations, failed payments, duplicate charges and refunds.",
};

/**
 * A reachable, specific refund policy is required by Indian payment
 * providers before live collections are enabled, and by the Consumer
 * Protection (E-Commerce) Rules, 2020 for the cancellation/refund terms a
 * buyer must see before paying.
 */
export default function RefundPolicyPage() {
  const contact = legalContactEmail();
  return (
    <LegalArticle
      eyebrow="Legal"
      title="Cancellation & Refund Policy"
      summary="When you cancel, what happens to the period you already paid for, and when a refund is due."
      lastUpdated={LEGAL_LAST_UPDATED}
    >
      <h2>1. Free trial</h2>
      <p>
        Where a plan includes a trial, no payment is taken during the trial. Cancel before the trial ends
        and nothing is charged. If you do not cancel, the plan converts to paid at the price shown on the{" "}
        <a href="/pricing">pricing page</a> at the time of conversion, and we email a receipt.
      </p>

      <h2>2. Cancelling a paid plan</h2>
      <ul>
        <li>You can cancel from the billing section of the dashboard, or by writing to <a href={`mailto:${contact}`}>{contact}</a>.</li>
        <li>Cancellation stops the next renewal. Your plan stays active until the end of the period you have already paid for.</li>
        <li>We do not pro-rate the unused part of a period for a voluntary cancellation, because the subscription reserves capacity (customers, message credits, storage) for the whole period.</li>
        <li>Your data remains exportable until the end of the paid period. Export it before cancelling if you need a copy.</li>
      </ul>

      <h2>3. When we do refund</h2>
      <ul>
        <li><strong>Duplicate or incorrect charge:</strong> refunded in full.</li>
        <li><strong>Charge after a timely cancellation:</strong> if you cancelled before the renewal date and were still charged, refunded in full.</li>
        <li><strong>Service unavailable for a material part of a paid month</strong> because of a fault on our side: a pro-rated credit or refund for the affected period, at your choice.</li>
        <li><strong>Accidental purchase reported within 7 days</strong> where the paid features were not used: reviewed case by case, and normally refunded.</li>
        <li><strong>Plan-specific refund terms</strong> shown at checkout, if any, apply in addition to this policy.</li>
      </ul>

      <h2>4. When we do not refund</h2>
      <ul>
        <li>Message, template or carrier charges already incurred with WhatsApp, SMS or email providers.</li>
        <li>Third-party costs you bought separately (for example a custom onboarding or integration project).</li>
        <li>Accounts suspended for a breach of the <a href="/terms">Terms of Service</a>, including messaging without consent or sending prohibited content.</li>
        <li>Requests made after the period they relate to has ended, other than duplicate or incorrect charges.</li>
      </ul>

      <h2>5. How to request a refund</h2>
      <ol>
        <li>Email <a href={`mailto:${contact}`}>{contact}</a> from the address on your account, with your restaurant name, invoice number and payment reference.</li>
        <li>We acknowledge within 2 business days and confirm the decision, with a reason, within 7 business days.</li>
        <li>Approved refunds are returned to the original payment method. Banks and payment providers usually take 5–10 business days to credit; the exact time depends on them.</li>
        <li>Where a payment method cannot be refunded (for example a closed card), we will offer a bank transfer or an account credit instead.</li>
      </ol>

      <h2>6. Failed payments and grace period</h2>
      <p>
        If a renewal charge fails, we retry and notify you. Paid features continue during a short grace
        period so your guests are not cut off mid-campaign. If the payment is still not completed after the
        grace period, the account moves to the free tier or is suspended until payment is made. No refund is
        due for features you could not use because a payment failed.
      </p>

      <h2>7. Price changes</h2>
      <p>
        We may change plan prices. A change never applies to a period you have already paid for, and we
        give at least 30 days&apos; notice before it applies to your next renewal.
      </p>

      <h2>8. Consumer rights</h2>
      <p>
        Nothing in this policy limits rights you have under the Consumer Protection Act, 2019 or other
        applicable Indian law. If you are not satisfied with our decision, write to{" "}
        <a href={`mailto:${contact}`}>{contact}</a> again marking the message &quot;Escalation&quot;, and we
        will involve a senior team member.
      </p>

      <h2>9. Taxes</h2>
      <p>
        Refunds are processed on the amount actually paid, including GST. A credit note is issued for the
        refunded invoice. Charges that are genuinely incurred (for example message costs already delivered)
        are excluded from the refundable amount and are itemised in our reply.
      </p>
    </LegalArticle>
  );
}
