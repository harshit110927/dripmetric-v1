/**
 * Where an unexpected error goes (brief §10's "Sentry", M13).
 *
 * A seam, not an SDK. `@sentry/node` is MIT and would be fine to add, and this is
 * deliberately the layer underneath it: one function that everything reports through,
 * so wiring Sentry — or anything else — is a single `setErrorReporter` call at
 * startup rather than an import in forty files.
 *
 * The default writes the same structured JSON as every other log line (settled
 * decision D6), which means errors are already searchable wherever the logs go, and a
 * deployment with no error service is not a deployment with no error record.
 *
 * `docs/publishing.md` has the three lines that attach Sentry.
 */

export interface ErrorContext {
  /** Where it happened: a job name, a route, a sweep. */
  where: string;
  /** The project, when the work belongs to one. Never an end user's identity. */
  projectId?: number;
  /** Anything else useful. Scrubbed by the caller; this does not inspect it. */
  details?: Record<string, unknown>;
}

export type ErrorReporter = (error: unknown, context: ErrorContext) => void;

/**
 * The default: one structured line.
 *
 * The stack is included because this is for errors nobody expected, and a stack is
 * the whole value. What is NOT included is anything the caller did not pass — this
 * function never reaches into a request or a row to enrich a report, because that is
 * how an end user's email ends up in an error tracker.
 */
const logReporter: ErrorReporter = (error, context) => {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'unexpected error',
      where: context.where,
      ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
      err: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      ...(context.details ?? {}),
      time: new Date().toISOString(),
    }),
  );
};

let reporter: ErrorReporter = logReporter;

/** Called once at startup, by the process that has an error service configured. */
export function setErrorReporter(next: ErrorReporter): void {
  reporter = next;
}

export function resetErrorReporter(): void {
  reporter = logReporter;
}

/**
 * Reports an error, and never throws.
 *
 * A reporter that throws would turn one failure into two, and the second would have
 * no handler. So the reporter is wrapped: if it fails, the default log line still
 * happens.
 */
export function reportError(error: unknown, context: ErrorContext): void {
  try {
    reporter(error, context);
  } catch (reporterError) {
    logReporter(error, context);
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'the error reporter itself failed',
        err: String(reporterError),
      }),
    );
  }
}
