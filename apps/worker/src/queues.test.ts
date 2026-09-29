import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOBS, SCHEDULED_QUEUE_POLICY, ensureScheduledQueues } from './queues';

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

const names = Object.values(JOBS).map((j) => j.name);

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
      Object.fromEntries(Object.values(JOBS).map((j) => [j.name, [j.cron, 'UTC']])),
    );
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
    const name = JOBS.pruneAuditLog.name;
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
