# Paying for itself

Goal: cover the Claude subscription that runs this project, and ideally more,
without ongoing manual operation.

## The target, in customers

The product is a freemium WordPress plugin (`plugin/local-business-schema-hours`).
Premium pricing assumed below: **$39/yr** single site, **$79/yr** five sites,
**$149/yr** unlimited.

Freemius charges ~7% revenue share plus ~3.5% gateway fees, so a $39/yr licence
nets roughly **$34.90/yr — $2.91/mo**.

| Subscription to cover | Net needed / yr | Paying customers at $39/yr | Free installs needed (~1%/yr conversion) |
| --- | --- | --- | --- |
| Pro, $20/mo | $240 | **7** | ~700 |
| Max 5x, $100/mo | $1,200 | 35 | ~3,500 |
| Max 20x, $200/mo | $2,400 | 69 | ~6,900 |

Seven paying customers a year covers Pro. That is the realistic near-term goal.
Max 20x needs roughly ten times that and is a second-year outcome at best.

A single $149/yr agency licence covers half of Pro on its own, which is why the
tiered pricing matters more than raw install count.

## Why this model and not something else

The binding constraint is not "can I build it" — it is **acquisition with zero
promotion**. That single constraint eliminates most options:

| Option | Why it fails the constraints |
| --- | --- |
| Affiliate / programmatic SEO site | Needs 6-12 months of indexing with no guarantee; mass-generated content is explicitly targeted by search spam policies. Amazon Associates drops accounts with no early sales. |
| Standalone micro-SaaS | No distribution. Needs constant marketing, which is the thing being ruled out. |
| Paid API on an API marketplace | Discovery has collapsed; revenue per API is typically cents. |
| Selling the bakery site as a template | Requires outbound sales to local businesses. Manual by definition. |
| Ads on the existing site | Zero traffic. Nothing to monetise. |
| Trading / arbitrage | Explicitly excluded, and it is risk, not revenue. |

What survives is **software distributed through a marketplace that is itself the
sales channel**. Of those, the WordPress.org plugin directory is the strongest
fit here:

- **Acquisition is passive.** Merchants search "business hours", "opening hours",
  "local seo" from inside their own WordPress dashboard. No promotion required.
  The `readme.txt` is the ranking surface, which is why it is written as carefully
  as the code.
- **Operating cost is zero.** The plugin runs on the customer's server. No
  hosting, no database, no API keys, no per-request cost. Break-even is therefore
  **$0** — every sale is margin, and an idle month costs nothing.
- **No customer management.** Freemius is merchant of record: it handles checkout,
  VAT and US sales tax registration and remittance, licence keys, renewals,
  failed-payment dunning and refunds. No invoices, no tax filings per sale, no
  support inbox for billing.
- **Willingness to pay is proven.** Yoast charges $79/yr/site for the
  multi-location + local schema + store locator feature set, and requires Yoast
  Premium underneath it. A standalone $39/yr plugin is a real wedge under that.

## What is actually built

All of it is in `plugin/local-business-schema-hours`, with 40 passing tests.

- `includes/class-lbsh-schedule.php` — the hard part, with no WordPress
  dependency so it is testable: timezone-aware open/closed evaluation, periods
  that run past midnight, split (lunch-break) hours, 24-hour days, next
  opening/closing lookup, and date exceptions including ones that repeat annually.
- `includes/class-lbsh-schema.php` — schema.org `LocalBusiness` JSON-LD with
  `openingHoursSpecification`, `specialOpeningHoursSpecification` for holidays,
  14 business subtypes, and empty fields omitted so Search Console stays clean.
- `includes/class-lbsh-locations.php` — storage and sanitization of every field.
- `includes/class-lbsh-license.php` — the single premium gate. Every paid check
  funnels through `LBSH_License::is_pro()`, so the billing provider can change
  without touching feature code.
- `includes/class-lbsh-frontend.php` — JSON-LD output, hours table, open/closed
  badge, conditional `[business_open]` / `[business_closed]` shortcodes, and two
  server-rendered blocks (no build step, so no npm toolchain to maintain).
- `includes/class-lbsh-admin.php` — settings screen, with nonces, capability
  checks and escaping throughout.
- `includes/class-lbsh-rest.php` — `/wp-json/lbsh/v1/status`, so full-page
  caching cannot freeze the badge at a stale state.
- `readme.txt` — the acquisition asset, targeting both the "business hours" and
  "local seo / schema" keyword clusters.
- `.github/workflows/plugin-ci.yml` — lint and tests on PHP 7.4, 8.1 and 8.3,
  plus a guard that the readme stable tag matches the plugin version.
- `.github/workflows/plugin-release.yml` — **publishing is automated**: push a
  `v*` tag and the free build is stripped of premium source and committed to
  WordPress.org SVN. Releases need no manual steps.

Free edition: one location, complete and genuinely useful.
Premium: unlimited locations, holiday and seasonal closures, per-location
timezones, store locator.

## What only you can do (one-time)

These are blocked on identity and legal capacity, which I do not have. None of
them recur.

1. **WordPress.org account** and submit the plugin for review
   (https://wordpress.org/plugins/developers/add/). Set `Contributors:` in
   `readme.txt` to that username. Review was running near-empty as of mid-2026,
   but submissions are up 87% year over year and AI-generated plugins are being
   scrutinised, so expect one round of feedback.
2. **Add `SVN_USERNAME` / `SVN_PASSWORD`** as repository secrets once the plugin
   is approved. After that, releases are fully automatic.
3. **Freemius account** plus the Stripe/bank KYC it requires, then set the three
   price tiers. This is the step that legally cannot be automated — payment rails
   require a verified human and a bank account.
4. **Listing images** in `plugin/wporg-assets/` (icon, banner, two screenshots).
   The icon and banner measurably affect install rate.

Ongoing after that: realistically **1-2 hours a month** — occasional support
threads and a compatibility bump when WordPress ships a major release. Not daily,
and nothing time-critical.

## Honest bottlenecks

- **Time lag.** Organic installs accumulate over months, not days. Expect
  approximately zero revenue for the first 2-3 months, and 6-12 months to reach
  the ~700 installs that cover Pro. Nothing about this is fast.
- **Conversion is the widest error bar.** The 1%/yr free-to-paid figure is a
  planning number. At 0.3% the install target triples; at 2% it halves.
  This is the single assumption most worth watching once real data exists.
- **Renewals.** Annual WP plugin renewal runs ~50-70%, so steady-state needs
  continuous new sales, not just a one-time cohort.
- **Review rejection** is a real possibility and costs weeks, not money.
- **The niche is contested.** "We're Open!" and "Business Hours Indicator"
  already exist and are free. The differentiator is the schema and multi-location
  work, not the hours table — which is exactly why the paid tier sits there.
- **If it underperforms**, the failure mode is cheap: $0/mo burn, and the
  schedule and schema engine are reusable for a different niche.

## What this does not do

It does not make money this week, and it is not a guarantee. It is a zero-opex
asset placed in a channel that does the selling, with a break-even of seven
customers. That is the honest shape of it.
