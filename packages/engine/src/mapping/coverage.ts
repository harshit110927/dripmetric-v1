import { CATALOG_EVENTS, type Priority } from '@dripmetric/catalog';

/**
 * The coverage checklist (brief Appendix B).
 *
 * Founders do not send everything, and the honest answer to "why is this number
 * empty?" is almost always "because that event is not arriving". So the checklist
 * is not a nag screen: it is the explanation. Every module that can be switched off
 * by a missing event says so here, in the founder's words, with the event to send.
 *
 * Pure: the set of arriving names in, the checklist out. The caller loads the set.
 */

/** Appendix B's three tiers, best first. */
export const PRIORITY_ORDER: readonly Priority[] = ['must', 'should', 'could'];

/** How much of the score each tier carries. `must` dominates, by design. */
const TIER_WEIGHT: Record<Priority, number> = { must: 5, should: 2, could: 1 };

export interface CoverageInput {
  /**
   * The canonical meanings that are actually arriving: a name the founder has
   * confirmed, or a catalog name sent verbatim, with at least one event behind it.
   * A mapped name with no events is not coverage.
   */
  arriving: ReadonlySet<string>;
  /** Names still waiting in the Inbox. They count toward nothing (decision 10). */
  unmappedCount: number;
}

export interface CoverageItem {
  name: string;
  priority: Priority;
  arriving: boolean;
  /** Brief Appendix A's "job": why we collect it. Shown next to the event name. */
  job: string;
}

export interface CoverageTier {
  priority: Priority;
  total: number;
  arrivingCount: number;
  missing: CoverageItem[];
}

export interface SwitchedOff {
  /** What the founder loses, in their words. */
  metric: string;
  /** One sentence: which events are missing. */
  because: string;
  missing: string[];
}

export interface Coverage {
  items: CoverageItem[];
  tiers: CoverageTier[];
  /** 0–100, weighted so a missing `must` event hurts five times a missing `could`. */
  score: number;
  /** Every module that is off, and why. Empty is the goal. */
  switchedOff: SwitchedOff[];
  /** Settled decision 9: no paid event means no revenue numbers at all. */
  paidEventArriving: boolean;
  unmappedCount: number;
}

/**
 * What each module needs before it can show a number.
 *
 * Encoded here rather than remembered (CLAUDE.md rule 11), because these are the
 * sentences a founder reads when a screen is empty, and a wrong one is worse than
 * no sentence at all.
 */
interface Requirement {
  metric: string;
  /** Every one of these must arrive. */
  all?: readonly string[];
  /** At least one of these must arrive. */
  any?: readonly string[];
}

export const METRIC_REQUIREMENTS: readonly Requirement[] = [
  // brief §8.1: the funnel starts at Signed Up and is drawn from step state.
  { metric: 'The signup-to-paid funnel', all: ['Signed Up'] },
  // brief §8.1: time on a step needs a page entered and a page left.
  { metric: 'How long each step takes', all: ['Page Viewed', 'Page Left'] },
  // brief §8.1, settled decision 8: a stall is a step entered and not completed.
  {
    metric: 'Where people stall',
    any: ['Onboarding Step Viewed', 'Onboarding Step Completed'],
  },
  // brief §8.2: the pricing quick exit is a pricing view with a short active time.
  { metric: 'The pricing quick exit', all: ['Pricing Viewed', 'Page Left'] },
  // brief §8.1: activation is the line between trying and using.
  { metric: 'Who reaches activation', all: ['Activated'] },
  // brief §8.2: the upgrade moment is the limit they hit before they paid.
  { metric: 'The upgrade moment', all: ['Plan Limit Reached'] },
  // brief §8.2: checkout started and not finished.
  { metric: 'Abandoned checkouts', all: ['Checkout Started'] },
  /*
   * There is deliberately no "failed payments" entry.
   *
   * `Payment Failed` arrives "after at least one payment" (Appendix A), so it is
   * churn, not a leak between a first visit and a first payment. It carries no
   * checklist priority for that reason, and a requirement naming it would have put
   * a permanently-off metric on the founder's screen with no event that could ever
   * turn it on. Recovery is a later layer.
   */
  // settled decision 9: both of these are off until a paid event arrives.
  { metric: "Intent but didn't pay", all: ['Subscription Started'] },
  { metric: 'Potential revenue', all: ['Subscription Started'] },
  // brief §8.1: a team product's funnel runs through the invite.
  { metric: 'Team invites', all: ['Invite Sent'] },
];

/** Settled decision 9. Setup cannot finish without it, and revenue stays off. */
export const PAID_EVENT = 'Subscription Started';

export function coverage(input: CoverageInput): Coverage {
  const items: CoverageItem[] = CATALOG_EVENTS.filter(
    (event): event is typeof event & { priority: Priority } => event.priority !== undefined,
  ).map((event) => ({
    name: event.name,
    priority: event.priority,
    arriving: input.arriving.has(event.name),
    job: event.job,
  }));

  const tiers: CoverageTier[] = PRIORITY_ORDER.map((priority) => {
    const inTier = items.filter((item) => item.priority === priority);
    return {
      priority,
      total: inTier.length,
      arrivingCount: inTier.filter((item) => item.arriving).length,
      missing: inTier.filter((item) => !item.arriving),
    };
  });

  let earned = 0;
  let possible = 0;
  for (const tier of tiers) {
    earned += tier.arrivingCount * TIER_WEIGHT[tier.priority];
    possible += tier.total * TIER_WEIGHT[tier.priority];
  }

  const switchedOff: SwitchedOff[] = [];
  for (const requirement of METRIC_REQUIREMENTS) {
    const missing = (requirement.all ?? []).filter((name) => !input.arriving.has(name));
    const anyMissing =
      requirement.any !== undefined && !requirement.any.some((name) => input.arriving.has(name));

    if (missing.length === 0 && !anyMissing) continue;

    const needed = anyMissing ? [...(requirement.any ?? [])] : missing;
    switchedOff.push({
      metric: requirement.metric,
      because: anyMissing
        ? `We are not getting ${listOf(needed, 'or')}, so this is off.`
        : `We are not getting ${listOf(needed, 'and')}, so this is off.`,
      missing: needed,
    });
  }

  return {
    items,
    tiers,
    score: possible === 0 ? 0 : Math.round((earned / possible) * 100),
    switchedOff,
    paidEventArriving: input.arriving.has(PAID_EVENT),
    unmappedCount: input.unmappedCount,
  };
}

/** "A", "A and B", "A, B and C" — a founder reads this sentence, not a JSON array. */
function listOf(names: readonly string[], joiner: 'and' | 'or'): string {
  const quoted = names.map((name) => `"${name}"`);
  if (quoted.length <= 1) return quoted[0] ?? '';
  return `${quoted.slice(0, -1).join(', ')} ${joiner} ${quoted[quoted.length - 1]}`;
}
