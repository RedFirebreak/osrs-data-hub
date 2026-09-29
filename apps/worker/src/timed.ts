import { pgErrorCode, safeDbErrorMessage } from '@hub/db';
import type { HubMetrics, JobName } from '@hub/server';
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
 * Runs one job handler, logs its duration and records it in the job metrics (D-83):
 * hub_job_duration_seconds and hub_job_runs_total{result} for every run, and
 * hub_job_last_success_timestamp_seconds after a success. The log line is 'job done' with the
 * result, or 'job failed' with { job, ms, pgCode, error } only. The error is rethrown (pg-boss marks
 * the job failed and retries it) as a JobFailedError, so neither the log nor pgboss.job ever holds a
 * query's bound parameters (DB-3); `error` is safeDbErrorMessage's, which for a non-database error is
 * its first line.
 */
export async function timed<T>(
  log: Logger,
  metrics: HubMetrics,
  job: JobName,
  fn: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  const labels = { job_name: job };
  try {
    const result = await fn();
    const seconds = elapsed() / 1000;
    metrics.jobDuration.observe(labels, seconds);
    metrics.jobRuns.inc({ ...labels, result: 'success' });
    metrics.jobLastSuccess.set(labels, Date.now() / 1000);
    log.info({ job, ms: Math.round(seconds * 1000), result }, 'job done');
    return result;
  } catch (err) {
    const ms = elapsed();
    metrics.jobDuration.observe(labels, ms / 1000);
    metrics.jobRuns.inc({ ...labels, result: 'failure' });
    const pgCode = pgErrorCode(err);
    const error = safeDbErrorMessage(err);
    log.error({ job, ms: Math.round(ms), pgCode, error }, 'job failed');
    throw new JobFailedError(job, pgCode, error);
  }
}
