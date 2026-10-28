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
  stepUpdatesFor,
  RECOMPUTE_CHUNK_SIZE,
  RECOMPUTE_REASONS,
} from './recompute.js';
export type { RecomputeReason, RecomputeProgress } from './recompute.js';
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
