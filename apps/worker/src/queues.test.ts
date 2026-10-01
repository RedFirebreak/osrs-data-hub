import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { JOB_NAMES, createTestMetrics, type HubMetrics, type JobName } from '@hub/server';
import { PgBoss, type Job } from 'pg-boss';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SCHEDULED_JOBS,
  SCHEDULED_QUEUE_POLICY,
  ensureScheduledQueues,
  workScheduledJobs,
  type JobHandler,
} from './queues';

let t: TestDatabase;
let boss: PgBoss;

beforeAll(async () => {
  t = await createTestDatabase('worker_queues');
  // No supervisor or cron monitor: the test only reads and writes queue and schedule rows.
  boss = new PgBoss({ connectionString: t.url, max: 2, supervise: false, schedule: false });
  boss.on('error', () => {});
  await boss.start();
});

afterAll(async () => {
  await boss?.stop({ graceful: false, close: true });
  await t?.drop();
});

const names = SCHEDULED_JOBS.map((j) => j.name);

async function storedPolicies(): Promise<Record<string, string | undefined>> {
  const queues = await boss.getQueues(names);
  return Object.fromEntries(queues.map((q) => [q.name, q.policy]));
}

describe('ensureScheduledQueues', () => {
  it("creates every queue with the 'stately' policy and schedules it, idempotently", async () => {
    expect(SCHEDULED_QUEUE_POLICY).toBe('stately');
    const expected = Object.fromEntries(names.map((n) => [n, 'stately']));

    expect(await ensureScheduledQueues(boss)).toEqual({ recreated: [] });
    expect(await storedPolicies()).toEqual(expected);
    expect(await ensureScheduledQueues(boss)).toEqual({ recreated: [] });
    expect(await storedPolicies()).toEqual(expected);

    const schedules = await boss.getSchedules();
    expect(Object.fromEntries(schedules.map((s) => [s.name, [s.cron, s.timezone]]))).toEqual(
      Object.fromEntries(SCHEDULED_JOBS.map((j) => [j.name, [j.cron, 'UTC']])),
    );
  });

  it('schedules exactly the jobs the metrics know, under their names', () => {
    expect(SCHEDULED_JOBS).toEqual([
      { name: 'close-stale-sessions', cron: '* * * * *' },
      { name: 'reverify-members', cron: '*/15 * * * *' },
      { name: 'expire-grace', cron: '7 * * * *' },
      { name: 'prune-audit-log', cron: '23 3 * * *' },
    ]);
    expect(names).toEqual([...JOB_NAMES]);
  });

  it('re-creates a queue an earlier version made with another policy, and its schedule', async () => {
    const job = { name: 'legacy-standard-queue', cron: '*/5 * * * *' };
    await boss.createQueue(job.name); // what the worker did before: the 'standard' policy
    await boss.schedule(job.name, job.cron, null, { tz: 'UTC' });
    await boss.send(job.name, null);
    expect((await boss.getQueue(job.name))?.policy).toBe('standard');

    expect(await ensureScheduledQueues(boss, [job])).toEqual({ recreated: [job.name] });
    expect((await boss.getQueue(job.name))?.policy).toBe('stately');
    expect(await ensureScheduledQueues(boss, [job])).toEqual({ recreated: [] });
    expect(await boss.getSchedules(job.name)).toEqual([
      expect.objectContaining({ name: job.name, cron: job.cron, timezone: 'UTC' }),
    ]);
  });

  it('keeps at most one active and one queued job per queue: runs never overlap or pile up', async () => {
    const name: JobName = 'prune-audit-log';
    const queued = async () => (await boss.findJobs(name, { queued: true })).length;

    const first = await boss.send(name, null);
    expect(first).toEqual(expect.any(String));
    expect(await boss.send(name, null)).toBeNull(); // a tick while one waits is dropped
    const [running] = await boss.fetch(name);
    expect(running?.id).toBe(first);

    const next = await boss.send(name, null); // one may wait while one runs
    expect(next).toEqual(expect.any(String));
    expect(await boss.send(name, null)).toBeNull();
    expect(await queued()).toBe(1);
    expect(await boss.fetch(name)).toEqual([]); // never a second active run

    await boss.complete(name, running!.id);
    const [after] = await boss.fetch(name);
    expect(after?.id).toBe(next);
  });
});

describe('workScheduledJobs', () => {
  type Worker = (jobs: Job[]) => Promise<unknown>;

  /** A pg-boss that only remembers the workers it was given. */
  function fakeBoss() {
    const workers = new Map<string, Worker>();
    const fake = {
      work: (name: string, handler: Worker) => {
        workers.set(name, handler);
        return Promise.resolve(name);
      },
    };
    return { boss: fake as unknown as Pick<PgBoss, 'work'>, workers };
  }

  const log = pino({ level: 'silent' });

  /** hub_job_runs_total by "job_name/result", zeros left out. */
  async function runs(metrics: HubMetrics): Promise<Record<string, number>> {
    const { values } = await metrics.jobRuns.get();
    return Object.fromEntries(
      values
        .filter((v) => v.value !== 0)
        .map((v) => [`${String(v.labels.job_name)}/${String(v.labels.result)}`, v.value]),
    );
  }

  function handlers(over: Partial<Record<JobName, JobHandler>> = {}): Record<JobName, JobHandler> {
    const all = Object.fromEntries(
      JOB_NAMES.map((name): [JobName, JobHandler] => [name, (run) => run(async () => name)]),
    ) as Record<JobName, JobHandler>;
    return { ...all, ...over };
  }

  it("starts one worker per job and counts a run under that job's name", async () => {
    const { boss: fake, workers } = fakeBoss();
    const metrics = createTestMetrics();

    await workScheduledJobs(fake, { log, metrics }, handlers());

    expect([...workers.keys()]).toEqual([...JOB_NAMES]);
    await workers.get('expire-grace')!([]);
    await workers.get('prune-audit-log')!([]);
    await workers.get('prune-audit-log')!([]);
    expect(await runs(metrics)).toEqual({
      'expire-grace/success': 1,
      'prune-audit-log/success': 2,
    });
  });

  it('counts nothing when the handler returns without running (re-verification skipped)', async () => {
    const { boss: fake, workers } = fakeBoss();
    const metrics = createTestMetrics();

    await workScheduledJobs(
      fake,
      { log, metrics },
      handlers({ 'reverify-members': () => Promise.resolve() }),
    );
    await workers.get('reverify-members')!([]);

    expect(await runs(metrics)).toEqual({});
    expect((await metrics.jobLastSuccess.get()).values).toEqual([]);
  });

  it('counts a failed run and rethrows it for pg-boss', async () => {
    const { boss: fake, workers } = fakeBoss();
    const metrics = createTestMetrics();

    await workScheduledJobs(
      fake,
      { log, metrics },
      handlers({ 'expire-grace': (run) => run(() => Promise.reject(new Error('boom'))) }),
    );

    await expect(workers.get('expire-grace')!([])).rejects.toThrow('expire-grace failed: boom');
    expect(await runs(metrics)).toEqual({ 'expire-grace/failure': 1 });
  });
});
