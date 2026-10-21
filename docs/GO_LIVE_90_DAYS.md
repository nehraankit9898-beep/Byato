# Beyto — Real-Business Go-Live Plan (90 days)

**Purpose:** move from "impressive codebase" to "5 paying restaurants using it every day".
Read this before writing another feature. Everything below is ordered by what actually
gets a business to first revenue — not by what is interesting to build.

---

## 0. Honest starting point (verified 2026-10-21)

| Fact | Evidence |
|---|---|
| Feature surface is huge: 113 Prisma models, ~80 API route groups, phases 1–18 | `prisma/schema.prisma`, `src/app/api/*` |
| Operator-facing docs say production was **never approved or verified** | `DEPLOYMENT_READINESS.md`, `REMAINING_ISSUES.md` |
| No live deployment, no real WhatsApp / email / Razorpay credentials configured | `.env.example`, `src/lib/providers/index.ts` — simulation mode is the default |
| No marketing page, pricing page, privacy policy or terms route | `src/app` contains only the app shell + `menu`, `pay`, `r/`, auth screens |
| No error tracking / product analytics / uptime integration | no Sentry/PostHog/gtag in `src` |
| No `vercel.json` → campaign queue, follow-up engine and scheduled reports have **no scheduler on Vercel** | repo root |
| UI is English-only | no i18n layer |
| Build could not be verified in this sandbox (`binaries.prisma.sh` blocked) | `prisma generate` fails on engine download |

**Conclusion:** the risk is no longer "not enough features". The risk is that nobody can
sign up, pay, and get one real WhatsApp message delivered without you in the room.

---

## 1. Pick one wedge and hide everything else (week 1)

Do **not** launch "Hotel & Restaurant retention + POS + KDS + franchise + AI + A/B testing".
No restaurant owner buys 18 modules; they buy "more repeat customers this month".

**Recommended wedge (fastest to prove in Jaipur):**

> *"QR feedback + loyalty + WhatsApp win-back for independent restaurants."*

One loop, end to end:

1. Guest scans the table QR → rates the visit → optional phone + consent.
2. Guest is auto-tagged (happy / unhappy / lapsed) and gets a loyalty balance.
3. Owner opens one screen and sees: "412 guests, 96 lapsed, ₹X recoverable".
4. Owner clicks **Send win-back** → one approved WhatsApp template goes out.
5. Dashboard shows guests who came back.

**Hide for v1** (feature-flag them off in Super Admin): POS/GST billing, KDS, inventory,
tables & online ordering, franchise, benchmarking, A/B experiments, AI recommendations,
white-label. They stay in the code, they stay dark.

Why this wedge: the QR + feedback + loyalty + segment + campaign pipeline is already built
and is the cheapest thing to make *real*. Restaurant POS/GST billing competes with Petpooja,
Posist and Zomato — you will lose that fight as a solo builder.

---

## 2. Gate 1 — "It works with real credentials" (weeks 1–2)

Nothing else matters until these eight items are green. Each one is a *paid customer
blocker*, not a nice-to-have.

1. **Deploy once, publicly.** Vercel + Neon Postgres, real domain (`beyto.in` or similar),
   HTTPS, `AUTH_SECRET`, `INTEGRATION_ENCRYPTION_KEY`, `APP_ORIGIN` set.
   Apply `db:migrate:deploy`, create the super admin with `bootstrap:admin`, then
   **remove `ADMIN_BOOTSTRAP_SECRET`**.
2. **Prove the build on a clean machine.** `npm ci && npm run build` must pass from a fresh
   clone, not only in your head. Pin/document `PRISMA_ENGINES_MIRROR` if your network blocks
   `binaries.prisma.sh` (it blocked this sandbox).
3. **WhatsApp for real.** Meta Business account → verified business → dedicated phone number
   → 2–3 approved templates (`visit_thankyou`, `winback_offer`, `review_request`).
   Send one template to a real phone. Until this works the whole product is a demo.
4. **Email for real.** Resend or SES + domain DNS (SPF, DKIM, DMARC). Verification and reset
   emails must arrive in Gmail, not in spam.
5. **Razorpay live.** KYC, live keys, webhook reachable, subscription invoice with GSTIN,
   refund path tested with ₹1. Until then you cannot take money.
6. **A scheduler that actually runs.** Add `vercel.json` crons (or keep the worker on a small
   VPS) for: campaign queue drain, follow-up engine, scheduled reports, retention sweep.
   Without it, "automation" silently never fires.
7. **Observability.** Sentry (or equivalent) + uptime check on `/api/health/live` + a daily
   backup that you have actually restored once (`restore:backup` on a throwaway DB).
8. **Legal pages.** `/privacy`, `/terms`, `/refund-policy`, `/pricing` — linked in the footer.
   Under India's DPDP Act 2023 you need notice + consent proof + deletion on request; the
   consent and privacy-request code already exists, the *pages* do not.

**Definition of done:** a stranger with the link can register, import guests, send a real
WhatsApp campaign and see results — no terminal, no help from you.

---

## 3. Gate 2 — "A restaurant can be live in 10 minutes" (weeks 2–4)

Onboarding is the product. Every extra minute costs you a customer.

- **Import from what they already use.** Generic CSV (name, phone, last visit date, spend)
  plus a mapped "export from Petpooja / Posist / Zomato order history" preset. Target < 5 min
  from signup to a populated dashboard.
- **First campaign in one click.** Ship 3 pre-written, pre-approved WhatsApp templates in
  Hindi + English. Owner picks audience → preview → send. No template builder in v1.
- **Hindi + English UI toggle.** Floor managers and owners in Jaipur will not fight an
  English-only dashboard. At minimum: labels, campaigns, reports, errors.
- **Mobile-first.** 80% of usage will be a phone behind a counter. Audit the top 5 screens at
  375px width before launch.
- **Empty, error and loading states everywhere.** A spinner that never resolves reads as
  "product is broken". This is a bigger churn driver than missing features.
- **Cost guardrails.** Marketing templates cost real money (~₹0.8–1.2 per message in India —
  verify current Meta rates). Show estimated cost before send, enforce plan message limits
  (already in `src/lib/saas/limits.ts`), and never let a free trial burn a month of credits.

**Skip in v1:** POS integration, GST invoicing, online ordering, multi-branch. Add them only
when a paying customer says "I will not renew without it".

---

## 4. Gate 3 — first 5 paying customers (weeks 4–8)

Do not launch self-serve to the internet. Sell and onboard manually.

- **Target:** 5 independent cafés/restaurants in Jaipur, 40–120 covers/day, already collecting
  phone numbers at billing.
- **Offer:** 60 days free in exchange for (a) a testimonial, (b) access to their numbers,
  (c) a 30-minute call every two weeks.
- **Do the onboarding yourself.** You import their CSV, you approve their templates, you send
  the first campaign. Watch where they hesitate — that's your roadmap.
- **One success metric:** *% of lapsed guests (90+ days) who return within 30 days of a
  win-back campaign.* If this number is not better than "do nothing", the product has no
  business case — pivot or kill.
- **Secondary proof:** messages delivered, QR scans per table per day, staff actually opening
  the dashboard (login frequency is the real retention signal).
- **Pricing:** simple, 3 tiers, per outlet, monthly, message credits included
  (e.g. ₹999 / ₹2,499 / ₹4,999). Annual = 2 months free. No per-message surprises.

Only after 5 paying customers → self-serve signup, landing page, SEO, demo video.

---

## 5. Weeks 8–12 — make it repeatable

- Landing page that sells **one outcome**, not 18 modules. One 60-second screen recording of
  the real loop beats every feature list.
- Case study: "How Café X recovered 214 guests in 30 days" with real numbers.
- Partner channel: POS vendors, hotel/restaurant associations (JHA in Jaipur), local
  consultants — they already have the customer list.
- Support: WhatsApp Business number + a 30-minute onboarding call as a paid add-on.
- Weekly dashboard: signups → activated (first campaign sent) → week-4 retained → paying →
  churned. If activation < 40%, fix onboarding, not features.

---

## 6. What to deliberately *not* do for 90 days

| Don't | Why |
|---|---|
| Add modules (POS, KDS, franchise, AI, A/B, white-label) | Already 10× more surface than a v1 needs; each one adds support load and security risk |
| Market "GST billing" as the headline | You compete with entrenched POS vendors; you'd lose |
| Claim DPDP/GST compliance before the pages, consent proof and deletion flow are live | Legal exposure and it destroys trust in the first sales call |
| Turn on billing for hotel tenants with no verified payment path | Silent revenue loss and chargebacks |
| Rewrite the architecture | The code is already structured (guards, audit, RBAC, tenant isolation). Ship, don't refactor |
| Keep writing more audit markdown files | The repo already has ~20 reports; one plan + working software is worth more |

---

## 7. 30/60/90 summary

| Day | Target |
|---|---|
| 30 | Public HTTPS deployment + real WhatsApp + real email + Razorpay live + legal pages + scheduler running + one internal tenant using the loop daily |
| 60 | Onboarding < 10 min, Hindi UI, 5 pilot restaurants onboarded by hand, first win-back campaign measured |
| 90 | 5 paying customers, 1 case study, activation rate measured, churn and message cost known, decision: scale the wedge or change it |

**Kill criteria (be honest):** if by day 90 fewer than 3 restaurants renew at paid price, or
lapsed-guest return rate is not measurably better than baseline, stop building and talk to 20
restaurant owners before writing more code.
