import { DEFAULT_PRESENCE_TIMEOUT_S, MIN_PRESENCE_TIMEOUT_S } from '@hub/core';
import type { Db } from '@hub/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * presenceTimeoutSeconds (@hub/core, D-28) as a SQL expression over an integer tick-delay
 * expression: DEFAULT_PRESENCE_TIMEOUT_S when null or ≤ 0, else max(MIN_PRESENCE_TIMEOUT_S,
 * floor(tickDelay × 1.86)). 3.1 × 0.6 is computed as × 186 / 100 in integer (bigint) arithmetic like
 * the core function, so the floor is exact; a float 1.86 would put some values one second off.
 */
export function presenceTimeoutSql(tickDelay: SQL): SQL {
  return sql`(CASE WHEN ${tickDelay} IS NULL OR ${tickDelay} <= 0 THEN ${DEFAULT_PRESENCE_TIMEOUT_S}::bigint ELSE GREATEST(${MIN_PRESENCE_TIMEOUT_S}::bigint, (${tickDelay})::bigint * 186 / 100) END)`;
}

/**
 * Ends open play sessions whose account has been silent longer than the presence timeout
 * (presenceTimeoutSeconds(latest_state.tick_delay)): ended_at = the session's last_seen_at,
 * end_reason = 'timeout'. Special worlds send nothing, so a hop to one ends the session here.
 */
export async function closeStaleSessions(
  db: Db,
  opts: { now?: Date } = {},
): Promise<{ closed: number }> {
  const now = (opts.now ?? new Date()).toISOString();
  const timeout = presenceTimeoutSql(sql`ls.tick_delay`);
  // Silence is measured from the later of the account's presence and the session's own last
  // in-game payload (a session without a latest_state row falls back to the latter). The outer
  // WHERE repeats the check on the session row: if ingest refreshes the session while this
  // statement waits for its row lock, Postgres re-evaluates that condition on the new row version
  // and the session stays open.
  const res = await db.execute(sql`
    WITH stale AS (
      SELECT ps.id, ${timeout} AS timeout_s
      FROM play_sessions ps
      LEFT JOIN latest_state ls ON ls.account_id = ps.account_id
      WHERE ps.ended_at IS NULL
        AND GREATEST(ls.last_seen, ps.last_seen_at) + ${timeout} * interval '1 second'
            < ${now}::timestamptz
    )
    UPDATE play_sessions AS p
    SET ended_at = p.last_seen_at, end_reason = 'timeout'
    FROM stale
    WHERE p.id = stale.id
      AND p.ended_at IS NULL
      AND p.last_seen_at + stale.timeout_s * interval '1 second' < ${now}::timestamptz`);
  return { closed: res.rowCount ?? 0 };
}
