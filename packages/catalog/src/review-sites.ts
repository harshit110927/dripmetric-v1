/**
 * Review and comparison sites (brief §8.2, the brand-search approximation).
 *
 * "Brand search can only be approximated, because referrers hide search terms. Match
 * the project's brand terms against `utm_term`, and match the referrer against a
 * list of review and comparison sites (G2, Capterra and similar, kept in config).
 * Say so in the docs."
 *
 * So this is an approximation, by design and by necessity: a search engine sends the
 * referrer without the query, so "they searched for us by name" is not observable.
 * What IS observable is arriving from a site people only visit when they are
 * comparing tools, which is the same intent arriving by a different road.
 *
 * Config rather than code: a founder in a niche has their own comparison sites, and
 * the list is matched by registrable domain so a country subdomain works too.
 */
export const REVIEW_SITE_DOMAINS: readonly string[] = [
  'g2.com',
  'capterra.com',
  'getapp.com',
  'softwareadvice.com',
  'trustradius.com',
  'gartner.com',
  'alternativeto.net',
  'producthunt.com',
  'slant.co',
  'saasworthy.com',
  'sourceforge.net',
  'crozdesk.com',
  'softwaresuggest.com',
  'tekpon.com',
];

const REVIEW_SITE_SET: ReadonlySet<string> = new Set(REVIEW_SITE_DOMAINS);

/**
 * Whether a referrer domain is a review or comparison site.
 *
 * Matches the domain and any subdomain of it, so `www.g2.com` and `uk.capterra.com`
 * both count, while `notg2.com` does not.
 */
export function isReviewSite(
  referrerDomain: string | null | undefined,
  extraDomains: readonly string[] = [],
): boolean {
  if (!referrerDomain) return false;
  const domain = referrerDomain.toLowerCase().replace(/^www\./, '');
  if (REVIEW_SITE_SET.has(domain)) return true;
  if (extraDomains.some((extra) => matches(domain, extra))) return true;
  return REVIEW_SITE_DOMAINS.some((known) => domain.endsWith(`.${known}`));
}

function matches(domain: string, candidate: string): boolean {
  const lower = candidate.toLowerCase().replace(/^www\./, '');
  return domain === lower || domain.endsWith(`.${lower}`);
}

/**
 * Whether a campaign term looks like a search for the product by name.
 *
 * The founder's own brand terms, matched case-insensitively against `utm_term` — the
 * one place a search term does survive, because the founder's own ads put it there.
 */
export function isBrandSearch(
  utmTerm: string | null | undefined,
  brandTerms: readonly string[],
): boolean {
  if (!utmTerm || brandTerms.length === 0) return false;
  const term = utmTerm.toLowerCase();
  return brandTerms.some((brand) => brand.length > 1 && term.includes(brand.toLowerCase()));
}
