/**
 * Worker: pg-boss scheduled jobs (handoff §4.3). One process; jobs are idempotent.
 *
 * | Job                        | Schedule                         |
 * |----------------------------|----------------------------------|
 * | close-stale-sessions       | every minute                     |
 * | reverify-members           | every 15 min, a batch of users due (staggered 6-hourly checks) |
 * | expire-grace               | hourly                           |
 * | prune-audit-log            | daily                            |
 * | Timescale policies         | reconciled at startup            |
 *
 * Raw payload clean-up is the raw_payloads retention policy; there is no job for it.
 */
import { getConfig } from '@hub/core';
import { applyTimescalePolicies, createDb } from '@hub/db';
import {
  closeStaleSessions,
  expireGracePeriods,
  getLogger,
  getMetrics,
  pruneAuditLog,
  reverifyDueMembers,
} from '@hub/server';
import { PgBoss, type Job } from 'pg-boss';

const config = getConfig();
const log = getLogger().child({ service: 'worker' });
if (!config.databaseUrl) {
  log.fatal('DATABASE_URL is not set');
  process.exit(1);
}

// Pools are capped: web + worker + pg-boss must stay under max_connections (DB-5).
const { db, pool } = createDb(config.databaseUrl, { max: 4, applicationName: 'hub-worker' });
const boss = new PgBoss({ connectionString: config.databaseUrl, max: 3, application_name: 'hub-pgboss' });
// Without a listener an 'error' event would crash the process; work() on a missing queue only emits
// errors (PGBOSS-1).
boss.on('error', (err) => log.error({ err: String(err) }, 'pg-boss error'));

const JOBS = {
  closeStaleSessions: { name: 'close-stale-sessions', cron: '* * * * *' },
  reverifyMembers: { name: 'reverify-members', cron: '*/15 * * * *' },
  expireGrace: { name: 'expire-grace', cron: '7 * * * *' },
  pruneAuditLog: { name: 'prune-audit-log', cron: '23 3 * * *' },
} as const;

async function timed<T>(job: string, fn: () => Promise<T>): Promise<void> {
  const started = performance.now();
  try {
    const result = await fn();
    log.info({ job, ms: Math.round(performance.now() - started), result }, 'job done');
  } catch (err) {
    log.error({ job, ms: Math.round(performance.now() - started), err: String(err) }, 'job failed');
    throw err;
  }
}

async function main() {
  const changed = await applyTimescalePolicies(db, {
    xpRawRetentionDays: config.xpRawRetentionDays,
    locationRetentionDays: config.locationRetentionDays,
    rawPayloadRetentionHours: config.rawPayloadRetentionHours,
  });
  log.info({ changed }, 'timescale policies reconciled');

  await boss.start(); // creates/migrates the pgboss schema under an advisory lock
  for (const job of Object.values(JOBS)) {
    await boss.createQueue(job.name); // required before schedule/send; idempotent (PGBOSS-1)
    await boss.schedule(job.name, job.cron, null, { tz: 'UTC' });
  }

  // Handlers always receive an array of jobs (PGBOSS-1).
  await boss.work(JOBS.closeStaleSessions.name, async (_jobs: Job[]) => {
    await timed('close-stale-sessions', () => closeStaleSessions(db));
  });
  await boss.work(JOBS.reverifyMembers.name, async (_jobs: Job[]) => {
    const botToken = config.discord.botToken;
    const guildId = config.discord.guildId;
    if (!botToken || !guildId) {
      log.warn('DISCORD_BOT_TOKEN or DISCORD_GUILD_ID not set: membership re-verification skipped');
      return;
    }
    await timed('reverify-members', () =>
      reverifyDueMembers({
        db,
        botToken,
        policy: {
          guildId,
          requiredRoleIds: config.discord.requiredRoleIds,
          adminRoleIds: config.discord.adminRoleIds,
          adminUserIds: config.discord.adminUserIds,
        },
        graceDays: config.offboardGraceDays,
        logger: log,
        metrics: getMetrics(),
      }),
    );
  });
  await boss.work(JOBS.expireGrace.name, async (_jobs: Job[]) => {
    await timed('expire-grace', () => expireGracePeriods(db, {}));
  });
  await boss.work(JOBS.pruneAuditLog.name, async (_jobs: Job[]) => {
    await timed('prune-audit-log', () =>
      pruneAuditLog(db, { retentionDays: config.auditLogRetentionDays }),
    );
  });
  log.info({ jobs: Object.values(JOBS).map((j) => j.name) }, 'worker started');
}

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'stopping');
  try {
    await boss.stop({ graceful: true, timeout: 20_000 });
  } finally {
    await pool.end().catch(() => {});
    process.exit(0);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  log.fatal({ err: String(err) }, 'worker failed to start');
  process.exit(1);
});
