import type { Db } from '@hub/db';
import type { Logger } from '../logger';
import type { HubMetrics } from '../metrics';
import type { FetchFn, GuildPolicy } from '../discord';

function notImplemented(name: string): never {
  throw new Error(`not implemented: ${name}`);
}

/**
 * Ends open play sessions whose account has been silent longer than the presence timeout
 * (presenceTimeoutSeconds(latest_state.tick_delay)): ended_at = the session's last_seen_at,
 * end_reason = 'timeout'. Special worlds send nothing, so a hop to one ends the session here.
 */
export async function closeStaleSessions(db: Db, opts: { now?: Date } = {}): Promise<{ closed: number }> {
  return notImplemented('closeStaleSessions');
}

export interface ReverifyDeps {
  db: Db;
  botToken: string;
  policy: GuildPolicy;
  graceDays: number;
  logger: Logger;
  metrics: HubMetrics;
  now?: Date;
  /** Users checked per run (the job runs every 15 min, so checks are staggered). Default 25. */
  batchSize?: number;
  /** Re-verify users whose last_verified_at is older than this. Default 6. */
  intervalHours?: number;
  /** Alert (log error) after this many consecutive failures for one user. Default 5. */
  alertAfterFailures?: number;
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReverifyResult {
  checked: number;
  offboarded: number;
  failures: number;
  /** The circuit breaker stopped the run (too many "not a member" answers at once). */
  aborted: boolean;
}

/**
 * Re-verifies active users due for a check via the bot (handoff §5): a member passing the role policy
 * → refresh roles/isAdmin/nickname and last_verified_at; definitive not-member (404/10007) or a
 * missing required role → offboardUser(reason 'left_guild' | 'lost_role'); any error (config, auth,
 * rate limit, outage) → fail OPEN: increment verify_failures and alert after N in a row, never
 * offboard (DISCORD-1). Circuit breaker: if more than 20% of a batch (with at least 5 checked) come
 * back not-member, offboard nobody in that run and log an error (likely a config problem).
 */
export async function reverifyDueMembers(deps: ReverifyDeps): Promise<ReverifyResult> {
  return notImplemented('reverifyDueMembers');
}

/** Deletes audit entries older than retentionDays. */
export async function pruneAuditLog(
  db: Db,
  opts: { retentionDays: number; now?: Date },
): Promise<{ deleted: number }> {
  return notImplemented('pruneAuditLog');
}
