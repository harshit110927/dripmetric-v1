# Action plan — SEO / AEO / GEO

**Status** `awaiting-approval`. Nothing here has been implemented.
**Created** 12 November 2026.
**Decision owner** Dripmetric (hello@dripmetric.com).
**Evidence** `audit-landing-page.md`; sequencing rationale in `query-strategy.md`.

## Authorization state

Three separate grants. None has been given.

| Phase              | State              | What it would cover                          |
| ------------------ | ------------------ | -------------------------------------------- |
| Implementation     | **not authorized** | Editing files in `apps/site`                 |
| Release            | **not authorized** | Deploying, switching the domain              |
| Provider operation | **not authorized** | Search Console / Bing / IndexNow submissions |

`LAUNCH.md` already owns every step that needs the founder's accounts, domain or money.
This plan does **not** restate those. It covers what can be changed in the repository, plus
the two blockers that gate all of it.

## Gate 0 — blockers that make everything else inert

Neither is a code change. Both are in `LAUNCH.md` and both are unticked.

| #   | Action                                                                                  | Owner            | Why it gates everything                                                                                                             |
| --- | --------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 0.1 | Make apex primary, `www` → apex at **308**; serve v2                                    | founder (Vercel) | `dripmetric.com` currently 307s to a v1 drip-email site. Every v2 canonical, `<loc>` and JSON-LD `@id` points at that URL. Audit §A |
| 0.2 | Publish SDK v2 to npm, deprecate `<3.0.0`, rewrite the package description and keywords | founder (npm)    | `dripmetric@2.1.1` is the only thing search engines can currently ground on, and it says "automate drip emails". Audit §B           |

**Do not start Tier 1 content work before 0.1 and 0.2 are scheduled.** Publishing more pages
that canonicalise to a redirecting URL compounds nothing.

---

## Tier 1 — code changes, high ratio, low risk

All are inside `apps/site`. Each lists its own acceptance check. All are reversible by
`git revert`.

### 1.1 Question-shaped section headings on the landing page

**Files** `src/components/ui/section-head.tsx`, `src/components/home/*.tsx`
**Finding** Audit §D — the thirteen body `<h2>`s are editorial; the Markdown mirror already
uses the question-shaped versions.
**Change** Add a question-shaped `<h2>`; demote the current voice line to the deck beneath
it. Reuse the headings already in `content/index.body.md` so HTML and Markdown converge
rather than diverge. No body copy changes.
**Acceptance** `pnpm site:check` passes; outline stays one `h1` + nested `h2`/`h3`/`h4`; the
rendered `h2` set matches `index.body.md`'s.
**Risk** Low. Visual change to section headers — needs a design look.
**Rollback** `git revert`.

### 1.2 Retitle and reframe `/buying-intent` around PQL

**Files** `content/pages/buying-intent.md`, `content/inventory.json`, `src/content/pages.ts`
**Finding** Strategy §1.2 — the best concrete answer to a large, well-served query family is
published under a title that captures none of it. `inventory.json` already calls it the
"buying-intent (PQL) score".
**Change** Title and H1 to carry both terms, e.g. _"Product-qualified lead scoring for
self-serve SaaS: how the buying-intent score works"_. Add a short "PQL vs buying intent"
section. Keep "buying-intent score" as the product's own term throughout.
**Acceptance** `pnpm site:markdown` regenerated; `pnpm site:check` passes (it verifies every
intent point still matches `packages/engine/src/intent/points.ts`); description 70–160 chars.
**Risk** Low. **Caveat:** this is a title change on a page with no impressions yet, so there
is no baseline to regress against — which is also why now is the cheapest time to do it.
**Rollback** `git revert`.

### 1.3 Un-hide the hero funnel from the accessibility tree

**File** `src/components/home/hero.tsx`
**Finding** Audit §F — `aria-hidden="true"` on the funnel card hides the page's clearest
proof from screen readers and accessibility-tree agents. The sibling alert card is not
hidden, so it looks unintentional.
**Change** Remove `aria-hidden` from `.funnel-card`; keep it on genuinely decorative nodes
(dots, band labels, SVG). The `<ol>` already carries labels and numbers, and the
`<figcaption>` already says the data is simulated.
**Acceptance** The funnel's labels and numbers appear in the accessibility tree; the
"simulated data" caption is still announced.
**Risk** Very low.

### 1.4 Fix the `.md` canonical gap on static hosts

**Files** `next.config.ts`, `tools/build-markdown.mjs`, `tools/export.mjs`
**Finding** Audit §H — `Link: rel="canonical"` and `Content-Type: text/markdown` are
attached in `headers()`, which Next drops under `output: 'export'`. On GitHub Pages the
eight `.md` files are near-duplicates with no canonical signal of their own.
**Change** The `Canonical:` line already present in each `.md` body is for humans and
models, not crawlers. Either (a) stop publishing `.md` from the static export, or (b) keep
them and accept they are uncanonicalised on that host, documented in `apps/site/README.md`.
Since `LAUNCH.md` §2 makes Vercel the production target and GitHub Pages a preview only,
**(b) plus a documented note is proportionate** — but it should be a recorded decision, not
an accident.
**Acceptance** `apps/site/README.md` states which host sends which headers; `pnpm site:check`
gains an assertion that every published `.md` has a `Link` header rule in `next.config.ts`.
**Risk** Low.

### 1.5 Add `priceValidUntil`; derive `dateModified`

**Files** `src/lib/structured-data.ts`, `src/content/site.ts`
**Finding** Audit §K. The copy says the launch price holds for anyone starting by 30 June
2027; the `Offer` nodes do not. `SITE.updated` is one hand-maintained constant feeding
`dateModified` on all eight pages.
**Change** Add `priceValidUntil: '2027-06-30'` to the launch-price offers. Either derive
`updated` per page from `inventory.json`'s `updated_at` (already per-page) or add a check
that fails when it drifts from the newest `updated_at`.
**Acceptance** JSON-LD parses; `pnpm site:check` passes; each page's `dateModified` matches
its own `inventory.json` entry.
**Risk** Low.

---

## Tier 2 — needs a product decision or design work

| #   | Action                                                         | Blocked on                                                                                                  | Finding              |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------- |
| 2.1 | Put a real product screenshot on the landing page and `/leaks` | A dashboard worth screenshotting, and whether to show simulated data in it (must stay labelled)             | Audit §E             |
| 2.2 | Rewrite the landing-page title around demand                   | Founder's call on leading with problem vs brand; ideally validated against first Search Console impressions | Strategy, on-page §2 |
| 2.3 | `/about` with a named founder + a `Person` node                | Founder's willingness to be the named face                                                                  | Audit §B             |
| 2.4 | `sameAs` on `Organization`                                     | Profiles existing first (`LAUNCH.md` §4)                                                                    | Audit §B             |
| 2.5 | Reduce first-load JS below ~100 KB gzipped                     | Whether scroll-reveal and code-tabs justify ~182 KB gz on a page that advertises a 5 KB SDK                 | Audit §J             |

## Tier 3 — new pages, in this order

Each follows the existing recipe: a file in `content/pages`, a row in `content/inventory.json`,
an entry in `src/content/pages.ts`, then `pnpm site:markdown`, `pnpm site:check`, and
`pnpm site:indexnow --submit /new-path` after release.

1. `/compare/mixpanel` and `/compare/amplitude` — dated and sourced like the PostHog page
2. `/alternatives` — hub linking all three
3. `/no-billing-integration` — the provider-neutral family; the most uncontested demand found
4. `/about` — entity and E-E-A-T (also 2.3)
5. `/guides/time-to-first-value`
6. `/guides/involuntary-churn` — detection framing only, never recovery
7. `/changelog` — once there are real releases
8. Own aggregated benchmark report — the highest-ceiling asset; needs consented production data

## Explicitly not recommended

- **No `aggregateRating` or `Review` markup** until real reviews exist. Currently correct;
  keep it correct.
- **No eight thin per-stack landing pages.** `/docs` covers eight stacks well. Splitting
  them without real per-stack substance is the programmatic-SEO failure mode.
- **No crawler-blocking rules** in `robots.txt`. It currently allows `OAI-SearchBot`,
  `Claude-SearchBot` and `PerplexityBot`. Blocking training crawlers (`GPTBot`, `ClaudeBot`,
  `Google-Extended`) is a legitimate founder choice but it also means future models know
  less about Dripmetric — relevant given audit §B.
- **No expansion of the `.md` corpus** beyond keeping existing pages in sync. 97% of
  `llms.txt` files got zero AI requests in May 2026; Google says it is not required for
  Search. Keep what exists because it is cheap and truthful; do not invest further.
- **No "revenue leak" head-term campaign.** Strategy §1.6 — keep it as positioning, do not
  rely on it for discovery.
- **No title/meta churn without data.** Rewrite a title when a page has impressions and no
  clicks, not on a hunch.

## Closeout states

| State                       | Reached when                                                       |
| --------------------------- | ------------------------------------------------------------------ |
| `implemented-locally`       | Tier 1 merged and `pnpm ready` green                               |
| `delivered-and-verified`    | v2 served at apex and the `LAUNCH.md` §2.5 table passes live       |
| `provider-outcome-pending`  | Sitemap and IndexNow submitted — proves acceptance, not indexing   |
| `provider-outcome-observed` | Search Console impressions and a dated run of the §7 prompt corpus |

No ranking, citation, mention or traffic outcome is promised.
