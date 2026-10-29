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

export { suggestMappings, parseSuggestions, CONFIDENCES, MAX_ATTEMPTS } from './mapping/suggest.js';
export type {
  Ask,
  AskOptions,
  AskResult,
  Confidence,
  Suggestion,
  SuggestOutcome,
} from './mapping/suggest.js';
