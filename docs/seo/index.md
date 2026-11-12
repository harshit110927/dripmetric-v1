# SEO / AEO / GEO work index

**Request** A deep SEO, GEO and AEO audit of the Dripmetric landing page: the weak points,
and the full strategy for ranking and being named in answers across the topics around this
product.
**Mode** Broad, read-only. Audit, research and planning only — **no implementation
authorized**.
**Run** 12 November 2026, on `claude/peaceful-lovelace-3ew2h9`.
**Target** `https://dripmetric.com/` — `apps/site/src/app/page.tsx`.
**Owner** Dripmetric (hello@dripmetric.com).

## Documents

| Document                                       | Status            | What it holds                                                                                |
| ---------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------- |
| [audit-landing-page.md](audit-landing-page.md) | completed         | Findings A–K with evidence, plus what is already right and the audit's limitations           |
| [query-strategy.md](query-strategy.md)         | completed         | Two-track query ownership map, page inventory now vs needed, measurement instruments         |
| [action-plan.md](action-plan.md)               | awaiting-approval | Gate 0 blockers, Tier 1–3 actions with acceptance and rollback, explicit non-recommendations |

Not duplicated here: `apps/site/LAUNCH.md` already owns every step needing the founder's
accounts, domain, money or decisions. This work verified its open items against the live
web rather than restating them.

## Evidence base

- Local production build: `next build`, 10/10 pages prerendered, exit 0.
- Rendered `apps/site/.next/server/app/index.html` — 151,188 bytes, 3,596 visible words,
  1 `h1` / 13 `h2` / 24 `h3` / 9 `h4`, 36 links (13 unique internal, 3 external),
  0 `<img>`, one JSON-LD block of 9,313 bytes carrying `Organization`, `WebSite`,
  `WebPage`, `SoftwareApplication`, `FAQPage`.
- First-load weight: 181,834 B gzipped JS across 8 chunks + 9,323 B gzipped CSS.
- `pnpm site:check` — PASS (source + rendered).
- Live HTTP checks of `dripmetric.com` and `www.dripmetric.com`, 12 Nov 2026.
- npm registry record for `dripmetric`, 12 Nov 2026.
- Five dated search observations (brand, revenue-leak tools, trial drop-off, PostHog
  alternatives, PQL scoring) and two dated platform-evidence searches (AI citation sources,
  `llms.txt` adoption).

## Headline findings

1. **The page is not live.** `dripmetric.com` 307s to `www`, which serves the v1 drip-email
   site. Every v2 canonical, `<loc>` and JSON-LD `@id` targets a URL that redirects away.
2. **The brand currently means the opposite of what the page says.** npm, the live site and
   the only on-topic search result all describe a drip-email tool. `sameAs` is empty and
   there is no `Person` or `/about`, so nothing anchors the entity.
3. **The vocabulary has no demand.** "Revenue-leak detection", "buying-intent score" and
   "the nine leaks" are good product language; the market searches drop-off, trial
   conversion, PQL and churn.
4. **The extractable structure is in the wrong format.** The HTML's 13 body `h2`s are
   editorial; the Markdown mirror already uses the question-shaped headings.
5. **Authority is zero, and the 2026 citation evidence says that is what decides AI
   answers** — so the highest-leverage work is off-site, which the landing page cannot do.

## 27-skill coverage

| Skill                   | State             | Note                                                                                                                                                         |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `seo`                   | completed         | Router; intake, coverage, synthesis                                                                                                                          |
| `seo-research`          | completed         | Demand families, dated SERP review; no keyword-volume tool available                                                                                         |
| `ai-search-research`    | completed         | Citation-source and `llms.txt` platform evidence, dated. **Limitation:** no pinned multi-engine Research Pack; no engine API access                          |
| `seo-performance`       | blocked           | No GSC/Bing property; site not live; ships no analytics by design. No conventional baseline is possible yet                                                  |
| `ai-visibility-monitor` | blocked           | A pre-launch brand whose name retrieves another product cannot be baselined. One dated observation recorded; `LAUNCH.md` §7 holds the right 20-prompt corpus |
| `seo-audit`             | completed         | Multi-lane, scoped to the landing page plus the 8-page site                                                                                                  |
| `seo-page`              | completed         | The landing page — findings D, E, F, J, K                                                                                                                    |
| `seo-technical`         | completed         | Canonical, redirects, directives, static-export header loss, payload, favicon, 404                                                                           |
| `seo-content`           | completed         | Heading shape, answer readiness, vocabulary mismatch                                                                                                         |
| `seo-schema`            | completed         | 5-type graph verified; gaps are `sameAs`, `Person`, `priceValidUntil`                                                                                        |
| `seo-images`            | completed         | Zero `<img>` **is** the finding; `max-image-preview:large` is inert                                                                                          |
| `seo-sitemap`           | completed         | XML matches inventory exactly; `.md` corpus and maps reviewed                                                                                                |
| `seo-hreflang`          | not-applicable    | One locale (`en`), no declared market plans                                                                                                                  |
| `seo-architecture`      | completed         | 13 unique internal links, 8 pages, no hubs — finding I                                                                                                       |
| `seo-authority`         | completed         | Zero backlinks/mentions; the critical lane, and it is off-site                                                                                               |
| `seo-aeo`               | completed         | FAQ is strong; the 13 body headings are not — finding D                                                                                                      |
| `seo-geo`               | completed         | Entity contamination, empty `sameAs`, citation suitability — finding B                                                                                       |
| `seo-commerce`          | not-applicable    | No products, catalog or merchant feed; SaaS plans covered as `Offer` under schema                                                                            |
| `seo-local`             | not-applicable    | No locations, service areas or local intent                                                                                                                  |
| `seo-video`             | blocked           | Zero video. Not irrelevant — YouTube was the top AI-Overview source in 2026 data. `LAUNCH.md` §5 plans three; blocked on founder production                  |
| `seo-news-discover`     | not-applicable    | Not a publisher; no news surface. Discover is a possible future for the guides, not now                                                                      |
| `seo-agentic`           | completed         | Accessibility-tree gap in the hero (finding F); forms reviewed; no auth on the marketing site                                                                |
| `seo-programmatic`      | deferred-by-owner | Eight per-stack pages are a future option; explicitly not recommended at this scale                                                                          |
| `seo-competitor-pages`  | completed         | 1 of ~4 needed exist; format is good and should be copied                                                                                                    |
| `seo-plan`              | completed         | Tier ordering in `action-plan.md`                                                                                                                            |
| `seo-action-plan`       | completed         | Owners, acceptance, rollback, authorization states                                                                                                           |
| `optimise-seo`          | blocked           | Implementation not authorized by this request                                                                                                                |

## Boundary

Read-only. No files in `apps/site` were changed, nothing was deployed, and no search or
discovery property was touched. The next decision is the founder's: approve Gate 0 and
Tier 1 in `action-plan.md`, or re-scope.
