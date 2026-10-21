import type { Metadata } from "next";

import { LegalArticle } from "@/components/public/site-shell";
import { LEGAL_LAST_UPDATED, PRODUCT_NAME, legalContactEmail } from "@/lib/legal";

export const metadata: Metadata = {
  title: `Privacy Policy — ${PRODUCT_NAME}`,
  description:
    "How Beyto collects, uses, stores and deletes restaurant guest and account data, and how to exercise your rights under India's DPDP Act 2023.",
};

/**
 * Privacy notice. Two distinct roles are spelled out because they matter:
 * for a restaurant's guest records Beyto is a DATA PROCESSOR (the restaurant
 * decides why and how long), while for the account/billing data of the
 * restaurant itself Beyto acts as the DATA FIDUCIARY.
 */
export default function PrivacyPage() {
  const contact = legalContactEmail();
  return (
    <LegalArticle
      eyebrow="Legal"
      title="Privacy Policy"
      summary="This notice explains what personal data Beyto handles, why we handle it, who we share it with, how long we keep it, and the choices you have."
      lastUpdated={LEGAL_LAST_UPDATED}
    >
      <p>
        {PRODUCT_NAME} is a customer-retention platform for hotels and restaurants. It records guest
        visits, stores marketing consent, runs consent-based campaigns (WhatsApp, SMS and email) and
        reports how many guests come back.
      </p>

      <h2>1. Two roles, stated plainly</h2>
      <ul>
        <li>
          <strong>Guest records belong to the restaurant.</strong> When a restaurant stores its guests&apos;
          names, phone numbers, visits and preferences in {PRODUCT_NAME}, the restaurant decides what is
          collected and why. {PRODUCT_NAME} processes that data only on the restaurant&apos;s instructions,
          as a <em>data processor</em>. If you are a guest, contact the restaurant first — we act on their
          instructions and will help them answer you.
        </li>
        <li>
          <strong>Account and billing data are ours to protect.</strong> For the restaurant&apos;s own
          sign-up details, staff accounts, invoices and platform usage, {PRODUCT_NAME} decides the purpose
          and means of processing and acts as a <em>data fiduciary</em>.
        </li>
      </ul>

      <h2>2. What we collect</h2>
      <h3>Restaurant account data</h3>
      <ul>
        <li>Business name, address, GSTIN (if provided), contact name, email address and phone number.</li>
        <li>Staff user accounts: name, email, phone, role, and a hashed password (never the password itself).</li>
        <li>Billing records: plan, invoices, payment references and GST details. Card and UPI credentials are entered directly with our payment provider; {PRODUCT_NAME} never stores them.</li>
        <li>Configuration data: menu items and prices, tables, message templates, automations, API keys and webhook endpoints you create.</li>
      </ul>

      <h3>Guest data entered by the restaurant</h3>
      <ul>
        <li>Name, phone number, email (optional), visit history, spend totals, table/order references and free-text notes the restaurant writes.</li>
        <li>Consent records: whether the guest agreed to marketing messages, the channel, the timestamp and the source (for example a table QR code, a bill, or a manual import).</li>
        <li>Feedback ratings and comments submitted through QR feedback links or public menu pages.</li>
      </ul>

      <h3>Technical data</h3>
      <ul>
        <li>Request logs (IP address, user agent, request id, timestamps), security events such as failed logins, and audit-trail entries for sensitive actions.</li>
        <li>A strictly-necessary session cookie and a CSRF cookie. We do not run advertising or cross-site tracking cookies.</li>
      </ul>

      <h2>3. Why we use it</h2>
      <ul>
        <li>To provide the service: store visits, segment guests, send the campaigns the restaurant schedules, show reports.</li>
        <li>To keep consent honest: record opt-ins and opt-outs, and block marketing messages to guests who withdrew consent.</li>
        <li>To bill correctly: subscriptions, invoices, usage limits and GST records.</li>
        <li>To keep the platform safe: authentication, role checks, rate limiting, fraud and abuse prevention, audit logs.</li>
        <li>To support you: answering a support request, investigating an incident, or exporting your data when you ask.</li>
        <li>To meet legal obligations, and to establish or defend legal claims.</li>
      </ul>

      <h2>4. Consent, and how to withdraw it</h2>
      <p>
        Marketing messages are sent only where consent exists and is recorded. Every campaign checks
        consent before sending, and opt-outs are honoured across channels. A guest can withdraw consent
        at any time through the restaurant, through an unsubscribe link in an email, or by replying to the
        message; the restaurant can also record a withdrawal in the dashboard. Withdrawal stops future
        marketing — it does not delete the visit history the restaurant needs for accounting and service.
      </p>

      <h2>5. Who we share data with</h2>
      <p>
        We do not sell personal data. We share the minimum needed with service providers that operate the
        platform, under contracts that limit their use of it:
      </p>
      <ul>
        <li>Cloud hosting and database providers (application hosting and a managed PostgreSQL database).</li>
        <li>Messaging providers: WhatsApp Business (Meta) for WhatsApp templates, plus the SMS and email providers configured for your account.</li>
        <li>Payment providers (for example Razorpay or Stripe) for subscriptions, invoices and refunds.</li>
        <li>Professional advisers, auditors or authorities where the law requires it.</li>
      </ul>
      <p>
        Restaurants can additionally connect their own integrations (for example an outbound webhook or a
        developer API key). Those connections are configured by the restaurant and the data sent through
        them is the restaurant&apos;s decision.
      </p>

      <h2>6. Where data is stored</h2>
      <p>
        Data is stored in the region configured for our hosting and database providers. Some providers
        process data outside India for support or redundancy. Where that happens, we rely on the
        providers&apos; contractual safeguards and only transfer data needed to run the service.
      </p>

      <h2>7. How long we keep it</h2>
      <ul>
        <li><strong>Guest records:</strong> for as long as the restaurant keeps them. When a restaurant is closed or deletes its workspace, its guest data is removed from the live system according to the retention configured for that tenant.</li>
        <li><strong>Account and billing records:</strong> while the account is active, and afterwards for as long as tax and accounting law requires.</li>
        <li><strong>Security and audit logs:</strong> for a limited period, so we can investigate abuse and prove what happened.</li>
        <li><strong>Suppression lists:</strong> we keep a minimal record of opt-outs, so a guest who said &quot;stop&quot; is not messaged again even after an import.</li>
        <li><strong>Backups:</strong> encrypted backups are retained on a rolling schedule. A deleted record can remain in a backup until that backup expires, and backups are only restored for disaster recovery.</li>
      </ul>

      <h2>8. How we protect it</h2>
      <ul>
        <li>Passwords are stored as salted hashes, never in plain text, and sessions use signed, http-only cookies with server-side revocation.</li>
        <li>Integration credentials are encrypted at rest with AES-256-GCM; encryption keys are rotated on a documented schedule.</li>
        <li>Every request is checked against the tenant and role of the signed-in user, so one restaurant cannot read another&apos;s guests.</li>
        <li>Sensitive actions (exports, role changes, deletions, billing changes) are written to an audit trail.</li>
        <li>Uploads are re-encoded server-side, request bodies are size-capped, and public endpoints are rate limited.</li>
      </ul>
      <p>
        No system is perfectly secure. If a breach affects your personal data, we will notify affected
        restaurants and the relevant authority as required by applicable law.
      </p>

      <h2>9. Your rights</h2>
      <p>Subject to applicable law (including India&apos;s Digital Personal Data Protection Act, 2023), you can ask to:</p>
      <ul>
        <li>know what personal data we hold about you, and get a summary or a copy;</li>
        <li>correct or complete data that is inaccurate;</li>
        <li>erase data that is no longer needed for the purpose it was collected;</li>
        <li>withdraw consent, with effect from the date of withdrawal;</li>
        <li>nominate a person to exercise your rights if you die or become incapacitated;</li>
        <li>complain to us first, and then to the Data Protection Board of India if you are not satisfied.</li>
      </ul>
      <p>
        Write to <a href={`mailto:${contact}`}>{contact}</a>. We aim to respond within 30 days. Guests who
        want their data corrected or erased should contact the restaurant that holds their record; we
        support the restaurant&apos;s response. Restaurants can run an erasure request from the privacy
        request queue in the dashboard.
      </p>

      <h2>10. Children</h2>
      <p>
        {PRODUCT_NAME} is a business tool for hospitality operators and is not directed at children. We do
        not knowingly collect personal data of children. If you believe a child&apos;s data was entered,
        contact us and we will remove it.
      </p>

      <h2>11. Cookies</h2>
      <p>
        We use cookies that the service cannot work without: a session cookie (http-only, signed) and a
        CSRF cookie that protects forms against cross-site requests. We do not use advertising cookies or
        third-party analytics that follow you across websites.
      </p>

      <h2>12. Changes to this notice</h2>
      <p>
        If this notice changes materially, we will update the date above and tell account owners by email
        before the change takes effect. Continued use of the service after that date means you accept the
        updated notice.
      </p>

      <h2>13. Contact and grievance officer</h2>
      <p>
        Questions, requests and complaints: <a href={`mailto:${contact}`}>{contact}</a>. Please include
        your restaurant name and the phone number or email address involved, so we can find the record
        quickly. Escalations that cannot be resolved with us may be raised with the Data Protection Board
        of India.
      </p>
    </LegalArticle>
  );
}
