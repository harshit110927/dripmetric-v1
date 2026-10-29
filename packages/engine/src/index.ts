/**
 * Pure engines: event mapping (M5), funnel and timing (M6), intent (M7), leaks (M8).
 *
 * Every function here takes its facts as arguments and does no I/O (CLAUDE.md rule 9).
 * Workers load the facts, call the engine and store the result, so the simulator and
 * the time-travel tests can move the clock themselves. ESLint enforces the no-clock
 * rule for this package.
 */
export {
  scrubSample,
  scrubEventName,
  isPersonalKey,
  looksPersonal,
  valueTypeOf,
  REDACTED,
  MAX_SAMPLE_LENGTH,
  MAX_DISTINCT_FOR_SAMPLE,
} from './mapping/scrub.js';
export type { ScrubResult } from './mapping/scrub.js';

export {
  buildPrompt,
  estimateTokens,
  MAX_NAMES_IN_PROMPT,
  MAX_PROPERTIES_PER_NAME,
} from './mapping/prompt.js';
export type { BuiltPrompt, PromptInput, EventNameFact, PropertyFact } from './mapping/prompt.js';

export { coverage, METRIC_REQUIREMENTS, PRIORITY_ORDER, PAID_EVENT } from './mapping/coverage.js';
export type {
  Coverage,
  CoverageInput,
  CoverageItem,
  CoverageTier,
  SwitchedOff,
} from './mapping/coverage.js';

// --- M6: funnel and timing (brief §8.1) -------------------------------------
export {
  distribution,
  percentile,
  internalMedian,
  rate,
  EMPTY_DISTRIBUTION,
  MIN_COMPLETIONS_FOR_PERCENTILES,
} from './funnel/stats.js';
export type { Distribution } from './funnel/stats.js';

export { timingsForUser, timeToValue, secondsBetween } from './funnel/timing.js';
export type {
  StepDefinition,
  StepImportance,
  StepStateFact,
  StepTiming,
  TimeToValue,
} from './funnel/timing.js';

export {
  thresholdsFor,
  applyFreeze,
  overExpected,
  medianElapsed,
  STUCK_MIN_SECONDS,
  STUCK_MAX_SECONDS,
  STALL_DEFAULT_SECONDS,
} from './funnel/thresholds.js';
export type { StepThresholds, FrozenThresholds } from './funnel/thresholds.js';

export {
  classifyStep,
  isStuck,
  isCooling,
  isSkimmed,
  hours,
  STEP_FLAGS,
} from './funnel/classify.js';
export type { ClassifyInput, Classification, StepFlag } from './funnel/classify.js';

export {
  highlightStep,
  HARD_STEP_DROP_RATIO,
  SAME_RATE_TOLERANCE,
  SLOWEST_SHARE,
  MIN_PER_SIDE_FOR_RATIO,
} from './funnel/highlight.js';
export type { Highlight, HighlightInput, HighlightReason } from './funnel/highlight.js';

export {
  segmentSplits,
  segmentWarnings,
  SEGMENT_DIMENSIONS,
  BUG_COMPLETION_RATIO,
  MIN_USERS_PER_SEGMENT,
} from './funnel/segments.js';
export type {
  SegmentDimension,
  SegmentFact,
  SegmentSplit,
  SegmentWarning,
} from './funnel/segments.js';

export { retentionCohorts, weekStart, RETENTION_WEEKS } from './funnel/cohorts.js';
export type { Cohort, CohortUserFact, RetentionWeek } from './funnel/cohorts.js';

export { funnelReport } from './funnel/funnel.js';
export type { FunnelFacts, FunnelReport, StepFacts, StepReport } from './funnel/funnel.js';

// --- M7: intent (brief §8.2) ------------------------------------------------
export {
  INTENT_POINTS,
  INTENT_POINTS_BY_KEY,
  INTENT_SIGNAL_KEYS,
  INTENT_BANDS,
  FIT_POINT_KEYS,
  FIT_POINT_RULES,
  FIT_POINTS_EACH,
  FIT_POINTS_CAP,
  ZERO_POINT_EVIDENCE,
  bandOf,
  BAND_WARM_FROM,
  BAND_HIGH_FROM,
  HIGH_INTENT_THRESHOLD,
  DECAY_HALF_LIFE_DAYS,
  MAX_SCORE,
  MIN_SCORE,
  PRICE_OBJECTION_DISMISSALS,
  PRICING_ATTENTION_SECONDS,
  PRICING_VIEWS_FOR_OWN_THRESHOLD,
  ACTIVATIONS_FOR_MEDIAN_TTV,
  CORE_ACTION_EARLY_COUNT,
  CORE_ACTION_EARLY_DAYS,
  ACTIVE_DAYS_REQUIRED,
  ACTIVE_DAYS_WINDOW,
  ACCOUNT_ACTIVE_MEMBERS_BONUS,
  ACCOUNT_ACTIVE_MEMBERS_REQUIRED,
} from './intent/points.js';
export type {
  IntentBand,
  IntentSignalKey,
  IntentSignalDefinition,
  FitPointKey,
} from './intent/points.js';

export { scoreIntent, replayPeak, emptyFacts } from './intent/score.js';
export type {
  IntentFacts,
  IntentScore,
  IntentPeak,
  ScoredSignal,
  SignalMoment,
} from './intent/score.js';

export {
  classifyPricingView,
  pricingThresholds,
  quickExitRate,
  PRICING_PATTERNS,
  QUICK_EXIT_SESSION_END_SECONDS,
  SLOW_PAGE_MS,
  SECOND_VISIT_WINDOW_DAYS,
  SECOND_VISIT_MIN_SECONDS,
} from './intent/pricing.js';
export type {
  PricingPattern,
  PricingReading,
  PricingThresholds,
  PricingViewFact,
} from './intent/pricing.js';

export { inWorkingHours, localParts, DEFAULT_WORKING_HOURS } from './intent/working-hours.js';
export type { WorkingHours } from './intent/working-hours.js';

export { scoreAccount } from './intent/accounts.js';
export type { AccountMemberFact, AccountScore } from './intent/accounts.js';

export {
  didntPayGroups,
  potentialRevenue,
  DEFAULT_DIDNT_PAY_WINDOW_DAYS,
} from './intent/didnt-pay.js';
export type { DidntPayCandidate, DidntPayGroups, PotentialRevenue } from './intent/didnt-pay.js';

export {
  calibrate,
  MIN_PAYERS_FOR_CALIBRATION,
  MIN_PER_SIDE_FOR_LIFT,
  LIFT_DISAGREEMENT_RATIO,
} from './intent/calibration.js';
export type {
  Calibration,
  CalibrationUser,
  SignalLift,
  WeightSuggestion,
} from './intent/calibration.js';

// --- M8: leaks (brief §8.3) -------------------------------------------------
export {
  LEAK_TYPES,
  LEAK_SUBJECTS,
  LEAK_REQUIREMENTS,
  LEAK_DEFINITIONS,
  LEAK_DEFINITIONS_BY_TYPE,
  REQUIREMENT_REASONS,
  unavailableLeaks,
  leakIsAvailable,
} from './leaks/types.js';
export type {
  LeakType,
  LeakSubjectKind,
  LeakRequirement,
  LeakDefinition,
  LeakFinding,
  LeakUnavailable,
} from './leaks/types.js';

export {
  poissonCdf,
  collapseTest,
  COLLAPSE_P_THRESHOLD,
  COLLAPSE_MIN_EXPECTED,
  COLLAPSE_WINDOW_HOURS,
  COLLAPSE_BASELINE_DAYS,
} from './leaks/poisson.js';
export type { CollapseTest } from './leaks/poisson.js';

export {
  userLeaks,
  onboardingStalls,
  lastMomentDrop,
  highIntentQuiet,
  trialEndedUnpaid,
  limitReachedNoUpgrade,
  cancelledOrFailed,
  payerGoingQuiet,
  pricingQuickExit,
  stepCollapse,
  suppressed,
  USER_LEAK_TYPES,
  LAST_MOMENT_HOURS,
  WENT_QUIET_DAYS,
  LIMIT_UPGRADE_DAYS,
  PAYER_QUIET_RATIO,
  PAYER_QUIET_WEEKS,
  PAYER_BASELINE_WEEKS,
} from './leaks/rules.js';
export type {
  UserLeakFacts,
  StepLeakFact,
  StepCollapseFact,
  SubjectGuards,
} from './leaks/rules.js';

export { suggestMappings, parseSuggestions, CONFIDENCES, MAX_ATTEMPTS } from './mapping/suggest.js';
export type {
  Ask,
  AskOptions,
  AskResult,
  Confidence,
  Suggestion,
  SuggestOutcome,
} from './mapping/suggest.js';

// --- M10: alerts and reports (brief §9) -------------------------------------
export { formatMoney, plural } from './money.js';

export {
  inQuietHours,
  nextMorning,
  localDayKey,
  localWeekday,
  localHour,
  startOfLocalDay,
  DEFAULT_QUIET_HOURS,
} from './alerts/quiet-hours.js';
export type { QuietHours } from './alerts/quiet-hours.js';

export { decideAlerts, DEFAULT_ALERTS_PER_DAY } from './alerts/policy.js';
export type {
  AlertCandidate,
  AlertChannel,
  AlertDecision,
  AlertPlan,
  AlertPolicyInput,
  AlertRoute,
} from './alerts/policy.js';

export {
  alertContent,
  toSlack,
  toDiscord,
  ALERT_TITLES,
  DISCORD_COLOURS,
  DISCORD_LIMITS,
  SLACK_LIMITS,
  WEBHOOK_USERNAME,
} from './alerts/payload.js';
export type {
  AlertContent,
  AlertFacts,
  AlertField,
  DiscordEmbed,
  DiscordPayload,
  SlackBlock,
  SlackPayload,
} from './alerts/payload.js';

export { weeklyReport, paybackLine, REPORT_PARTS, STARTER_PRICE_MINOR } from './reports/weekly.js';
export type {
  ReportPart,
  ReportPartKey,
  WeeklyReport,
  WeeklyReportFacts,
  WorstStepFact,
} from './reports/weekly.js';

export { digest, DIGEST_ITEM_LIMIT } from './reports/digest.js';
export type { Digest, DigestFacts, DigestItem } from './reports/digest.js';

export {
  compareChange,
  equalWindows,
  MIN_USERS_PER_WINDOW,
  FREE_WINDOW_DAYS_MAX,
} from './reports/changes.js';
export type {
  ChangeComparison,
  ChangeComparisonInput,
  ChangeVerdict,
  ChangeWindow,
  WindowPair,
} from './reports/changes.js';

// --- M11: tracking health (brief §9) ----------------------------------------
export {
  missingEvents,
  shapeDrift,
  doubleSent,
  lateEvents,
  sourceShareCollapse,
  FINDING_KINDS,
  MISSING_EVENT_HOURS,
  MISSING_EVENT_MIN_BASELINE,
  BASELINE_DAYS,
  SHAPE_DRIFT_MIN_PRIOR,
  NEW_PROPERTY_GRACE_DAYS,
  DOUBLE_SENT_MIN_PAIRS,
  DOUBLE_SENT_MIN_SHARE,
  LATE_SHARE_THRESHOLD,
  LATE_MIN_EVENTS,
  SOURCE_COLLAPSE_RATIO,
  SOURCE_MIN_BASELINE,
} from './health/checks.js';
export type {
  DoubleSentFact,
  EventRateFact,
  FindingKind,
  HealthFinding,
  LateFact,
  PropertyShapeFact,
  SourceShareFact,
} from './health/checks.js';

// --- M12: the AI-coder prompt generator (brief §9) ---------------------------
export {
  generateSnippet,
  librariesFor,
  SNIPPET_STACKS,
  SNIPPET_LIBRARIES,
} from './snippets/generate.js';
export type {
  GeneratedSnippet,
  SnippetInput,
  SnippetLibrary,
  SnippetStack,
  SnippetStep,
} from './snippets/generate.js';
