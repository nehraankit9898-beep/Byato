import type { Metadata } from "next";

import { LegalArticle } from "@/components/public/site-shell";
import { LEGAL_JURISDICTION, LEGAL_LAST_UPDATED, PRODUCT_NAME, legalContactEmail } from "@/lib/legal";

export const metadata: Metadata = {
  title: `Terms of Service — ${PRODUCT_NAME}`,
  description:
    "The agreement between your business and Beyto: accounts, subscriptions, acceptable use, data ownership, availability and termination.",
};

export default function TermsPage() {
  const contact = legalContactEmail();
  return (
    <LegalArticle
      eyebrow="Legal"
      title="Terms of Service"
      summary="These terms govern your use of Beyto. They are written to be read: short sections, plain language, and no surprises hidden in the fine print."
      lastUpdated={LEGAL_LAST_UPDATED}
    >
      <p>
        By creating an account or using {PRODUCT_NAME}, the business you represent (&quot;you&quot;,
        &quot;your restaurant&quot;) agrees to these terms. If you do not agree, do not use the service.
      </p>

      <h2>1. Who can use {PRODUCT_NAME}</h2>
      <ul>
        <li>You must be at least 18 years old and authorised to bind the business you register.</li>
        <li>You are responsible for the accuracy of your business details, including your GSTIN where applicable.</li>
        <li>You must keep staff accounts to one person each. Sharing a login defeats the role-based controls and the audit trail.</li>
      </ul>

      <h2>2. Your account</h2>
      <ul>
        <li>Keep your password confidential; we never ask for it by email, phone or WhatsApp.</li>
        <li>You are responsible for activity under your account until you tell us it has been compromised.</li>
        <li>We may suspend an account that shows signs of abuse, credential sharing or illegal use, and we will tell you why unless the law prevents us.</li>
      </ul>

      <h2>3. Subscriptions, plans and limits</h2>
      <ul>
        <li>Plans, prices, usage limits and included features are shown on the <a href="/pricing">pricing page</a>, which reads live values from our system.</li>
        <li>Prices are in Indian Rupees (INR) and, unless stated otherwise, exclusive of applicable taxes. GST is added where required.</li>
        <li>Paid plans renew automatically for the billing period you chose until cancelled. We show the renewal date in the dashboard and email a receipt for each successful charge.</li>
        <li>Message volume is metered per plan. Outbound WhatsApp, SMS and email messages also depend on the provider&apos;s approval of your templates and sender identity; provider charges may apply separately.</li>
        <li>If a plan limit is exceeded, features may be blocked until you upgrade or the next cycle begins — we do not silently charge overage.</li>
      </ul>

      <h2>4. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>send marketing messages to people who have not consented, or who have opted out;</li>
        <li>import or upload purchased, scraped or rented contact lists, or any data you have no right to use;</li>
        <li>use the service for unlawful, deceptive or harassing messages, or content prohibited by messaging providers;</li>
        <li>attempt to access another tenant&apos;s data, bypass role checks, or probe the service for vulnerabilities without our written permission;</li>
        <li>resell, sublicense or white-label the service except under a separate written agreement;</li>
        <li>reverse-engineer, overload, or attempt to disrupt the service.</li>
      </ul>
      <p>
        We may remove content or suspend access where a messaging provider, a payment provider or the law
        requires it.
      </p>

      <h2>5. Guest data and consent — your responsibility</h2>
      <ul>
        <li>You are the owner of the guest data you put into {PRODUCT_NAME}, and you decide the purpose and retention period for it.</li>
        <li>You are responsible for having a lawful basis to contact each guest, for honouring opt-outs, and for responding to guest requests about their data.</li>
        <li>You must display an accurate privacy notice to guests and collect consent before sending marketing messages.</li>
        <li>We process guest data on your instructions as a processor, and we help you answer privacy requests through the dashboard.</li>
        <li>Do not store passwords, full card numbers, government identity numbers or health data in free-text fields.</li>
      </ul>

      <h2>6. Our responsibilities</h2>
      <ul>
        <li>We provide the service with reasonable skill and care, apply security controls appropriate to the data, and keep a documented backup and recovery process.</li>
        <li>We will give notice of planned downtime where we can, and tell you promptly about incidents that affect your data.</li>
        <li>We do not guarantee that every message will be delivered: carrier filters, WhatsApp template decisions and recipient blocks are outside our control.</li>
        <li>We may change or retire features. Material changes that reduce what a paid plan includes will be announced in advance.</li>
      </ul>

      <h2>7. Fees, taxes and invoicing</h2>
      <ul>
        <li>Charges are collected by our payment provider. By subscribing, you authorise recurring charges for the selected period.</li>
        <li>Invoices are available in the billing section of the dashboard. Update your billing details promptly so invoices remain correct.</li>
        <li>Late or failed payments may result in a grace period followed by suspension of paid features.</li>
      </ul>

      <h2>8. Intellectual property</h2>
      <ul>
        <li>{PRODUCT_NAME}, its software, design and documentation remain our property.</li>
        <li>Your content — guest records, menu, photos, message templates — remains yours. You grant us the licence needed to host, process and display it so we can run the service for you.</li>
        <li>We may use aggregated, de-identified statistics to improve the product; we do not sell identifiable business or guest data.</li>
      </ul>

      <h2>9. Availability and support</h2>
      <p>
        We aim for high availability but the service is provided on an &quot;as available&quot; basis unless
        a separate written service-level agreement says otherwise. Support is provided by email at{" "}
        <a href={`mailto:${contact}`}>{contact}</a> during business hours; we prioritise security and
        data-loss issues.
      </p>

      <h2>10. Liability</h2>
      <p>
        To the extent permitted by law, neither party is liable for indirect or consequential loss, loss
        of profit, or loss of goodwill. Our total liability for a claim relating to the service is limited
        to the amount you paid us for the service in the twelve months before the claim. Nothing in these
        terms limits liability that cannot be limited by law, including for fraud or wilful misconduct.
      </p>

      <h2>11. Termination</h2>
      <ul>
        <li>You may cancel at any time; access continues until the end of the paid period (see the <a href="/refund-policy">Cancellation &amp; Refund Policy</a>).</li>
        <li>We may terminate for material breach that is not fixed within a reasonable notice period, for non-payment, or where required by law.</li>
        <li>After termination you can export your guest data for a limited window, after which it is deleted according to our retention policy.</li>
      </ul>

      <h2>12. Changes to these terms</h2>
      <p>
        We may update these terms. Material changes will be announced by email or in the dashboard before
        they take effect. If you do not accept a change, stop using the service before it applies.
      </p>

      <h2>13. Governing law and disputes</h2>
      <p>
        These terms are governed by the laws of India. Courts at {LEGAL_JURISDICTION} have exclusive
        jurisdiction. Before starting proceedings, please write to{" "}
        <a href={`mailto:${contact}`}>{contact}</a> so we can try to resolve the issue.
      </p>

      <h2>14. Contact</h2>
      <p>
        {PRODUCT_NAME} · <a href={`mailto:${contact}`}>{contact}</a>
      </p>
    </LegalArticle>
  );
}
