import { localParts } from '../intent/working-hours.js';

/**
 * Quiet hours in the founder's own time zone (brief §9's Alerts, §12's assumptions).
 *
 * "Quiet hours follow the founder's timezone (assume 22:00 to 08:00, as a setting);
 * held alerts go out in the morning."
 *
 * Two things make this more than an hour comparison. The window WRAPS — 22:00 to
 * 08:00 is not a range in the arithmetic sense — and the founder's day is a local
 * day, so "at most 10 a day" has to be counted in their zone and not in UTC. Both
 * answers are pure functions of an instant and a zone name, so no clock is read
 * (CLAUDE.md rule 9).
 */

export interface QuietHours {
  /** Local hour the quiet window opens, inclusive. */
  startHour: number;
  /** Local hour it closes, exclusive. This is also when held alerts go out. */
  endHour: number;
}

/** Brief §12's flagged assumption. A project setting overrides it. */
export const DEFAULT_QUIET_HOURS: QuietHours = { startHour: 22, endHour: 8 };

/**
 * Is this instant inside the founder's quiet hours?
 *
 * The window wraps midnight, which is the normal case: 22:00–08:00 means "late or
 * early", not an empty range. `startHour === endHour` means the whole day is quiet,
 * which is a legitimate way for a founder to say "feed only, never ping me".
 */
export function inQuietHours(at: Date, timeZone: string, quiet: QuietHours): boolean {
  const { hour } = localParts(at, timeZone);
  if (quiet.startHour === quiet.endHour) return true;
  if (quiet.startHour < quiet.endHour) {
    return hour >= quiet.startHour && hour < quiet.endHour;
  }
  return hour >= quiet.startHour || hour < quiet.endHour;
}

/** How far ahead `nextMorning` will look before giving up. */
const MORNING_SEARCH_HOURS = 48;

/**
 * The next instant at which quiet hours are over — when a held alert goes out.
 *
 * Found by stepping hour by hour rather than by adding a fixed offset, because the
 * offset is not fixed: the night a zone leaves daylight saving is 25 hours long, and
 * an alert held at 23:00 that night must still go out at 08:00 and not at 07:00.
 *
 * It lands somewhere inside the morning hour rather than exactly on it — in a zone
 * whose offset is not a whole number of hours, local 08:00 falls at :30 or :45 past
 * a UTC hour. "Held until the morning" is satisfied by 08:30; being late by
 * under an hour is not a thing a founder can see, and pretending to minute precision
 * here would be precision we do not have.
 */
export function nextMorning(at: Date, timeZone: string, quiet: QuietHours): Date {
  if (quiet.startHour === quiet.endHour) {
    // Always quiet: there is no morning to wait for, so nothing is ever held.
    return at;
  }

  // Start at the top of the next UTC hour, so the answer is never in the past.
  const start = Math.ceil(at.getTime() / 3_600_000) * 3_600_000;
  for (let step = 0; step < MORNING_SEARCH_HOURS; step++) {
    const candidate = new Date(start + step * 3_600_000);
    if (!inQuietHours(candidate, timeZone, quiet)) return candidate;
  }
  // Unreachable for any real zone and window; returning `at` means "send it".
  return at;
}

/**
 * The founder's local calendar day as a `YYYY-MM-DD` string.
 *
 * This is the key the 10-a-day cap counts against. A UTC day would cut a founder in
 * Auckland's day in half at lunchtime, so they would get ten alerts before noon and
 * ten more after it.
 */
export function localDayKey(at: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA formats as YYYY-MM-DD, which sorts and compares as a date.
  return formatter.format(at);
}

/** The local weekday of an instant, 0 = Sunday. Used by the Monday report. */
export function localWeekday(at: Date, timeZone: string): number {
  return localParts(at, timeZone).weekday;
}

/** The local hour of an instant, 0–23. */
export function localHour(at: Date, timeZone: string): number {
  return localParts(at, timeZone).hour;
}

/**
 * The founder's zone offset at an instant, in milliseconds.
 *
 * Read back out of `Intl` rather than from a table: a formatted local wall clock,
 * reinterpreted as if it were UTC, differs from the real instant by exactly the
 * offset. It is the one way to get a zone's offset — daylight saving, half-hour
 * zones, historical changes and all — without shipping a copy of the tz database.
 */
function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at);

  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asIfUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour') % 24,
    read('minute'),
    read('second'),
  );
  // The instant's own milliseconds are not in the parts, so compare at second precision.
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * Local midnight at the start of the founder's day containing `at`.
 *
 * This is the lower bound of the 10-a-day cap's window. The offset is resolved
 * twice: once at `at`, and again at the midnight that first answer implies, because
 * on the night a zone changes offset the two differ and the first answer would be an
 * hour out.
 */
export function startOfLocalDay(at: Date, timeZone: string): Date {
  const offset = offsetMs(at, timeZone);
  const localMidnight = Math.floor((at.getTime() + offset) / 86_400_000) * 86_400_000;
  const utc = localMidnight - offset;
  const offsetThen = offsetMs(new Date(utc), timeZone);
  return new Date(offsetThen === offset ? utc : localMidnight - offsetThen);
}
