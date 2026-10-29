/**
 * Week-1 and week-4 retention (brief §9, the Retention module).
 *
 * "Free shows week-1 and week-4 retention; paid adds the full signup-week cohort
 * table." So the free level computes exactly two columns, and the cohort table they
 * come from is built anyway — it is the same scan, and M9 decides what is shown.
 */

/** Brief §9: the two columns the free level shows. */
export const RETENTION_WEEKS = [1, 4] as const;
export type RetentionWeek = (typeof RETENTION_WEEKS)[number];

const WEEK_SECONDS = 7 * 24 * 60 * 60;

export interface CohortUserFact {
  userKey: number;
  signedUpAt: Date;
  /** Every day the person did something, as UTC date strings. */
  activeDays: readonly string[];
}

export interface Cohort {
  /** The Monday of the signup week, as a UTC date string. */
  cohortWeek: string;
  users: number;
  /** Per week offset: how many of them came back during that week. */
  retained: Record<number, number>;
  /** The two the free level shows, as shares. Null while the week is unfinished. */
  week1Rate: number | null;
  week4Rate: number | null;
  /** How many weeks of this cohort have fully elapsed as of `now`. */
  completeWeeks: number;
}

/** The Monday of the week a date falls in, in UTC. */
export function weekStart(date: Date): string {
  const copy = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
  // getUTCDay: 0 is Sunday, so Sunday belongs to the week that began six days earlier.
  const offset = (copy.getUTCDay() + 6) % 7;
  copy.setUTCDate(copy.getUTCDate() - offset);
  return copy.toISOString().slice(0, 10);
}

/**
 * Retention by signup week.
 *
 * "Retained in week N" means the person did something during the Nth week AFTER they
 * signed up — days 7–13 for week 1, days 28–34 for week 4. Not "was still active at
 * any point since", which flatters every cohort and never goes down.
 *
 * A rate is null until the whole week has passed for that cohort. A cohort that
 * signed up yesterday has not failed week 4; it has not reached it, and showing 0%
 * would read as a catastrophe.
 */
export function retentionCohorts(users: readonly CohortUserFact[], now: Date): Cohort[] {
  const byWeek = new Map<string, CohortUserFact[]>();
  for (const user of users) {
    const key = weekStart(user.signedUpAt);
    const list = byWeek.get(key) ?? [];
    list.push(user);
    byWeek.set(key, list);
  }

  const cohorts: Cohort[] = [];

  for (const [cohortWeek, members] of [...byWeek.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const retained: Record<number, number> = {};
    const maxWeek = Math.max(...RETENTION_WEEKS);

    for (let week = 1; week <= maxWeek; week++) {
      retained[week] = members.filter((member) => activeInWeek(member, week)).length;
    }

    // A cohort's week N is complete once N whole weeks have passed since the END of
    // its signup week, which is the latest any of its members signed up.
    const weekEnd = new Date(`${cohortWeek}T00:00:00.000Z`).getTime() + WEEK_SECONDS * 1000;
    const elapsedWeeks = Math.floor((now.getTime() - weekEnd) / (WEEK_SECONDS * 1000));

    cohorts.push({
      cohortWeek,
      users: members.length,
      retained,
      completeWeeks: Math.max(0, elapsedWeeks),
      week1Rate: elapsedWeeks >= 1 ? retained[1]! / members.length : null,
      week4Rate: elapsedWeeks >= 4 ? retained[4]! / members.length : null,
    });
  }

  return cohorts;
}

function activeInWeek(user: CohortUserFact, week: number): boolean {
  const from = user.signedUpAt.getTime() + week * WEEK_SECONDS * 1000;
  const to = from + WEEK_SECONDS * 1000;
  return user.activeDays.some((day) => {
    const at = new Date(`${day}T00:00:00.000Z`).getTime();
    return at >= dayFloor(from) && at < to;
  });
}

/** Active days are whole UTC days, so the window start is floored to its day. */
function dayFloor(ms: number): number {
  return Math.floor(ms / 86_400_000) * 86_400_000;
}
