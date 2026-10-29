import {
  ACCOUNT_ACTIVE_MEMBERS_BONUS,
  ACCOUNT_ACTIVE_MEMBERS_REQUIRED,
  bandOf,
  MAX_SCORE,
  type IntentBand,
} from './points.js';

/**
 * Account-level intent (brief §8.2, B2B accounts).
 *
 * "An account's score is its highest member's score, plus 10 when two or more members
 * were active that week."
 *
 * The highest member, not the average: one person at an account deciding to buy is
 * the account deciding to buy, and averaging them with four colleagues who logged in
 * once would hide exactly the signal that matters.
 */

export interface AccountMemberFact {
  userKey: number;
  score: number;
  /** Did they do anything in the last seven days? */
  activeThisWeek: boolean;
}

export interface AccountScore {
  score: number;
  band: IntentBand;
  /** The member the score came from. */
  topMemberKey: number | null;
  topMemberScore: number;
  activeMembers: number;
  /** 10 when two or more members were active this week, else 0. */
  teamBonus: number;
  members: number;
  explanation: string;
}

export function scoreAccount(members: readonly AccountMemberFact[]): AccountScore {
  if (members.length === 0) {
    return {
      score: 0,
      band: 'low',
      topMemberKey: null,
      topMemberScore: 0,
      activeMembers: 0,
      teamBonus: 0,
      members: 0,
      explanation: 'Nobody at this account has done anything yet.',
    };
  }

  const top = members.reduce((best, member) => (member.score > best.score ? member : best));
  const activeMembers = members.filter((member) => member.activeThisWeek).length;
  const teamBonus =
    activeMembers >= ACCOUNT_ACTIVE_MEMBERS_REQUIRED ? ACCOUNT_ACTIVE_MEMBERS_BONUS : 0;

  const score = Math.min(MAX_SCORE, top.score + teamBonus);

  return {
    score,
    band: bandOf(score),
    topMemberKey: top.userKey,
    topMemberScore: top.score,
    activeMembers,
    teamBonus,
    members: members.length,
    explanation:
      teamBonus > 0
        ? `Their keenest person is at ${top.score}, and ${activeMembers} people there have been active this week (+${teamBonus}).`
        : `Their keenest person is at ${top.score}.`,
  };
}
