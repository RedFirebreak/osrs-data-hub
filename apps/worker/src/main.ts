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
 * Raw payload clean-up is the raw_payloads retention policy; there is no job for it. Every queue
 * uses pg-boss's 'stately' policy (./queues): a run never overlaps the previous one, and ticks that
 * arrive meanwhile don't pile up.
 */
import { getConfig } from '@hub/core';
import { applyTimescalePolicies, createDb, pgErrorCode, safeDbErrorMessage } from '@hub/db';
import {
  closeStaleSessions,
  expireGracePeriods,
  getLogger,
  getMetrics,
  pruneAuditLog,
  reverifyDueMembers,
} from '@hub/server';
import { PgBoss, type Job } from 'pg-boss';
import { JOBS, SCHEDULED_QUEUE_POLICY, ensureScheduledQueues } from './queues';
import { timed } from './timed';

const config = getConfig();
const log = getLogger().child({ service: 'worker' });
if (!config.databaseUrl) {
  log.fatal('DATABASE_URL is not set');
  process.exit(1);
}

// Pools are capped: web + worker + pg-boss must stay under max_connections (DB-5).
const { db, pool } = createDb(config.databaseUrl, { max: 4, applicationName: 'hub-worker' });
const boss = new PgBoss({
  connectionString: config.databaseUrl,
  max: 3,
  application_name: 'hub-pgboss',
});
// Without a listener an 'error' event would crash the process; work() on a missing queue only emits
// errors (PGBOSS-1).
boss.on('error', (err) =>
  log.error({ pgCode: pgErrorCode(err), error: safeDbErrorMessage(err) }, 'pg-boss error'),
);

async function main() {
  const changed = await applyTimescalePolicies(db, {
    xpRawRetentionDays: config.xpRawRetentionDays,
    locationRetentionDays: config.locationRetentionDays,
    rawPayloadRetentionHours: config.rawPayloadRetentionHours,
  });
  log.info({ changed }, 'timescale policies reconciled');

  await boss.start(); // creates/migrates the pgboss schema under an advisory lock
  // Queues before schedule/work (PGBOSS-1), with a policy that keeps runs from overlapping.
  const { recreated } = await ensureScheduledQueues(boss);
  if (recreated.length > 0) {
    log.info({ recreated, policy: SCHEDULED_QUEUE_POLICY }, 'queues re-created with a new policy');
  }

  // Handlers always receive an array of jobs (PGBOSS-1).
  await boss.work(JOBS.closeStaleSessions.name, async (_jobs: Job[]) => {
    await timed(log, 'close-stale-sessions', () => closeStaleSessions(db));
  });
  await boss.work(JOBS.reverifyMembers.name, async (_jobs: Job[]) => {
    const botToken = config.discord.botToken;
    const guildId = config.discord.guildId;
    if (!botToken || !guildId) {
      log.warn('DISCORD_BOT_TOKEN or DISCORD_GUILD_ID not set: membership re-verification skipped');
      return;
    }
    await timed(log, 'reverify-members', () =>
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
    await timed(log, 'expire-grace', () => expireGracePeriods(db, {}));
  });
  await boss.work(JOBS.pruneAuditLog.name, async (_jobs: Job[]) => {
    await timed(log, 'prune-audit-log', () =>
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
  // Code and Postgres message only: a drizzle error's message lists the bound parameters (DB-3).
  log.fatal({ pgCode: pgErrorCode(err), error: safeDbErrorMessage(err) }, 'worker failed to start');
  process.exit(1);
});
