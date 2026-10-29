/**
 * @dripmetric/ingest — the ingest pipeline, framework-agnostic.
 *
 * A Next.js route handler is a thin adapter over `handleBatch`. Nothing in this
 * package imports Next.js (ESLint enforces it), so ingest can move to its own
 * service when it needs to (brief section 4).
 */
export { handleBatch, corsHeaders } from './handler.js';
export { deleteUser } from './delete-user.js';
export {
  queueRecompute,
  recomputeChunk,
  recomputeProject,
  pendingRecomputeProjects,
  stepUpdatesFor,
  RECOMPUTE_CHUNK_SIZE,
  RECOMPUTE_REASONS,
} from './recompute.js';
export type { RecomputeReason, RecomputeProgress } from './recompute.js';
export {
  refreshDictionaryFacts,
  PROPERTY_SAMPLE_PER_NAME,
  SEQUENCE_SAMPLE_USERS,
} from './dictionary-facts.js';
export type { DictionaryFactsResult } from './dictionary-facts.js';
export { runSuggestions, promptInputFrom } from './suggest-run.js';
export type { SuggestionRun } from './suggest-run.js';

// --- M8: leaks (brief §8.3) -------------------------------------------------
export {
  loadUserLeakFacts,
  loadCollapseFacts,
  leakAvailability,
  isTrialCheckout,
  LEAK_EVENTS,
} from './leaks/facts.js';
export {
  sweepUserLeaks,
  sweepStepCollapse,
  recordFindings,
  resolveLeaks,
  leakSummary,
  quickExitRates,
  writeLeakSummary,
  runLeakSweep,
  runCollapseSweep,
} from './leaks/sweeps.js';
export type { SweepResult, LeakSummary, QuickExitRates } from './leaks/sweeps.js';

// --- M6: the funnel and timing jobs (brief §8.1) ----------------------------
export {
  loadStepDefinitions,
  loadStepStates,
  loadLifecycle,
  loadSegmentFacts,
  loadSkippedOrErroredAfter,
  loadCohortFacts,
  loadFrozenThresholds,
  loadTrend,
  refreshLifecycle,
  SIGNED_UP,
  ACTIVATED,
  PAID,
  SKIP_OR_ERROR_EVENTS,
  SKIMMED_WINDOW_SECONDS,
} from './funnel/facts.js';
export type { LifecycleFact } from './funnel/facts.js';
// --- M7: intent (brief §8.2) ------------------------------------------------
export { loadIntentFacts, INTENT_EVENTS, TRIAL_CHECKOUT_TYPE } from './intent/facts.js';
export type { ProjectIntentContext, UserIntentFacts, IntentFactsResult } from './intent/facts.js';
export {
  refreshIntentState,
  intentSummary,
  intentContextFor,
  runCalibration,
  runIntentRefresh,
  runIntentDaily,
  writeIntentSummary,
} from './intent/state.js';
export type { IntentSummary } from './intent/state.js';

export {
  funnelFactsFor,
  currentFunnelReport,
  storeThresholds,
  aggregateHours,
  aggregateDays,
  aggregateSegments,
  aggregateCohorts,
  writeDailySummary,
  runFunnelHourly,
  runFunnelDaily,
} from './funnel/aggregate.js';
export type { EnqueueFollowUps, HandleBatchOptions } from './handler.js';
export { IngestError } from './errors.js';
export type { IngestRequest, IngestResponse, PreparedMessage } from './types.js';
export { prepareMessage, messageHash } from './validate.js';
export { extractKey, originAllowed, resolveKey } from './auth.js';
export { consumeTokens } from './rate-limit.js';
export { isBot, parseUserAgent, visitorUserAgent } from './enrich/user-agent.js';
export {
  normalisePath,
  normalisePathSegment,
  referrerDomain,
  screenBucket,
} from './enrich/paths.js';
export { classifyEmail, emailDomain, looksLikeEmail } from './enrich/email.js';
export { sourceToSmallInt, smallIntToSource, FLAG_LATE } from './pipeline/events.js';
export {
  matchSteps,
  matchesPattern,
  mergeStepUpdates,
  EMPTY_FUNNEL,
} from './pipeline/step-state.js';
export type { FunnelConfig, StepDefinition, StepMatch } from './pipeline/step-state.js';
export type { FollowUp, ProjectContext } from './pipeline/index.js';

// --- M10: alerts and reports (brief §9) -------------------------------------
export {
  decideProjectAlerts,
  deliverDueAlerts,
  runAlertDispatch,
  postWebhook,
} from './alerts/dispatch.js';
export type { DeliveryResult, DispatchResult, PostWebhook } from './alerts/dispatch.js';
export {
  runWeeklyReport,
  runDailyDigest,
  weeklyReportFacts,
  changeComparisons,
  compareOneChange,
  REPORT_WEEKDAY,
  REPORT_HOUR,
  DIGEST_HOUR,
} from './alerts/reports.js';
export type { OutgoingEmail, ReportRunResult, SendEmail } from './alerts/reports.js';

export {
  runRetention,
  sweepUnclaimedProjects,
  RETENTION_BATCH_HOURS,
  RETENTION_MAX_BATCHES,
  UNCLAIMED_STOP_DAYS,
  UNCLAIMED_DELETE_DAYS,
} from './retention.js';
export type { RetentionResult, UnclaimedResult } from './retention.js';
export { checkTrackingHealth, runTrackingHealth, trackingProblems } from './health/run.js';
export type { HealthResult } from './health/run.js';
