import type { PgBoss, QueuePolicy } from 'pg-boss';

export interface ScheduledJob {
  /** Queue name. */
  name: string;
  /** 5-field cron, evaluated in UTC. */
  cron: string;
}

/** The worker's scheduled jobs (handoff §4.3). */
export const JOBS = {
  closeStaleSessions: { name: 'close-stale-sessions', cron: '* * * * *' },
  reverifyMembers: { name: 'reverify-members', cron: '*/15 * * * *' },
  expireGrace: { name: 'expire-grace', cron: '7 * * * *' },
  pruneAuditLog: { name: 'prune-audit-log', cron: '23 3 * * *' },
} as const satisfies Record<string, ScheduledJob>;

/**
 * pg-boss's 'stately' policy: at most one job per state (queued, retry, active) in the queue, so a
 * run never overlaps the previous one, and cron ticks that arrive while one is queued are dropped
 * instead of piling up (send resolves null). 'singleton' limits only the active job and lets the
 * queue grow; 'exclusive' would drop the tick that arrives while a run is still going, so the next
 * run could wait a whole period.
 */
export const SCHEDULED_QUEUE_POLICY: QueuePolicy = 'stately';

/**
 * Creates each job's queue with SCHEDULED_QUEUE_POLICY (required before schedule or work, PGBOSS-1)
 * and writes its cron schedule. Idempotent.
 *
 * A queue created by an earlier version keeps its old policy: createQueue on an existing name does
 * nothing (ON CONFLICT DO NOTHING) and updateQueue refuses a policy change ("queue policy cannot be
 * changed after creation"). Such a queue is deleted and created again; deleteQueue also deletes its
 * waiting jobs and (by cascade) its schedule, which is written again right after. Losing a waiting
 * run of a cron job costs nothing: the next tick sends another. Returns the queues re-created.
 */
export async function ensureScheduledQueues(
  boss: PgBoss,
  jobs: readonly ScheduledJob[] = Object.values(JOBS),
): Promise<{ recreated: string[] }> {
  const recreated: string[] = [];
  for (const job of jobs) {
    const existing = await boss.getQueue(job.name);
    if (existing && existing.policy !== SCHEDULED_QUEUE_POLICY) {
      await boss.deleteQueue(job.name);
      recreated.push(job.name);
    }
    await boss.createQueue(job.name, { policy: SCHEDULED_QUEUE_POLICY });
    await boss.schedule(job.name, job.cron, null, { tz: 'UTC' });
  }
  return { recreated };
}
