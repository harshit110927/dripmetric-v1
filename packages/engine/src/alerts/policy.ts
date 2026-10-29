import { LEAK_DEFINITIONS_BY_TYPE, type LeakSubjectKind, type LeakType } from '../leaks/types.js';
import { suppressed, type SubjectGuards } from '../leaks/rules.js';
import { inQuietHours, nextMorning, type QuietHours } from './quiet-hours.js';

/**
 * Who gets told what, and when (brief §9's Alerts).
 *
 *   - Never alert about someone who already paid, was deleted or opted out.
 *   - At most 10 instant alerts a day; the rest wait in the feed and the weekly report.
 *   - Quiet hours follow the founder's timezone; held alerts go out in the morning.
 *   - Step-collapse alerts are unmasked and keep their minimum-volume check.
 *
 * A pure decision, separate from the delivery, for two reasons. It is the part with
 * rules in it, so it is the part worth testing without a database or an HTTP client.
 * And the guards are re-checked HERE rather than trusted from when the leak was
 * recorded: a last-moment drop found on Monday for someone who paid on Tuesday must
 * not be sent on Wednesday, and the only way to know that is to look again now.
 */

/** A recorded leak waiting to be told to someone. */
export interface AlertCandidate {
  /** The `leak_instances` row this is about. */
  leakInstanceId: string;
  leakType: LeakType;
  subjectKind: LeakSubjectKind;
  subjectKey: number;
  /** When the leak became true, which is what the alert shows. */
  firedAt: Date;
}

/** Where an alert goes. Every candidate gets exactly one of these. */
export type AlertRoute =
  /** To the channel now, and to the feed. */
  | 'send'
  /** To the feed now, to the channel when quiet hours end. */
  | 'hold'
  /** To the feed only — over the cap, no channel, or a leak that never pings. */
  | 'feed-only'
  /** Nowhere: they paid, were deleted or opted out. */
  | 'drop';

export interface AlertDecision {
  candidate: AlertCandidate;
  route: AlertRoute;
  /** Set only for `hold`: when the channel post is due. */
  holdUntil: Date | null;
  /** Whether the channel post may name the person (brief §8.3: step collapse may). */
  masked: boolean;
  /** Why, in the founder's own words. Shown in the feed and kept in the delivery log. */
  because: string;
}

export type AlertChannel = 'slack' | 'discord' | 'email-digest' | 'none';

export interface AlertPolicyInput {
  /** Oldest first: the cap spends itself on the leaks that fired first. */
  candidates: readonly AlertCandidate[];
  /** The channel the founder installed (settled decision 5). */
  channel: AlertChannel;
  timeZone: string;
  quietHours: QuietHours;
  /**
   * Instant alerts already sent to a channel in the founder's local day.
   *
   * Sent, not decided: an alert held overnight is counted on the day it goes out,
   * because the cap is about how often a founder's phone buzzes.
   */
  sentToday: number;
  /** `instant_alerts_per_day` from the plan. Brief §9: 10. */
  cap: number;
  /** The three guards, looked up again now, per subject key. Steps have no guards. */
  guards: ReadonlyMap<number, SubjectGuards>;
  now: Date;
}

export interface AlertPlan {
  decisions: AlertDecision[];
  /** How many will post to a channel now. */
  sending: number;
  /** How many are waiting for the morning. */
  held: number;
  /** How many went to the feed only, and how many of those were the cap's doing. */
  feedOnly: number;
  overCap: number;
  dropped: number;
}

/**
 * Brief §9: "At most 10 instant alerts a day; the rest wait in the feed and the
 * weekly report." The plan carries the number so a founder on a different plan gets
 * a different cap without this file knowing about plans.
 */
export const DEFAULT_ALERTS_PER_DAY = 10;

export function decideAlerts(input: AlertPolicyInput): AlertPlan {
  const plan: AlertPlan = {
    decisions: [],
    sending: 0,
    held: 0,
    feedOnly: 0,
    overCap: 0,
    dropped: 0,
  };

  /*
   * The cap's remaining room, spent as the loop goes.
   *
   * A held alert spends a slot too. It is going to arrive, and if it did not count
   * here then a quiet night would let a founder wake up to thirty posts — which is
   * exactly the thing the cap exists to prevent.
   */
  let room = Math.max(0, input.cap - input.sentToday);
  const channelLive = input.channel === 'slack' || input.channel === 'discord';

  for (const candidate of input.candidates) {
    const definition = LEAK_DEFINITIONS_BY_TYPE.get(candidate.leakType);
    const masked = definition?.masked ?? true;

    // 1. The three guards, re-checked now. A step has no guards to check.
    if (candidate.subjectKind !== 'step') {
      const guards = input.guards.get(candidate.subjectKey);
      if (!guards || suppressed(guards, { ignorePaid: definition?.aboutPayers === true })) {
        plan.decisions.push({
          candidate,
          route: 'drop',
          holdUntil: null,
          masked,
          because: reasonForDrop(guards),
        });
        plan.dropped++;
        continue;
      }
    }

    // 2. Leaks that are counts rather than pings (brief §8.3): the stall, the
    //    quick-exit rate and the cancellations. They belong in the feed, the
    //    dashboard and the weekly report, and nowhere else.
    if (definition?.alerts !== true) {
      plan.decisions.push({
        candidate,
        route: 'feed-only',
        holdUntil: null,
        masked,
        because: 'This leak is a count in the weekly report, not a ping.',
      });
      plan.feedOnly++;
      continue;
    }

    // 3. No channel installed. The founder still has the feed, and a daily digest
    //    if they chose one (brief §9: "Founders with neither chat app get one email
    //    digest a day, only on days with alerts").
    if (!channelLive) {
      plan.decisions.push({
        candidate,
        route: 'feed-only',
        holdUntil: null,
        masked,
        because:
          input.channel === 'email-digest'
            ? 'Waiting for today’s email digest. Connect Slack or Discord for instant alerts.'
            : 'No alert channel is connected, so this is in the feed only.',
      });
      plan.feedOnly++;
      continue;
    }

    // 4. The cap.
    if (room <= 0) {
      plan.decisions.push({
        candidate,
        route: 'feed-only',
        holdUntil: null,
        masked,
        because: `That is ${input.cap} alerts today, which is the daily limit. The rest are here and in the weekly report.`,
      });
      plan.feedOnly++;
      plan.overCap++;
      continue;
    }
    room--;

    // 5. Quiet hours.
    if (inQuietHours(input.now, input.timeZone, input.quietHours)) {
      const holdUntil = nextMorning(input.now, input.timeZone, input.quietHours);
      plan.decisions.push({
        candidate,
        route: 'hold',
        holdUntil,
        masked,
        because: `Your quiet hours run ${twoDigits(input.quietHours.startHour)}:00 to ${twoDigits(input.quietHours.endHour)}:00, so this goes out in the morning.`,
      });
      plan.held++;
      continue;
    }

    plan.decisions.push({
      candidate,
      route: 'send',
      holdUntil: null,
      masked,
      because: 'Sent to your alert channel.',
    });
    plan.sending++;
  }

  return plan;
}

/**
 * The reason a candidate was dropped, said plainly.
 *
 * Dropped is not an error and it is not a silence to hide: a founder looking at the
 * delivery log should be able to see that the alert was deliberately not sent, and
 * why. A missing guard row means the person is gone from the database entirely,
 * which is the same answer.
 */
function reasonForDrop(guards: SubjectGuards | undefined): string {
  if (!guards) return 'This person is no longer in your data.';
  if (guards.deletedAt !== null) return 'They asked to be deleted, so we never alert about them.';
  if (guards.optedOut) return 'They opted out of tracking, so we never alert about them.';
  return 'They have paid since this leak was found, so there is nothing to chase.';
}

function twoDigits(hour: number): string {
  return String(hour).padStart(2, '0');
}
