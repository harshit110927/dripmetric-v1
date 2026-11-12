# SEO / AEO / GEO audit — the landing page

**Target** `https://dripmetric.com/` — `apps/site/src/app/page.tsx`, built from the tree on
`claude/peaceful-lovelace-3ew2h9`.
**Status** `audit-only`. Nothing in this document has been implemented.
**Audited** 12 November 2026. Evidence: a local production build (`next build`, 10/10 pages
prerendered), the rendered `/.next/server/app/index.html`, live HTTP checks against
`dripmetric.com`, the npm registry, and dated search observations.
**Owner** Dripmetric (hello@dripmetric.com).

## Verdict

The page is better built than most funded SaaS landing pages. One `<h1>`, a clean
`h1 → h2 → h3 → h4` outline, 3,596 words of substantive copy, a 9.3 KB JSON-LD graph that
parses and whose every price and FAQ answer is verified against the visible text by
`pnpm site:check`, no invented ratings, every number sourced or measured, and a Markdown
mirror of every page. The craft is not the problem.

The problem is that none of it is reachable, the brand currently means the opposite of what
the page says, and the page is written in a vocabulary nobody searches.

Three findings dominate. Everything else is small by comparison.

---

## A. Blocker — the page is not live, and the canonical URL redirects to a different product

Measured 12 Nov 2026:

| URL                                     | Result                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `https://dripmetric.com/`               | **307** → `https://www.dripmetric.com/`                                       |
| `https://www.dripmetric.com/`           | 200, title _"Automate SaaS Onboarding Emails & Track Drop-Off \| Dripmetric"_ |
| `https://www.dripmetric.com/llms.txt`   | 404                                                                           |
| `https://www.dripmetric.com/index.md`   | 404                                                                           |
| `https://www.dripmetric.com/robots.txt` | 200, `Sitemap: https://www.dripmetric.com/sitemap.xml`                        |

Every v2 canonical, every `<loc>` in `sitemap.xml`, and every JSON-LD `@id` points at
`https://dripmetric.com/` — a URL that today issues a **temporary** redirect to a host
serving the v1 drip-email product. Meanwhile `www` is the host with the live `robots.txt`
and `sitemap.xml`, so `www` is what search engines currently treat as the site.

Consequences, in order:

1. **No v2 finding in this document can rank or be cited until the domain serves v2.** Treat
   every item below as latent: correct in the repository, absent from the web.
2. A 307 is explicitly _not_ a consolidation signal. Link equity and whatever history the
   apex has accumulated are not being passed to `www`, and `www` is not being passed back.
3. `LAUNCH.md` §2 already specifies the fix (apex primary, `www` → apex at 308). It is
   unticked, and this audit confirms it is still unticked.

**Severity: critical.** It gates everything.

---

## B. Critical — entity contamination: the brand currently means "drip email tool"

Every corpus a search or answer engine can ground on describes Dripmetric as the opposite
of what the landing page claims.

- **npm registry, `dripmetric@2.1.1`** (latest; modified 18 Jun 2026):
  description _"Official SDK for Dripmetric — track user onboarding and automate drip
  emails"_, keywords `["onboarding","drip email","saas","analytics"]`.
- **The live site** (above): _"…automatically sends drip emails to bring them back."_
- **A plain web search for "Dripmetric"** on 12 Nov 2026 returned no official site at all.
  The only on-topic result was a third-party npm mirror
  ([pkgstats](https://www.pkgstats.com/pkg:dripmetric)) repeating the v1 README. Everything
  else was a different company — DripJobs, Drip the email platform, Drips Network, drmetrix.

The landing page says, in its own FAQ, _"Does Dripmetric email or nudge my users? No."_
An answer engine reconciling that against three older, mutually corroborating sources
saying the reverse will favour the corroborated claim or hedge. This is the single hardest
thing on the list to undo, because a wrong fact that has been repeated is sticky.

Compounding it, the entity has nothing to anchor to:

- **`sameAs` is empty.** `src/lib/structured-data.ts` deliberately omits it until there are
  profiles the company controls. That reasoning is sound, but the effect is an
  `Organization` node with no link to any corroborating profile anywhere — the single
  largest structured-data gap on the site for entity resolution.
- **No `Person` node, no founder, no `/about`.** For a product whose entire pitch is
  "transparent rules you can read", there is no named human accountable for any of it.
- **The name fights the positioning.** "Drip" is an established email brand. The name pulls
  toward email in exactly the direction the v1 corpus already points.

**Severity: critical.** `LAUNCH.md` §4 covers the rewrite everywhere; it is unticked.

---

## C. Critical — the page is written in a private vocabulary that has no search demand

Dripmetric names each concept in its own words. Those words are good product writing and
poor demand capture, because the market searches for something else.

| The page says            | What people actually search                                   | Who owns that SERP today                                                |
| ------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| "revenue-leak detection" | funnel drop-off, trial conversion, revenue **leakage**        | ThriveStack, indie makers; billing-side vendors (Ordway, getmonetizely) |
| "buying-intent score"    | **PQL**, product qualified lead, lead scoring                 | productled.com, Paddle, Hightouch, Clearbit, Chameleon, ProfitWell      |
| "the nine leaks"         | checkout abandonment, onboarding drop-off, trial ended unpaid | Userpilot, Sprig, Mouseflow, payproglobal                               |
| "Observe layer"          | (nothing)                                                     | —                                                                       |

Two dated observations behind that table:

- Searching _"how to find where trial users drop off before paying SaaS"_ (12 Nov 2026) —
  arguably Dripmetric's most on-point query — returned a synthesised answer naming
  **Mixpanel, Amplitude, Userpilot, Mouseflow and OWOX BI** as the tooling. Dripmetric was
  absent, which is expected pre-launch, but so was any page that would have made it
  present.
- Searching _"revenue leak detection tool SaaS signup funnel"_ returned mostly unverified
  vendor marketing and indie launches. ThriveStack holds the "growth leak" cluster; the
  phrase "revenue leakage" is held by billing and RevOps vendors who mean something
  different by it (mis-billing, not funnel drop-off).

The consequence shows up in the title tag:

```
Dripmetric — Revenue-leak detection for self-serve SaaS
```

Brand first, then an invented category. For a brand with existing demand that is correct.
For a brand with _negative_ demand — where the brand name currently retrieves a different
product — it captures nothing. `content/inventory.json` already knows the mapping: the
`/buying-intent` entry describes it as _"The 0-100 buying-intent (PQL) score"_. The page
title is _"How the buying-intent score works"_. The PQL demand is identified and then not
claimed.

**Severity: critical**, and the cheapest of the three to fix, because it is a wording change
over pages that already exist.

---

## D. Important — the extractable structure is in the Markdown copy, not the HTML

This is the sharpest on-page finding, and it is backwards.

The rendered HTML's thirteen `<h2>`s are editorial:

> "Revenue rarely leaks loudly." · "Nine leaks, each a rule you can read." · "Know who
> looked ready to buy — and why." · "A dollar figure, at your own price." · "Eight
> questions, answered in your own words." · "Built for the gap between your analytics and
> your billing." · "Private by default. Never in your users' way."

Not one matches a query. Meanwhile `public/index.md` — the copy generated for AI clients —
uses **"What is Dripmetric?"**, **"What counts as a revenue leak?"**, **"The nine leaks"**,
**"How it works"**.

So the question-shaped, passage-extractable structure went into the format with no
confirmed consumer, and the HTML that Google indexes — and that AI Overviews, AI Mode and
ChatGPT search actually retrieve — got the poetry. Section headings are a primary signal
for which passage answers which question. Thirteen of them are currently spent on voice.

The page's twelve FAQ `<h3>`s _are_ query-shaped and genuinely excellent — self-contained
first sentences, qualification after, restated verbatim in the JSON-LD. They are also
roughly 90% of the way down a 3,596-word page, below all thirteen editorial `h2`s.

**Severity: important.** Fixable without touching a word of body copy: the voice line can
become the deck and a question-shaped heading can sit above it.

---

## E. Important — zero images on the page

`<img>` count in the rendered landing page: **0**.

- `max-image-preview:large` is set in `robots` metadata and is **inert** — there is no
  in-page image to preview.
- There is **no product screenshot anywhere on the site**. "What does it actually look
  like" is a top pre-signup question, and review sites, directories and listicle authors
  need a screenshot to include you at all.
- The hero's funnel and alert "proof" is built from CSS and DOM. Beautiful, instant, and
  invisible to every surface that wants an image.
- `public/og.png` (1200×630, 90 KB, verified by `pnpm site:check`) exists but is only a
  social card.

The image-search and Discover surface is nil, and the multimodal surface — increasingly how
answer engines present product comparisons — has nothing to pick up.

**Severity: important.**

## F. Important — the hero's main proof is hidden from the accessibility tree

`apps/site/src/components/home/hero.tsx`:

```tsx
<div className="card funnel-card" aria-hidden="true">
```

That hides the entire funnel — _Signed up 1,240 → Verified 1,018 → Connected a data source
431 (−58% · biggest leak) → Activated 352 → Started checkout 97 → Paid 61_ — from the
accessibility tree. Crawlers read the DOM, so Google sees it. But:

- screen-reader users get only the caption, _"Sample alert and funnel · simulated data"_;
- agent clients that navigate by accessibility tree lose the single clearest illustration of
  what the product does.

The sibling alert card is **not** `aria-hidden`, so the inconsistency is almost certainly
unintentional. There are 9 `aria-hidden="true"` occurrences on the page; the decorative ones
(dots, band labels, SVG) are correct.

**Severity: important** (accessibility first, agent readability second).

---

## G. Important — authority is zero, and the citation evidence says that is what decides AI answers

Dripmetric has no backlinks, no reviews, no directory listings and no third-party mentions
of v2. Research dated to 2026 says this, not on-page work, is what governs whether a product
appears in an AI answer:

- Listicle URLs were **14.1%** of citations on recommendation prompts versus **1.6%** on
  factual ones ([Paradigm, AI Search Citation Study 2026](https://paradigmmedianetworks.com/ai-search-citation-study-2026/)).
- Brand homepages were **3.2%** of citations (Paradigm); a separate study put a brand's own
  site at **3.7%** against **16.9%** for its named competitors
  ([Agenzy, 2026](https://www.agenzy.lt/blog/which-sources-ai-engines-cite-2026)).
- For AI Overviews, YouTube was the top source at **22.9%** and Reddit next at **18.5%**
  (Ahrefs, Sept 2026, via [Contently](https://contently.com/2026/04/29/top-sources-llms-cite/)).
- Methods and prompt sets differ between these studies and the percentages range widely —
  read the direction, not the decimals.

My own live check agrees with the direction. _"Best PostHog alternatives for small SaaS
2026"_ (12 Nov 2026) returned cut-the-saas, Tiny Startups, usermaven, vemetric, techjockey,
betterstack, toolradar, saas-alternatives and Amplitude's own comparison. The answer set is
**third-party listicles**. A flawless `/compare/posthog` page does not put you in that
answer; being named in those listicles does.

**So the highest-leverage GEO work is off-site, and the landing page cannot do it.**
`LAUNCH.md` §5 covers this well and is unticked.

---

## H. Moderate — the `.md` corpus relies on a header the static export cannot send

The Markdown mirror is honest, complete and cheap to maintain. Two real caveats:

**1. Canonicalisation is lost on a static host.** `next.config.ts` attaches
`Link: <…>; rel="canonical"` and `Content-Type: text/markdown; charset=utf-8` to every
`.md` path — but only in the default build. Under `output: 'export'` (which
`tools/export.mjs` sets for GitHub Pages) Next does not support `headers()`, and the config
drops them. On a static host the eight `.md` files become near-duplicates of the eight HTML
pages **with no canonical signal of their own**. Partly mitigated — the HTML pages carry
absolute canonicals to `dripmetric.com` — but the `.md` files themselves carry nothing, and
their content type is whatever the host guesses.

**2. Expect little from `llms.txt` itself.** Ahrefs found **97% of `llms.txt` files received
zero AI requests** in May 2026 across 137,000 domains; Google states `llms.txt` is not
required for Search and has said it has no plans to support it; OpenAI's and Anthropic's
crawler docs point to `robots.txt`. The clearest real consumers are IDE agents. Worth
noting on the other side: Amplitude's `.md` comparison URLs _did_ surface in my live search
results, so Markdown copies are not worthless.

Keep the corpus — it is cheap, truthful and has a maintenance owner. Do not model any
traffic on it.

**Severity: moderate** (fix the canonical gap; reset expectations).

---

## I. Moderate — the link graph and page inventory are too thin to own the topic

- **36** total `<a>` on the landing page; **13** unique internal destinations; **3** external.
- **8** published pages for a topic spanning onboarding, activation, trials, checkout, PQLs,
  churn, payments and product analytics.
- No hub pages, no glossary, no `/alternatives`, no `/about`, no `/security`, no changelog.
- Only three outbound citations (Userpilot, Recurly, PostHog docs). The leak rules, the
  intent model and the SDK promises are entirely self-asserted. They are _verifiable from
  the code_, which is unusual and good — but nothing external corroborates them.

**Severity: moderate**, and it is the main constraint on query coverage (see
`query-strategy.md`).

---

## J. Moderate — the page ships ~191 KB gzipped to say it is lightweight

First-load for `/`, measured from the production build:

| Asset                 | Gzipped     |
| --------------------- | ----------- |
| JavaScript (8 chunks) | 181,834 B   |
| CSS (1 file)          | 9,323 B     |
| **Total**             | **~191 KB** |

Uncompressed JS is 585,882 B. The page is fully prerendered and the LCP element is text with
a preloaded font, so LCP should be strong; the cost lands on INP, hydration and mobile data.
Six client components (`reveal-on-scroll`, `mobile-cta`, `revenue-calculator`,
`founding-seat-link`, `code-tabs`, `signup-form`) pull in the full React runtime.

Worth noting because of what the page claims three sections later: _"5,018 bytes gzipped for
the browser core… Never blocks rendering."_ The audience is developers who will open
DevTools. A marketing page 36× the weight of the SDK it is advertising is a credibility
detail, not just a metric.

**Severity: moderate.**

---

## K. Minor — correct, verified, and worth a line each

- **Canonical trailing slash.** Renders as `https://dripmetric.com` (no slash);
  `inventory.json` and `sitemap.xml` use `https://dripmetric.com/`. Identical per RFC 3986
  and Google normalises them, so this is cosmetic — but nothing in `check.mjs` enforces
  consistency.
- **Duplicate `noindex`.** `_not-found.html` emits `<meta name="robots" content="noindex">`
  twice. Harmless, untidy.
- **`dateModified` is hand-maintained.** `SITE.updated = '2026-11-08'` feeds `dateModified`
  on every page from one constant. It will go stale silently; nothing fails when it does.
- **No `priceValidUntil`.** The copy says the launch price holds for anyone starting by
  30 June 2027; the `Offer` nodes do not say so.
- **`og:locale` is `en_US`, `<html lang="en">`.** Inconsistent, harmless.
- **All authorship is the `Organization`.** `TechArticle` nodes name the org as `author`;
  there is no `Person` anywhere.
- **`FAQPage` kept after Google dropped FAQ rich results (7 May 2026).** Correctly reasoned
  in a code comment: it earns nothing there, describes the page accurately, costs nothing.
- **Hreflang: genuinely not applicable.** One locale, no declared market plans.
- **404 handling is correct.** `noindex`, real 404 status, useful recovery copy.
- **`robots.txt` is correct.** Allows every crawler including `OAI-SearchBot`,
  `Claude-SearchBot` and `PerplexityBot`; points at the sitemap.

---

## What is already right, and should not be touched

Worth stating explicitly so none of it gets "optimised" away:

1. **Every number is measured, sourced and dated**, and `pnpm site:check` fails the build if
   a leak rule, an intent point or a catalog event in the code stops matching the page.
   This is rarer than it sounds and it is the foundation of citation-worthiness.
2. **No invented ratings.** `SoftwareApplication` ships without `aggregateRating` because
   there are no real reviews. Correct, and it stays correct.
3. **Simulated data is labelled** every time it appears.
4. **The FAQ answers are genuinely answer-ready** — first sentence answers, remainder
   qualifies, no marketing preamble.
5. **Competitor treatment is fair and dated** — neutral "built for" wording, a trademark
   note, PostHog's revenue-analytics beta status stated with its date and a link to
   PostHog's own docs.
6. **Prerendered, no third-party scripts, self-hosted fonts.** The privacy promise is kept
   by the marketing site itself.

---

## Limitations of this audit

- **The target is unpublished code.** It was audited from a local production build plus live
  checks of the domain. No crawl, render test or Core Web Vitals field data of the live v2
  page exists, because there is no live v2 page.
- **No first-party search data.** No Google Search Console or Bing Webmaster Tools property;
  the site ships no analytics by design. There is no conventional baseline and one cannot be
  manufactured.
- **No AI-visibility baseline.** A pre-launch brand whose name retrieves a different product
  cannot be meaningfully baselined. The 20-prompt corpus in `LAUNCH.md` §7 is the right
  instrument; it should be run from the day the domain switches so there is a real "before".
- **Search observations are single-run and dated 12 November 2026.** Answer engines vary
  between runs. These are observations, not measurements, and they are not evidence of
  ranking, retrieval or citation.
- **Third-party citation percentages come from vendor and tracker studies** with different
  prompt sets and definitions. Direction is reliable; individual figures are not.
- No ranking, citation, mention or traffic outcome is promised anywhere in this document.
