/**
 * Worker: pg-boss scheduled jobs (handoff §4.3). One process; jobs are idempotent.
 *
 * | Job                        | Schedule                         |
 * |----------------------------|----------------------------------|
 * | close-stale-sessions       | every minute                     |
 * | reverify-members           | every 15 min, a batch of users due (staggered 6-hourly checks) |
 * | expire-grace               | hourly: grace expiry, then the orphaned-account purge (D-61) |
 * | prune-audit-log            | daily                            |
 * | Timescale policies         | reconciled at startup            |
 *
 * Names and schedules are in ./queues (JOBS), what each job does is in main() below. Every run is
 * timed and counted (timed.ts); the metrics are served on WORKER_METRICS_PORT (D-84).
 * Raw payload clean-up is the raw_payloads retention policy; there is no job for it. Every queue
 * uses pg-boss's 'stately' policy (./queues): a run never overlaps the previous one, and ticks that
 * arrive meanwhile don't pile up.
 */
import { getConfig } from '@hub/core';
import { applyTimescalePolicies, createDb, pgErrorCode, safeDbErrorMessage } from '@hub/db';
import {
  JOB_NAMES,
  closeStaleSessions,
  expireGracePeriods,
  getLogger,
  getMetrics,
  pruneAuditLog,
  purgeOrphanedAccounts,
  reverifyDueMembers,
} from '@hub/server';
import type { Server } from 'node:http';
import { PgBoss } from 'pg-boss';
import { createMetricsServer } from './metrics-server';
import { SCHEDULED_QUEUE_POLICY, ensureScheduledQueues, workScheduledJobs } from './queues';

const config = getConfig();
// The logger's base `service` field (a child binding would repeat the key in every JSON line).
process.env.HUB_SERVICE ??= 'worker';
const log = getLogger();
const metrics = getMetrics();
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

let metricsServer: Server | null = null;

/**
 * Serves /metrics unless WORKER_METRICS_PORT is 0. A port in use is logged, not fatal: the jobs
 * matter more than their metrics.
 */
function startMetricsServer() {
  if (config.workerMetricsPort === 0) return;
  metricsServer = createMetricsServer({ registry: metrics.registry, token: config.metricsToken });
  metricsServer.on('error', (err: NodeJS.ErrnoException) =>
    log.error({ code: err.code, port: config.workerMetricsPort }, 'metrics endpoint failed'),
  );
  metricsServer.listen(config.workerMetricsPort, () =>
    log.info(
      { port: config.workerMetricsPort, enabled: Boolean(config.metricsToken) },
      'metrics endpoint listening',
    ),
  );
}

async function main() {
  startMetricsServer();
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

  await workScheduledJobs(
    boss,
    { log, metrics },
    {
      'close-stale-sessions': (run) => run(() => closeStaleSessions(db, { metrics })),
      'reverify-members': async (run) => {
        const botToken = config.discord.botToken;
        const guildId = config.discord.guildId;
        if (!botToken || !guildId) {
          // Returns without `run`: a skipped re-verification is not a run and isn't counted.
          log.warn(
            'DISCORD_BOT_TOKEN or DISCORD_GUILD_ID not set: membership re-verification skipped',
          );
          return;
        }
        await run(() =>
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
            metrics,
          }),
        );
      },
      'expire-grace': (run) =>
        run(async () => {
          // Grace expiry first (it transfers or deletes the accounts of users who leave), then the
          // time-gated purge of accounts nobody can reclaim (D-61). The purge runs even when some
          // users failed to expire; the first failure is reported afterwards.
          let expired: Awaited<ReturnType<typeof expireGracePeriods>> | null = null;
          let failure: unknown = null;
          try {
            expired = await expireGracePeriods(db, { metrics });
          } catch (err) {
            failure = err;
          }
          const purged = await purgeOrphanedAccounts(db, {
            graceDays: config.offboardGraceDays,
            metrics,
          });
          if (failure) throw failure;
          return { ...expired, ...purged };
        }),
      'prune-audit-log': (run) =>
        run(() => pruneAuditLog(db, { retentionDays: config.auditLogRetentionDays })),
    },
  );
  log.info({ jobs: JOB_NAMES }, 'worker started');
  if (!config.discord.botToken || !config.discord.guildId) {
    // Said once at startup too: the job itself only runs every 15 minutes.
    log.warn('DISCORD_BOT_TOKEN or DISCORD_GUILD_ID not set: membership re-verification is off');
  }
}

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'stopping');
  try {
    metricsServer?.close();
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
