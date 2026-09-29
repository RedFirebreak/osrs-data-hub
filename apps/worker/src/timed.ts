import { pgErrorCode, safeDbErrorMessage } from '@hub/db';
import type { Logger } from 'pino';

/**
 * What a job failure is reported as, to the log and to pg-boss (which stores the thrown error in the
 * job's output). Carries only the SQLSTATE and the Postgres message: a drizzle error's own message
 * lists every bound parameter (DB-3).
 */
export class JobFailedError extends Error {
  constructor(
    readonly job: string,
    readonly pgCode: string | undefined,
    safeMessage: string,
  ) {
    super(`${job} failed: ${pgCode ? `${pgCode} ` : ''}${safeMessage}`);
    this.name = 'JobFailedError';
  }
}

/**
 * Runs one job handler and logs its duration: 'job done' with the result, or 'job failed' with
 * { job, ms, pgCode, error } only. The error is rethrown (pg-boss marks the job failed and retries
 * it) as a JobFailedError, so neither the log nor pgboss.job ever holds a query's bound parameters
 * (DB-3); `error` is safeDbErrorMessage's, which for a non-database error is its first line.
 */
export async function timed<T>(log: Logger, job: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const result = await fn();
    log.info({ job, ms: ms(), result }, 'job done');
    return result;
  } catch (err) {
    const pgCode = pgErrorCode(err);
    const error = safeDbErrorMessage(err);
    log.error({ job, ms: ms(), pgCode, error }, 'job failed');
    throw new JobFailedError(job, pgCode, error);
  }
}
