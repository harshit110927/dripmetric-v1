import { percentile, internalMedian } from '../funnel/stats.js';
import { PRICING_ATTENTION_SECONDS, PRICING_VIEWS_FOR_OWN_THRESHOLD } from './points.js';

/**
 * The pricing-page patterns (brief §8.2, "Pricing quick exit").
 *
 * "Someone who opens pricing, glances and leaves is different from someone who
 * studies the plans." Four readings of the same page view, and the difference
 * between them decides whether it is a leak, a speed problem or buying intent.
 *
 * Pure: the view's facts and the product's own thresholds in, a pattern out.
 */

export const PRICING_PATTERNS = [
  'quick-exit',
  'slow-page',
  'deliberation',
  're-checking',
  'none',
] as const;
export type PricingPattern = (typeof PRICING_PATTERNS)[number];

/** Brief §8.2: "the session ends within 2 minutes". */
export const QUICK_EXIT_SESSION_END_SECONDS = 120;
/** Brief §8.2: "the page loaded in under 4 seconds" / "took over 4 seconds to appear". */
export const SLOW_PAGE_MS = 4_000;
/** Brief §8.2: "a second visit of 10 seconds or more within 7 days". */
export const SECOND_VISIT_WINDOW_DAYS = 7;
export const SECOND_VISIT_MIN_SECONDS = 10;

export interface PricingViewFact {
  at: Date;
  /** Active seconds on the page: the time they were actually there. */
  activeSeconds: number;
  /**
   * How long the main content took, in milliseconds. Null when this was not a full
   * page load — brief §8.2: "the speed check applies only to full page loads", so a
   * client-side route change can never be blamed on the server.
   */
  pageSpeedMs: number | null;
  /** The annual/monthly toggle: someone comparing totals. */
  toggledInterval: boolean;
  clickedPlan: boolean;
  openedFaq: boolean;
  /**
   * Seconds from this view to the end of their session, or null when the session is
   * still open. "Still open" is not "left quickly".
   */
  sessionEndedAfterSeconds: number | null;
  /** Pricing views this person had BEFORE this one. */
  previousViews: number;
  /** When they last saw pricing, for the second-visit rule. */
  previousViewAt: Date | null;
}

export interface PricingThresholds {
  /**
   * The attention bar. Ten seconds until the product has 50 pricing views of its
   * own, then its 25th percentile (brief §8.2).
   */
  attentionSeconds: number;
  /** The product's median active time on pricing. Null until there is data. */
  medianActiveSeconds: number | null;
  /** How many pricing views the product has had. */
  views: number;
  /** True once the attention bar is the product's own rather than the default. */
  ownThreshold: boolean;
}

/**
 * The product's own thresholds.
 *
 * "The 10-second default becomes the product's own 25th percentile once 50 pricing
 * views exist." A product whose pricing page is a single price and a button is read
 * in four seconds; one with five plans and a comparison table is not. Judging both
 * against ten seconds would call half of one product's users uninterested.
 */
export function pricingThresholds(activeSecondsSamples: readonly number[]): PricingThresholds {
  const views = activeSecondsSamples.length;
  const sorted = [...activeSecondsSamples].sort((a, b) => a - b);
  const ownThreshold = views >= PRICING_VIEWS_FOR_OWN_THRESHOLD;

  return {
    attentionSeconds: ownThreshold
      ? (percentile(sorted, 0.25) ?? PRICING_ATTENTION_SECONDS)
      : PRICING_ATTENTION_SECONDS,
    medianActiveSeconds: internalMedian(sorted),
    views,
    ownThreshold,
  };
}

export interface PricingReading {
  pattern: PricingPattern;
  /** The plain sentence, for a timeline and for the leak list. */
  says: string;
  /** True when this view earns the +10 deliberation signal. */
  deliberation: boolean;
  /** True when this view counts towards the quick-exit leak rate. */
  countsAsLeak: boolean;
  /** True when this is a speed problem rather than a price problem. */
  speedProblem: boolean;
}

/**
 * Which of the four patterns this view is.
 *
 * The order is the point. Deliberation signals are checked FIRST, because someone who
 * clicked a plan and then closed the tab in eight seconds was comparing, not
 * glancing — and the quick-exit rule's own wording ("no toggle or plan click") says
 * so. Then the slow page, because blaming the price for a page that never appeared is
 * the single most expensive mistake this rule could make.
 */
export function classifyPricingView(
  view: PricingViewFact,
  thresholds: PricingThresholds,
): PricingReading {
  const interacted = view.toggledInterval || view.clickedPlan || view.openedFaq;

  // --- Deliberation (brief §8.2) ---------------------------------------------
  if (interacted) {
    return {
      pattern: 'deliberation',
      says: 'They compared the plans rather than glancing at the price.',
      deliberation: true,
      countsAsLeak: false,
      speedProblem: false,
    };
  }

  if (
    thresholds.medianActiveSeconds !== null &&
    view.activeSeconds > thresholds.medianActiveSeconds
  ) {
    return {
      pattern: 'deliberation',
      says: 'They spent longer on your pricing page than most people do.',
      deliberation: true,
      countsAsLeak: false,
      speedProblem: false,
    };
  }

  if (isSecondVisitWithinWindow(view)) {
    return {
      pattern: 'deliberation',
      says: 'They came back to the pricing page within a week and read it properly.',
      deliberation: true,
      countsAsLeak: false,
      speedProblem: false,
    };
  }

  const glanced = view.activeSeconds < thresholds.attentionSeconds;

  // --- The first-ever view that ends the session (brief §8.2) ------------------
  const endedSession =
    view.sessionEndedAfterSeconds !== null &&
    view.sessionEndedAfterSeconds <= QUICK_EXIT_SESSION_END_SECONDS;

  if (view.previousViews === 0 && glanced && endedSession) {
    /*
     * "The same exit, but the main content took over 4 seconds to appear | The page
     * failed, not the price."
     */
    if (view.pageSpeedMs !== null && view.pageSpeedMs > SLOW_PAGE_MS) {
      return {
        pattern: 'slow-page',
        says: `Your pricing page took ${(view.pageSpeedMs / 1000).toFixed(1)} seconds to appear and they left. That is a speed problem, not a price problem.`,
        deliberation: false,
        countsAsLeak: false,
        speedProblem: true,
      };
    }

    return {
      pattern: 'quick-exit',
      says: 'They opened your pricing page, glanced at it and left.',
      deliberation: false,
      countsAsLeak: true,
      speedProblem: false,
    };
  }

  // --- Re-checking (brief §8.2): "already knows the price" ---------------------
  if (view.previousViews > 0 && glanced) {
    return {
      pattern: 're-checking',
      says: 'They looked the price up again. They already know it.',
      deliberation: false,
      countsAsLeak: false,
      speedProblem: false,
    };
  }

  return {
    pattern: 'none',
    says: 'They looked at the pricing page.',
    deliberation: false,
    countsAsLeak: false,
    speedProblem: false,
  };
}

function isSecondVisitWithinWindow(view: PricingViewFact): boolean {
  if (view.previousViews === 0 || view.previousViewAt === null) return false;
  if (view.activeSeconds < SECOND_VISIT_MIN_SECONDS) return false;
  const days = (view.at.getTime() - view.previousViewAt.getTime()) / 86_400_000;
  return days >= 0 && days <= SECOND_VISIT_WINDOW_DAYS;
}

/**
 * The quick-exit rate (brief §8.2: "counted in the leak rate").
 *
 * Anonymous visitors count in the rate but never in money — brief §8.2's last line —
 * so the caller separates them and only the rate sees both.
 */
export function quickExitRate(readings: readonly PricingReading[]): number | null {
  if (readings.length === 0) return null;
  return readings.filter((reading) => reading.countsAsLeak).length / readings.length;
}
