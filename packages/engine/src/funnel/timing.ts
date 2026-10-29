/**
 * Per-user, per-step timing (brief §8.1).
 *
 * "For every user and step, record when they entered, when they completed, active
 * time, the gap to the next step, attempts and visits (separate sessions spent on
 * the step), and time to value (Activated minus Signed Up, elapsed and active)."
 *
 * The facts come from `user_step_state`, which ingest keeps order-insensitively
 * (earliest entered, earliest completed). Everything here is derived from them and
 * from `now`, which is always a parameter (CLAUDE.md rule 9).
 */

export type StepImportance = 'key' | 'normal' | 'optional';

export interface StepDefinition {
  stepId: number;
  position: number;
  /** The founder's own name for the step, shown everywhere. */
  label: string;
  importance: StepImportance;
  /** "under 2 minutes": flags users who take longer. Optional. */
  expectedSeconds: number | null;
  /** Overrides the stall default for this step (settled decision 8). */
  stallOverrideSeconds: number | null;
}

/** One row of `user_step_state`, as the engine sees it. */
export interface StepStateFact {
  userKey: number;
  stepId: number;
  firstEnteredAt: Date | null;
  firstCompletedAt: Date | null;
  attempts: number;
  /** Separate sessions spent on this step. */
  visits: number;
  activeSeconds: number;
  lastEventAt: Date | null;
}

export interface StepTiming {
  userKey: number;
  stepId: number;
  enteredAt: Date | null;
  completedAt: Date | null;
  /** Wall-clock seconds from entering to completing. Null until completed. */
  elapsedSeconds: number | null;
  /** Seconds the person was actually doing something. */
  activeSeconds: number;
  attempts: number;
  visits: number;
  /** Seconds from completing this step to entering the next one. Null at the end. */
  gapSeconds: number | null;
  /**
   * Seconds since they last did anything on this step, as of `now`. Null when they
   * have completed it: a finished step cannot go quiet.
   */
  idleSeconds: number | null;
  /** Seconds they have been on an unfinished step, as of `now`. */
  waitingSeconds: number | null;
  completed: boolean;
  /**
   * Whether this person reached the step at all.
   *
   * Not the same as "entered at a known time". A step defined by a canonical event —
   * `Signed Up`, `Activated` — has no entry event of its own: the only thing that
   * arrives is the completion. Those people reached the step and finished it, and we
   * simply do not know when they started, so `enteredAt` is null and
   * `elapsedSeconds` stays null while `reached` is true.
   *
   * Filtering a step's population on `enteredAt` instead read 0 people entered
   * against 166 completions, and the drop-off came out negative.
   */
  reached: boolean;
}

export function secondsBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 1000;
}

/**
 * Turns one person's step rows into timings.
 *
 * The gap to the next step needs the step AFTER this one, so this takes a whole
 * person at a time rather than a row at a time. Steps are ordered by position, not
 * by when they happened: a person who goes back to an earlier step has not changed
 * the funnel's shape.
 */
export function timingsForUser(
  facts: readonly StepStateFact[],
  steps: readonly StepDefinition[],
  now: Date,
): StepTiming[] {
  const byStep = new Map(facts.map((fact) => [fact.stepId, fact]));
  const ordered = [...steps].sort((a, b) => a.position - b.position);

  return ordered.map((step, index) => {
    const fact = byStep.get(step.stepId);
    const enteredAt = fact?.firstEnteredAt ?? null;
    const completedAt = fact?.firstCompletedAt ?? null;

    // The gap is measured to the next step the person actually entered, which may be
    // several positions along if they skipped the ones between.
    let gapSeconds: number | null = null;
    if (completedAt !== null) {
      for (let next = index + 1; next < ordered.length; next++) {
        const nextEntered = byStep.get(ordered[next]!.stepId)?.firstEnteredAt ?? null;
        if (nextEntered !== null) {
          gapSeconds = Math.max(0, secondsBetween(completedAt, nextEntered));
          break;
        }
      }
    }

    const lastEventAt = fact?.lastEventAt ?? enteredAt;

    return {
      userKey: fact?.userKey ?? -1,
      stepId: step.stepId,
      enteredAt,
      completedAt,
      elapsedSeconds:
        enteredAt !== null && completedAt !== null
          ? Math.max(0, secondsBetween(enteredAt, completedAt))
          : null,
      activeSeconds: fact?.activeSeconds ?? 0,
      attempts: fact?.attempts ?? 0,
      visits: fact?.visits ?? 0,
      gapSeconds,
      idleSeconds:
        completedAt === null && lastEventAt !== null
          ? Math.max(0, secondsBetween(lastEventAt, now))
          : null,
      waitingSeconds:
        completedAt === null && enteredAt !== null
          ? Math.max(0, secondsBetween(enteredAt, now))
          : null,
      completed: completedAt !== null,
      reached: enteredAt !== null || completedAt !== null,
    };
  });
}

export interface TimeToValue {
  /** Wall-clock seconds from Signed Up to Activated. Null until both exist. */
  elapsedSeconds: number | null;
  /** Seconds actually spent in the product on the way there. */
  activeSeconds: number;
}

/**
 * Time to value: "Activated minus Signed Up, elapsed and active" (brief §8.1).
 *
 * The active figure is the sum of active time across the steps, not wall-clock
 * elapsed, because a person who signs up on Friday and activates on Monday did not
 * spend the weekend using the product.
 */
export function timeToValue(
  signedUpAt: Date | null,
  activatedAt: Date | null,
  timings: readonly StepTiming[],
): TimeToValue {
  const activeSeconds = timings.reduce((sum, timing) => sum + timing.activeSeconds, 0);
  if (signedUpAt === null || activatedAt === null) return { elapsedSeconds: null, activeSeconds };
  return {
    elapsedSeconds: Math.max(0, secondsBetween(signedUpAt, activatedAt)),
    activeSeconds,
  };
}
