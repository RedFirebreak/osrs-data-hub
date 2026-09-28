/**
 * Reconciles TimescaleDB policies (compression, retention, continuous-aggregate refresh) with the
 * configured retention. Run by the worker at startup; idempotent and safe to run concurrently.
 *
 * `add_*_policy(if_not_exists => true)` does NOT update a policy whose arguments differ (it only
 * warns), so each policy is compared first and replaced only when it differs (TSDB-3).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Db, Tx } from './client';

export interface PolicyConfig {
  xpRawRetentionDays: number;
  locationRetentionDays: number;
  rawPayloadRetentionHours: number;
}

/**
 * The continuous-aggregate refresh windows start this far back. A refresh over a range whose raw chunks
 * were already dropped by retention DELETES the aggregated rows for it, so the window must stay well
 * inside the raw retention (TSDB-1).
 */
export const CAGG_REFRESH_START_DAYS = 7;
const MIN_RAW_RETENTION_DAYS = CAGG_REFRESH_START_DAYS * 2;

export function validatePolicyConfig(c: PolicyConfig): void {
  const ints = [c.xpRawRetentionDays, c.locationRetentionDays, c.rawPayloadRetentionHours];
  if (!ints.every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error('retention settings must be positive integers');
  }
  if (c.xpRawRetentionDays < MIN_RAW_RETENTION_DAYS) {
    throw new Error(
      `XP_RAW_RETENTION_DAYS must be at least ${MIN_RAW_RETENTION_DAYS}: the hourly/daily XP ` +
        `aggregates refresh the last ${CAGG_REFRESH_START_DAYS} days, and refreshing a range whose raw ` +
        'data was dropped erases the aggregated history',
    );
  }
}

async function jobMatches(tx: Tx, proc: string, relation: string, match: SQL): Promise<boolean> {
  const r = await tx.execute(sql`
    SELECT job_id FROM timescaledb_information.jobs
    WHERE proc_name = ${proc} AND hypertable_schema = 'public' AND hypertable_name = ${relation}
      AND ${match}`);
  return r.rows.length === 1;
}

/** Returns a description of every policy it (re)created; empty when everything already matched. */
export async function applyTimescalePolicies(db: Db, c: PolicyConfig): Promise<string[]> {
  validatePolicyConfig(c);
  const changed: string[] = [];
  await db.transaction(async (tx) => {
    // One reconciler at a time (two worker starts racing).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${0x7453}::int4, ${1}::int4)`);

    const retention = async (table: string, dropAfter: string, schedule: string) => {
      const ok = await jobMatches(
        tx,
        'policy_retention',
        table,
        sql`(config->>'drop_after')::interval = ${dropAfter}::interval AND schedule_interval = ${schedule}::interval`,
      );
      if (ok) return;
      await tx.execute(sql`SELECT remove_retention_policy(${table}::regclass, if_exists => true)`);
      await tx.execute(
        sql`SELECT add_retention_policy(${table}::regclass, drop_after => ${dropAfter}::interval, schedule_interval => ${schedule}::interval)`,
      );
      changed.push(`retention ${table} ${dropAfter}`);
    };
    const compression = async (table: string, after: string) => {
      const ok = await jobMatches(
        tx,
        'policy_compression',
        table,
        sql`(config->>'compress_after')::interval = ${after}::interval`,
      );
      if (ok) return;
      await tx.execute(sql`SELECT remove_compression_policy(${table}::regclass, if_exists => true)`);
      await tx.execute(
        sql`SELECT add_compression_policy(${table}::regclass, compress_after => ${after}::interval)`,
      );
      changed.push(`compression ${table} ${after}`);
    };
    const refresh = async (view: string, start: string, end: string, schedule: string) => {
      const ok = await jobMatches(
        tx,
        'policy_refresh_continuous_aggregate',
        view,
        sql`(config->>'start_offset')::interval = ${start}::interval
          AND (config->>'end_offset')::interval = ${end}::interval
          AND schedule_interval = ${schedule}::interval`,
      );
      if (ok) return;
      await tx.execute(
        sql`SELECT remove_continuous_aggregate_policy(${view}::regclass, if_exists => true)`,
      );
      await tx.execute(
        sql`SELECT add_continuous_aggregate_policy(${view}::regclass, start_offset => ${start}::interval, end_offset => ${end}::interval, schedule_interval => ${schedule}::interval)`,
      );
      changed.push(`refresh ${view}`);
    };

    const start = `${CAGG_REFRESH_START_DAYS} days`;
    await refresh('xp_hourly', start, '1 hour', '15 minutes');
    await refresh('xp_daily', start, '1 day', '1 hour');
    await compression('xp_samples', '7 days');
    await compression('raw_payloads', '6 hours');
    // Always explicit schedule_interval: the default is 1 day regardless of drop_after (TSDB-5).
    await retention('xp_samples', `${c.xpRawRetentionDays} days`, '1 day');
    await retention('location_samples', `${c.locationRetentionDays} days`, '1 hour');
    await retention('raw_payloads', `${c.rawPayloadRetentionHours} hours`, '15 minutes');
  });
  return changed;
}
