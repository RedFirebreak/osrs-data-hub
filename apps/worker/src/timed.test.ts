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

describe('timed', () => {
  it('logs the job, its duration and result, and returns the result', async () => {
    const { logger, lines } = captureLogger();

    await expect(timed(logger, 'prune-audit-log', async () => ({ deleted: 3 }))).resolves.toEqual({
      deleted: 3,
    });

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

    const failure = await timed(logger, 'expire-grace', () => Promise.reject(queryError())).catch(
      (err: unknown) => err,
    );

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
      timed(logger, 'expire-grace', () =>
        Promise.reject(new Error('expireGracePeriods: 1 of 2 users failed (55P03)\nsecond line')),
      ),
    ).rejects.toThrow('expire-grace failed: expireGracePeriods: 1 of 2 users failed (55P03)');

    expect(lines[0]).toMatchObject({
      level: 50,
      error: 'expireGracePeriods: 1 of 2 users failed (55P03)',
    });
    expect(lines[0]?.pgCode).toBeUndefined();
  });
});
