import { JOB_NAMES, type HubMetrics, type JobName } from '@hub/server';
import type { Job, PgBoss, QueuePolicy } from 'pg-boss';
import type { Logger } from 'pino';
import { timed } from './timed';

export interface ScheduledJob {
  /** Queue name. */
  name: string;
  /** 5-field cron, evaluated in UTC. */
  cron: string;
}

/**
 * The worker's scheduled jobs (handoff §4.3), by name. Keyed by JobName, the `job_name` label of the
 * hub_job_* metrics (JOB_NAMES in @hub/server), so a job can't be scheduled without its series
 * existing from startup (PROM-1), and a name added there doesn't compile until it has a schedule.
 */
export const JOBS: Record<JobName, { cron: string }> = {
  'close-stale-sessions': { cron: '* * * * *' },
  'reverify-members': { cron: '*/15 * * * *' },
  'expire-grace': { cron: '7 * * * *' },
  'prune-audit-log': { cron: '23 3 * * *' },
};

/** JOBS as the list ensureScheduledQueues takes. */
export const SCHEDULED_JOBS: readonly ScheduledJob[] = JOB_NAMES.map((name) => ({
  name,
  cron: JOBS[name].cron,
}));

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
 * changed after creation", PGBOSS-2). Such a queue is deleted and created again; deleteQueue also deletes its
 * waiting jobs and (by cascade) its schedule, which is written again right after. Losing a waiting
 * run of a cron job costs nothing: the next tick sends another. Returns the queues re-created.
 */
export async function ensureScheduledQueues(
  boss: PgBoss,
  jobs: readonly ScheduledJob[] = SCHEDULED_JOBS,
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

/** Runs `fn` as one run of the job: timed, counted and logged under the job's name (timed.ts). */
export type RunJob = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * What a job does when its queue fires. The work goes through `run`; a handler that returns without
 * calling it did not run, and nothing is counted (re-verification without Discord config).
 */
export type JobHandler = (run: RunJob) => Promise<unknown>;

/**
 * Starts the worker of every job, after ensureScheduledQueues (PGBOSS-1). One handler per JobName, so
 * a job's name is written once here and its queue, timing and metrics all use it.
 */
export async function workScheduledJobs(
  boss: Pick<PgBoss, 'work'>,
  deps: { log: Logger; metrics: HubMetrics },
  handlers: Record<JobName, JobHandler>,
): Promise<void> {
  for (const name of JOB_NAMES) {
    // Handlers always receive an array of jobs (PGBOSS-1).
    await boss.work(name, async (_jobs: Job[]) => {
      await handlers[name]((fn) => timed(deps.log, deps.metrics, name, fn));
    });
  }
}
