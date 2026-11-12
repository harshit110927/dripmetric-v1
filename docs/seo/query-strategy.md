# Query strategy — owning the topics around Dripmetric

**Status** `strategy`. No implementation authorized.
**Written** 12 November 2026. Demand and SERP observations are dated and single-run.
**Owner** Dripmetric (hello@dripmetric.com).
**Reads with** `audit-landing-page.md` (findings) and `action-plan.md` (sequencing).

## The honest frame

You asked how to rank and be named in answers for "any and all queries" around this
product. The useful answer has a shape, and it is not "cover every keyword":

1. **No one can promise a ranking or an AI mention.** Anyone who does is guessing. What can
   be engineered is being the clearest, best-sourced, most-retrievable answer to a defined
   set of questions, and being present where answer engines actually look.
2. **Two different games are being played.** "Best tool for X" questions are decided by
   third-party listicles, Reddit and YouTube — brand homepages were ~3.2–3.7% of citations
   in 2026 studies. "How does X work / what is X / how do I calculate X" questions are
   decided by whoever gives the most precise, sourced, extractable answer. **Dripmetric can
   win the second game almost immediately and can only buy its way into the first slowly.**
3. **Your unfair advantage is precision.** The SERPs around this product are full of
   unsourced vendor benchmarks. You have exact rules from your own code, measured numbers,
   and a build that fails when a page stops matching the code. Lead with mechanism, not
   adjectives.
4. **Your binding constraint is not content. It is that the domain serves a different
   product** (`audit-landing-page.md` §A) **and that the brand currently means "drip email
   tool"** (§B). Content work before those are fixed compounds nothing.

## Track structure

Two tracks run concurrently, as required for this kind of goal. Neither replaces the other,
and the easy track must not be allowed to hide the hard one.

- **Track 1 — Category leadership.** High-volume head terms. Slow, authority-bound, mostly
  off-site. Cannot be deferred just because it is hard.
- **Track 2 — Mechanism and long-tail.** Lower volume, high intent, answerable _today_ from
  the code you already have. This is where the first real visibility will come from.

---

# Track 2 first — what you can win now

Listed first because it is where the next ninety days should go.

These queries share three properties: low competition, high purchase intent, and an answer
that Dripmetric can give _exactly_ while competitors give it vaguely. Each is a question
whose precise answer already exists in `packages/engine` or `packages/catalog`.

## 2.1 Mechanism and definition queries — one canonical page each

| Query family                                                    | Owning page                      | What must be true to win                                                                      |
| --------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| "what is an onboarding stall", "onboarding stall definition"    | `/leaks#leak-onboarding-stall`   | A question-shaped heading, a one-sentence definition first, then the exact rule and threshold |
| "what counts as checkout abandonment in SaaS"                   | `/leaks#leak-last-moment-drop`   | Same, plus the 2-hour window and why trial-only checkouts are excluded                        |
| "how to detect a trial that ended unpaid"                       | `/leaks#leak-trial-ended-unpaid` | Same, plus exactly which data it needs                                                        |
| "how do I know which free users are ready to buy"               | `/buying-intent`                 | Full points table, bands, decay — already written, needs the title to say PQL                 |
| "how is a buying intent / PQL score calculated"                 | `/buying-intent`                 | Already the best version of this on the web; it is mis-titled                                 |
| "how to measure time to first value"                            | **new page**                     | Named in `LAUNCH.md` §6. Real demand, no page yet                                             |
| "what is step completion collapse" / statistical drop detection | `/leaks#leak-step-collapse`      | You can show the actual significance test. Nobody else does                                   |

**Why this works:** these are factual, not recommendation, queries. Listicles were only
1.6% of citations on factual prompts versus 14.1% on recommendation prompts. Precision wins
here and precision is what you have.

## 2.2 Integration and stack queries — genuinely uncontested

Dripmetric's "no billing integration" design creates a query set almost nobody serves:

- "funnel analytics without Stripe"
- "Paddle analytics", "Lemon Squeezy analytics", "Chargebee funnel analytics"
- "RevenueCat trial conversion tracking"
- "Razorpay SaaS funnel analytics"
- "track trial conversion without a billing integration"

Every competitor's answer is "connect your Stripe". Yours is "send one event from any
provider". That is a real differentiator with real searches behind it, and the site
currently states it only inside prose on the landing page and `/docs`.

**Recommendation:** one page — `/no-billing-integration` or `/paid-events` — that owns the
whole family, with a short named section per provider. Do **not** build eight thin
per-provider pages; that is a programmatic-SEO trap at this scale.

Also uncontested, and already half-built in `STACKS`: "Next.js SaaS funnel tracking",
"Django trial conversion tracking", "Rails onboarding analytics". `/docs` has snippets for
eight stacks. If those ever become separate pages, they need the
`seo-programmatic` guardrails — real per-stack differences, not a template with the
framework name swapped.

## 2.3 Alerting queries — high intent, almost unserved

- "Slack alert when a trial user goes quiet"
- "alert when checkout is abandoned SaaS"
- "get notified when a payment fails"
- "Discord alerts for product analytics"
- "onboarding drop-off alerts"

These are the queries of someone who has already decided they need this. Currently covered
only as a feature bullet. Worth one page or a prominent, well-headed section.

## 2.4 Privacy-angle queries — small, and nobody serious competes

- "product analytics that doesn't store IP addresses"
- "GDPR-safe product analytics", "analytics without session replay"
- "cookieless funnel analytics"

The site's privacy posture is unusually strong _and verifiable_ (no IP storage, no
fingerprinting, encryption at rest, consent-gated, the marketing site itself ships no
analytics). Small volume, excellent fit, trivially citable.

---

# Track 1 — category leadership (mandatory, slow)

These are the high-volume families. They cannot be dropped because they are hard; difficulty
changes the plan and the timeline, not whether they are targets.

## 1.1 "X alternatives" — the biggest prize, and mostly not won on your own site

**Families:** "PostHog alternatives", "Mixpanel alternatives", "Amplitude alternatives",
"best product analytics for small SaaS", "PostHog vs Mixpanel".

**Observed 12 Nov 2026** for _"best PostHog alternatives for small SaaS 2026"_: the results
were cut-the-saas, Tiny Startups, usermaven, vemetric, techjockey, betterstack, toolradar,
saas-alternatives, prettyinsights and Amplitude's own comparison pages. The named tools were
Mixpanel, Amplitude, Umami, Matomo, OpenReplay, Plausible.

**The lesson:** this answer set is third-party listicles. Your `/compare/posthog` page is
necessary and will not be sufficient. Winning here is two jobs:

- **On-site (you control):** `/compare/posthog` exists and is good. Add **Mixpanel** and
  **Amplitude** (already planned in `LAUNCH.md` §6) and an `/alternatives` hub that links
  them. Keep the dated, sourced, fair-to-the-competitor format — it is why the PostHog page
  is credible.
- **Off-site (the actual lever):** get accurately listed in those listicles and
  directories. `LAUNCH.md` §5 names the right ones — SaaSHub, AlternativeTo, toolradar,
  Tiny Startups, G2, Capterra. The ask to an author is two accurate sentences and a link,
  not a pitch.

**Realistic horizon:** 6–12 months, and it depends more on §5 of `LAUNCH.md` than on
anything in the repository.

## 1.2 PQL / product-qualified leads — the biggest _mismatch_ to fix

**Families:** "product qualified lead", "PQL scoring", "PQL scoring model", "how to score
product qualified leads", "PQL vs MQL".

**Observed 12 Nov 2026:** owned by productled.com, Paddle, Hightouch (three locales),
Clearbit, Chameleon, ProfitWell, factors.ai, dealhub. The consensus advice is "reverse-
engineer your best customers and assign weighted points to events" — and every source
gives it _abstractly_. Conflicting conversion claims abound (5–6× MQL, 2–4× MQL, 25–39%
trial-to-paid), all vendor-sourced.

**Dripmetric already has the concrete version they are all describing:** 14 named signals
with exact points, bands at 30 and 60, weekly decay, a fit-point cap, and a stated rule that
points are approved rather than auto-reweighted. That is the best answer to this query
family on the web right now and it is published under the title _"How the buying-intent
score works"_.

**This is the highest-ratio fix in this document:** retitle and reframe `/buying-intent`
around PQL language while keeping "buying-intent score" as the product's own term. The
page body barely needs to change. `inventory.json` already describes it as the
"buying-intent (PQL) score" — surface that.

## 1.3 Trial-to-paid conversion — already correctly claimed

**Families:** "trial to paid conversion rate", "free trial conversion rate benchmarks",
"how to calculate trial to paid conversion", "does requiring a credit card increase trial
conversion".

`/guides/trial-to-paid-conversion` already owns this intentionally, with 2026 benchmarks,
sources, limits and a formula. Keep it, keep it dated, and re-verify quarterly. This is the
page most likely to earn a link on merit.

## 1.4 Onboarding and funnel drop-off — crowded, winnable on specificity

**Families:** "SaaS onboarding drop-off", "funnel drop-off analysis", "where do trial users
drop off", "activation rate benchmark".

**Observed 12 Nov 2026:** Userpilot, Sprig, Mouseflow, payproglobal, owox, countly,
saasrise. All vendor blogs; the synthesised answer explicitly flagged their thresholds as
"illustrative rather than industry benchmarks".

**The gap:** everyone says "find your drop-off"; nobody gives a named, reproducible rule for
_detecting_ it. You have one, with a significance test. Compete on "here is the exact rule
and threshold", not on "7 reasons trials don't convert".

## 1.5 Churn and failed payments — enter carefully

**Families:** "involuntary churn", "failed payment recovery", "payment failure churn",
"dunning".

The commercial intent here is high and the SERP is owned by recovery vendors (Churnkey,
Churn Buster, Baremetrics Recover, Recurly). Dripmetric **detects and does not recover** —
`LAUNCH.md` §6 already flags that this must be explicit. Enter with the detection framing
only. Claiming recovery language you do not serve is the fastest way to teach an answer
engine something false about you, and §B of the audit shows how expensive that is to undo.

## 1.6 "Revenue leak" / "revenue leakage" — your own category, contested and thin

Two different meanings collide here. **Funnel** revenue leak (your meaning) is held by
ThriveStack's ~26 "growth leak" pages and a crowd of indie launches, mostly with unverified
statistics. **Revenue leakage** in the RevOps/billing sense (mis-billing, under-invoicing)
is held by Ordway, getmonetizely and similar — a different problem entirely.

**Judgement: do not lead with this.** Keep "revenue-leak detection" as the product's
self-description — it is good positioning and it is what the product _is_ — but do not rely
on it for discovery. Demand sits on the symptom words (drop-off, trial conversion, churn,
PQL), not the category word. This is the core of audit finding §C.

---

# The on-page work that applies to every query

Four changes to the landing page that raise its odds across all of the above. All are
implementation, not strategy — see `action-plan.md`.

1. **Give the thirteen body `<h2>`s a question-shaped line and keep the voice as the deck.**
   The Markdown mirror already proves the better headings exist (§D). The pattern:
   `<h2>What counts as a revenue leak?</h2>` with _"Revenue rarely leaks loudly."_ becoming
   the lede beneath it. No body copy changes.
2. **Rewrite the title around demand, keeping the category.** The current title leads with a
   brand that currently retrieves a drip-email package and a category nobody searches.
   Something closer to _"Find where trial signups drop off before they pay — Dripmetric"_
   leads with the problem. Validate against real impressions once Search Console exists;
   do not churn titles on a hunch.
3. **Put a real screenshot on the page** (§E). It also unblocks directory and listicle
   inclusion, which is Track 1's actual lever.
4. **Fill the entity gaps** (§B): `sameAs` once profiles exist, a `Person` node and an
   `/about` page with a named founder. Without these, nothing anchors the entity.

# Page inventory: now vs. needed

| Page                               | Status                   | Query family it owns                    |
| ---------------------------------- | ------------------------ | --------------------------------------- |
| `/`                                | exists                   | brand, category, "what is Dripmetric"   |
| `/leaks`                           | exists                   | the nine mechanism/definition queries   |
| `/buying-intent`                   | exists, **mis-titled**   | PQL / intent scoring                    |
| `/docs`                            | exists                   | install, per-stack, paid events         |
| `/pricing`                         | exists                   | pricing, free plan                      |
| `/guides/trial-to-paid-conversion` | exists                   | trial conversion + benchmarks           |
| `/compare/posthog`                 | exists                   | PostHog alternative                     |
| `/privacy`                         | exists                   | site privacy                            |
| `/compare/mixpanel`                | **needed**               | Mixpanel alternative                    |
| `/compare/amplitude`               | **needed**               | Amplitude alternative                   |
| `/alternatives`                    | **needed**               | hub for the above                       |
| `/about`                           | **needed**               | entity, founder, E-E-A-T                |
| `/no-billing-integration`          | **needed**               | the whole provider-neutral family (2.2) |
| `/guides/time-to-first-value`      | **needed**               | TTFV                                    |
| `/guides/involuntary-churn`        | **needed**               | churn detection, carefully framed       |
| `/changelog`                       | later                    | freshness, once there are real releases |
| benchmark report                   | **the one unique asset** | see below                               |

# The single best long-term asset

Once there is consented production data, **publish your own aggregated benchmark report.**

Every SERP sampled for this strategy is full of vendor benchmarks whose own synthesised
summaries get flagged as unverified. A genuinely sourced, methodologically stated benchmark
from real aggregated data is:

- the thing most likely to earn links and citations, because nobody else can produce it;
- a repeatable annual asset;
- exactly aligned with the one capability you already enforce in CI — numbers that are true.

`LAUNCH.md` §6.6 already identifies this. It is the highest-ceiling item on either track.

# How to know whether any of this worked

Keep these three apart and never blend them into one score.

| Question                   | Instrument                                                                                                | Earliest signal        |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------- |
| Did organic search change? | Search Console + Bing Webmaster Tools                                                                     | 28 days after indexing |
| Did AI answers change?     | The 20-prompt corpus in `LAUNCH.md` §7, monthly, dated, recording engine, mention, cited URL and accuracy | 1–3 months post-launch |
| Did Copilot cite us?       | Bing Webmaster Tools AI Performance report                                                                | weekly once indexed    |

A bot visit is not a citation. An accepted sitemap submission is not indexing. A later
comparison is observational drift, not proof that a change caused it.
