/**
 * Working hours in the founder's own time zone (brief §8.2's fit points, §12).
 *
 * "Signed up in working hours on a weekday" is a fit point, and brief §12 says to use
 * IANA zones and handle daylight saving. A UTC hour is the wrong question: 09:00 in
 * Berlin is 08:00 UTC in winter and 07:00 UTC in summer, and a founder whose users
 * all sign up at 9am local would see that fit point appear and disappear twice a year.
 *
 * `Intl.DateTimeFormat` does the zone arithmetic, including the DST rules, and it is
 * a pure function of the instant and the zone — no clock is read (CLAUDE.md rule 9).
 */

export interface WorkingHours {
  /** Local hour the day starts, inclusive. */
  startHour: number;
  /** Local hour it ends, exclusive. */
  endHour: number;
  /** Days of the week it applies to, 0 = Sunday, as `Date.getUTCDay` numbers them. */
  days: readonly number[];
}

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  // Brief §12's flagged assumption: Mon–Fri 09:00–18:00 local.
  startHour: 9,
  endHour: 18,
  days: [1, 2, 3, 4, 5],
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** The local hour and weekday of an instant, in an IANA zone. */
export function localParts(at: Date, timeZone: string): { hour: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
  });

  let hour = 0;
  let weekday = 0;
  for (const part of formatter.formatToParts(at)) {
    // '24' appears for midnight in some runtimes; it means hour 0 of the next day.
    if (part.type === 'hour') hour = Number(part.value) % 24;
    if (part.type === 'weekday') weekday = WEEKDAY_INDEX[part.value] ?? 0;
  }
  return { hour, weekday };
}

export function inWorkingHours(
  at: Date,
  timeZone: string,
  hours: WorkingHours = DEFAULT_WORKING_HOURS,
): boolean {
  const { hour, weekday } = localParts(at, timeZone);
  if (!hours.days.includes(weekday)) return false;
  return hour >= hours.startHour && hour < hours.endHour;
}
