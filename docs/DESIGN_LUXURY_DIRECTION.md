# Beyto — Luxury Direction: "Ivory, Ink & Champagne"

A concrete design direction for turning the current dashboard into something that feels
like a boutique hotel rather than a growth-hacking SaaS.

**See it first:** open `design/luxury-preview.html` (or `npm run preview:design` →
`http://localhost:4173`). Tokens in that mock are the same values now applied to the
real app in `src/app/globals.css`.

---

## 1. What luxury actually means here

Not gold gradients, not glassmorphism, not more animation. Luxury in an operations tool is
**restraint plus precision**:

| Signal | Cheap version | Luxury version |
|---|---|---|
| Colour | saturated amber/orange everywhere | warm ivory paper, espresso ink, **one** champagne accent used sparingly |
| Type | one sans, bold headings, tight tracking | serif headings (Cormorant) + neutral sans for UI (Geist) |
| Structure | heavy shadows and big rounded cards | hairlines, 6px radii, shadow only on floating layers |
| Density | equal weight for everything | one primary number per card, everything else recedes |
| Motion | 150ms snappy, bouncy | 420ms eased, almost imperceptible |
| Copy | "Boost your retention 🚀" | "Three guests worth a quiet word." |

The test: **screenshot any screen, remove the logo — would a hotel GM believe it costs ₹2,499/month?**
If it looks like a free Chrome extension, the design has failed regardless of features.

---

## 2. What is already changed in the codebase

| File | Change |
|---|---|
| `src/app/globals.css` | New palette (ivory / ink / champagne / sage / terracotta), radius 0.75rem → 0.375rem, serif `h1–h4` with sans body, `tabular-nums` for tables & `[data-numeric]`, refined scrollbars, new `--gold-ink` token |
| `src/app/globals.css` (`@theme`) | Amber scale remapped to champagne → ~80 existing `amber-*` utilities restyle themselves, no component edits |
| `src/app/globals.css` (utilities) | `.lux-eyebrow`, `.lux-display`, `.lux-rule`, `.lux-card`, `.lux-sheen`, `.lux-ink-panel`, `.lux-gold-text`, `.lux-transition` |
| `src/app/layout.tsx` | Self-hosted **Cormorant Garamond** (400/500/600, SIL OFL) as `--font-cormorant`, `themeColor` → `#171310` |
| `src/app/fonts/`, `public/fonts/` | Font binaries + licence; `public/fonts` is there for the login/QR/guest-facing surfaces |
| `design/luxury-preview.html` | Standalone visual reference: hero, app dashboard, before/after, type & palette specs, guest QR card, pricing |
| `scripts/serve-design.mjs` | Static preview server, not part of the Next build |

Nothing functional changed. No feature, route, query or permission was touched.

---

## 3. The five rules (apply to everything from here on)

1. **One accent per screen.** Gold only for: eyebrow labels, 1px rules, the active nav marker,
   a single primary number, focus rings. Gold never fills a button that isn't the *one* primary
   action on the page, and never a large surface.
2. **Serif for voice, sans for work.** Headings, KPI numerals, empty-state lines, guest-facing
   copy → Cormorant. Labels, tables, inputs, buttons, errors → Geist. Never serif below 14px,
   never serif for body paragraphs longer than two lines.
3. **Hairlines over shadows.** Cards get a 1px warm border; shadow only for modals, popovers and
   the one "featured" pricing/invitation card.
4. **6px radii, 8pt spacing.** Buttons, inputs and cards share the same corner. Section rhythm
   96–108px on marketing surfaces, 24–32px inside the app. No `rounded-2xl`/`rounded-3xl`.
5. **420ms, cubic-bezier(.22,.61,.36,1).** Everything eases. Nothing bounces, nothing snaps,
   no spring hover. Respect `prefers-reduced-motion`.

---

## 4. Applying it to the real screens (order matters)

Do these in order — each one is independently shippable, and the first three deliver ~80% of
the perceived upgrade.

### 4.1 Login / register (`login-screen.tsx`, `register-screen.tsx`)
- Split layout: left = full-bleed venue photograph (dark-toned, no text) or `.lux-ink-panel`;
  right = form on ivory. Today it's a centred card on a flat background — the single biggest
  cheap-looking cue.
- Form: 44px inputs, 1px `--line` border, label above in `.lux-eyebrow`, no placeholder-as-label.
- One ink button, full width, uppercase 12px, `0.12em` tracking.
- Bottom line: "Already a member? Sign in" — never "Don't have an account? Sign up!!!".

### 4.2 Dashboard (`dashboard-view.tsx`)
- Replace the 4 KPI cards with **one hairline-divided strip** (as in the mock): serif numeral,
  uppercase label, one delta line. Removes four competing card shadows.
- Section titles: `.lux-eyebrow` above, serif `h3` below. No icon next to every title.
- Charts: remove gridlines and axis chrome, muted fills (`--chart-*`), highlight one series in
  champagne, tooltips on white with a hairline border.
- Replace every `🟢 / 🔥 / ✅` emoji in status with a 4px dot + label (simulation badge stays
  honest, just quieter).

### 4.3 Campaigns / composer
- Two-column: template preview (chat bubble on `--porcelain`) + guardrails column.
- Show **audience size, estimated cost, consent count** *before* the approve button, in the
  composer footer — luxury is confidence, and confidence means no surprises at send time.
- Primary action label is a verb phrase: "Approve & send 214" not "Submit".

### 4.4 Guests list / tables
- No zebra striping. Hairline row dividers, 14px vertical padding, hover `#fdfbf7`.
- Numerals are tabular; money right-aligned; dates as `12 Jul`, not `07/12/2026`.
- Segments as outlined chips (gold for lapsed/high-value, sage for new) — never coloured fills.

### 4.5 Settings, forms and modals
- Inputs: 44px height, 1px border, gold focus ring at 1px (no glow), inline errors in
  terracotta `--destructive`, helper text in `--muted`.
- Modals: overlay `oklch(0.2 0.01 70 / 45%)` + 2px blur, white card, 6px radius, title in serif,
  actions right-aligned, no full-width coloured header bar.
- Toasts: white card, 1px border, left 2px gold rule, text only.

### 4.6 Guest-facing surfaces (`menu/[code]`, `pay/[token]`, `r/` feedback)
These are the only surfaces guests touch — spend the most polish here.
- Paper texture background (`--porcelain` + 2% noise), serif dish names, generous line-height.
- QR card printable on 300gsm cotton stock: venue name in small caps, one line of invitation,
  QR in a hairline square, no "Scan me!" arrows.
- Feedback flow: one question per screen, 20 seconds, thank-you in serif italic.

---

## 5. Content tone (this is half the "premium" feeling)

Write like a maître d', not a marketer.

| Instead of | Write |
|---|---|
| "Boost retention 🚀" | "Guests worth a nudge" |
| "Send Campaign" | "Compose an invitation" |
| "0 results found" | "Nothing here yet. Your first import takes about a minute." |
| "Error! Something went wrong" | "That didn't save. Try again — your data is safe." |
| "Customer #4812" | "Rahul Mehta · 6 visits" |

Warm business WhatsApp templates in Hindi + English (only *approved* templates):

> नमस्ते {name} जी, {venue} में आपका फिर से स्वागत है। आपकी पिछली पसंद याद है — इस बार शेफ का
> tasting menu आपके लिए तैयार है. — Team {venue}

Hindi is a luxury signal in this market: it tells a Jaipur owner this was built for them.

---

## 6. Beyond CSS — the product has to feel premium too

Design can't carry a cheap offer. Pair it with:

- **Tier names with intent:** Table · Room · Suite (Essential / Signature / Maison), not
  Basic/Pro/Enterprise.
- **A named human.** "Your onboarding: Priya, 30 minutes, on WhatsApp." Response SLA printed on
  the pricing page.
- **Invite-only or capped onboarding** for the first 20 venues — scarcity is honest when you're solo.
- **One printed artefact:** a cotton-paper QR card with the venue's name, delivered by hand at
  onboarding. Costs ₹40, is remembered for months, and photographs well for case studies.
- **Consistent identity everywhere:** email header, invoice PDF, WhatsApp template footer,
  OG image and favicon all use the same ivory/ink/gold lockup (see `public/favicon.ico`,
  `themeColor`).
- **Photography over illustration.** One good photo of a real dining room beats any hero illustration.

---

## 7. Accessibility guardrails (measured, not guessed)

Champagne on ivory is only **2.3:1** — it is decoration, not text. Use `--gold-ink` for any
small gold type:

| Pair | Ratio | Use |
|---|---|---|
| ink #1b1714 on ivory #fbf9f5 | 15.5:1 | body, headings |
| muted #6e655c on ivory | 5.4:1 | secondary text |
| gold-ink #816229 on ivory | 5.4:1 | eyebrows, links, small gold text |
| gold #c4a265 on ivory | 2.3:1 | rules, dividers, 1px accents **only** |
| #cfae74 on ink #241f1a | 7.8:1 | gold text on dark panels |
| cream #f6f1e8 on ink | 14.5:1 | dark panel body text |

Also: visible focus states on every interactive element, 44px minimum tap targets, no text over
photos without a scrim, `prefers-reduced-motion` respected, and never gold-on-white for anything
a user must read.

---

## 8. What will ruin it (checklist of don'ts)

- Gold gradients on buttons, gold drop shadows, gold borders on every card.
- Serif for body copy, labels, table cells or buttons.
- More than two font sizes per card, or more than three weights on a screen.
- Emoji in UI chrome. Decorative icons next to headings.
- `rounded-2xl` / `rounded-3xl` cards, coloured card headers, 20px shadows.
- Saturated success/warning colours (bright green/amber/red blocks) — keep semantics, mute the fills.
- Animation everywhere; counters that tick; confetti.
- "Premium" language with a broken flow behind it. A luxury skin on a buggy onboarding is worse
  than a plain skin on a working one.

---

## 9. Rollout (2 weeks, no feature work)

| Day | Scope |
|---|---|
| 1 | Tokens + fonts (already done) — verify login, dashboard, campaigns, guests at 375px and 1440px |
| 2–3 | Login/register split layout with venue photography |
| 4–5 | Dashboard: KPI strip, section headers, chart restyle, remove emoji |
| 6–7 | Campaign composer: preview + cost/consent footer |
| 8 | Guest tables: hairlines, tabular numerals, date format |
| 9–10 | Modals, toasts, forms, empty/error/loading states |
| 11–12 | Guest-facing menu / pay / feedback surfaces + printable QR card |
| 13 | Print artefact, pricing page (from the mock), OG image, favicon lockup |
| 14 | Accessibility + contrast audit, `prefers-reduced-motion`, mobile pass, screenshot archive |

Ship it with the existing plan in `docs/GO_LIVE_90_DAYS.md`: the luxury direction is what makes
₹2,499/month believable, but real WhatsApp delivery and a 10-minute onboarding are what make it
collectible.
