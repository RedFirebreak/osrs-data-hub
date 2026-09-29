import { createTestMetrics, type HubMetrics } from '@hub/server';
import { DrizzleQueryError } from 'drizzle-orm';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { JobFailedError, timed } from './timed';

interface Line {
  level: number;
  msg: string;
  [key: string]: unknown;
}

function captureLogger() {
  const lines: Line[] = [];
  const logger = pino(
    { level: 'trace' },
    { write: (msg: string) => void lines.push(JSON.parse(msg) as Line) },
  );
  return { logger, lines };
}

/** What drizzle throws for a failed query: the pg error as `cause`, the parameters in the message. */
function queryError(): DrizzleQueryError {
  const pgError = Object.assign(new Error('duplicate key value violates unique constraint "x"'), {
    code: '23505',
  });
  return new DrizzleQueryError(
    'update "devices" set "token_hash" = $1 where "id" = $2',
    ['secret-token-hash', 'device-1'],
    pgError,
  );
}

/** hub_job_runs_total by "job_name/result". */
async function runs(metrics: HubMetrics): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const v of (await metrics.jobRuns.get()).values) {
    if (v.value === 0) continue;
    out[`${String(v.labels.job_name)}/${String(v.labels.result)}`] = v.value;
  }
  return out;
}

/** The hub_job_duration_seconds observation count of one job. */
async function observations(metrics: HubMetrics, job: string): Promise<number> {
  const count = (await metrics.jobDuration.get()).values.find(
    (v) => v.metricName === 'hub_job_duration_seconds_count' && v.labels.job_name === job,
  );
  return count?.value ?? 0;
}

async function lastSuccess(metrics: HubMetrics, job: string): Promise<number | undefined> {
  return (await metrics.jobLastSuccess.get()).values.find((v) => v.labels.job_name === job)?.value;
}

describe('timed', () => {
  it('logs the job, its duration and result, and returns the result', async () => {
    const { logger, lines } = captureLogger();

    await expect(
      timed(logger, createTestMetrics(), 'prune-audit-log', async () => ({ deleted: 3 })),
    ).resolves.toEqual({ deleted: 3 });

    expect(lines).toEqual([
      expect.objectContaining({
        level: 30,
        msg: 'job done',
        job: 'prune-audit-log',
        ms: expect.any(Number) as unknown,
        result: { deleted: 3 },
      }),
    ]);
  });

  it('logs only the code and the Postgres message of a database error (DB-3)', async () => {
    const { logger, lines } = captureLogger();

    const failure = await timed(logger, createTestMetrics(), 'expire-grace', () =>
      Promise.reject(queryError()),
    ).catch((err: unknown) => err);

    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(
      Object.keys(line!)
        .filter((k) => !['time', 'pid', 'hostname'].includes(k))
        .sort(),
    ).toEqual(['error', 'job', 'level', 'ms', 'msg', 'pgCode']);
    expect(line).toMatchObject({
      level: 50,
      msg: 'job failed',
      job: 'expire-grace',
      pgCode: '23505',
      error: 'duplicate key value violates unique constraint "x"',
    });
    // Rethrown for pg-boss (which stores it in the job's output), sanitized the same way.
    expect(failure).toBeInstanceOf(JobFailedError);
    expect(failure).toMatchObject({ job: 'expire-grace', pgCode: '23505' });
    expect(JSON.stringify([lines, String(failure)])).not.toMatch(/secret-token-hash|device-1|\$1/);
  });

  it('logs the first line of an error that is not a database error', async () => {
    const { logger, lines } = captureLogger();

    await expect(
      timed(logger, createTestMetrics(), 'expire-grace', () =>
        Promise.reject(new Error('expireGracePeriods: 1 of 2 users failed (55P03)\nsecond line')),
      ),
    ).rejects.toThrow('expire-grace failed: expireGracePeriods: 1 of 2 users failed (55P03)');

    expect(lines[0]).toMatchObject({
      level: 50,
      error: 'expireGracePeriods: 1 of 2 users failed (55P03)',
    });
    expect(lines[0]?.pgCode).toBeUndefined();
  });

  it('records a success: duration, run and last-success time (D-84)', async () => {
    const { logger } = captureLogger();
    const metrics = createTestMetrics();
    const before = Date.now() / 1000;

    await timed(logger, metrics, 'close-stale-sessions', async () => ({ closed: 0, open: 0 }));
    await timed(logger, metrics, 'close-stale-sessions', async () => ({ closed: 1, open: 0 }));

    expect(await runs(metrics)).toEqual({ 'close-stale-sessions/success': 2 });
    expect(await observations(metrics, 'close-stale-sessions')).toBe(2);
    const at = await lastSuccess(metrics, 'close-stale-sessions');
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now() / 1000);
  });

  it('records a failure without touching the last-success time', async () => {
    const { logger } = captureLogger();
    const metrics = createTestMetrics();

    await timed(logger, metrics, 'reverify-members', () => Promise.reject(new Error('boom'))).catch(
      () => undefined,
    );

    expect(await runs(metrics)).toEqual({ 'reverify-members/failure': 1 });
    expect(await observations(metrics, 'reverify-members')).toBe(1);
    expect(await lastSuccess(metrics, 'reverify-members')).toBeUndefined();
  });
});
