import { auditLog, pgErrorCode, users, type Db } from '@hub/db';
import {
  and,
  asc,
  count,
  countDistinct,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';
import {
  avatarUrl,
  displayName,
  evaluateMembership,
  fetchGuildMemberAsBot,
  isAdmin,
  type DiscordGuildMember,
  type FetchFn,
  type GuildPolicy,
  type MemberLookup,
  type MembershipVerdict,
} from '../discord';
import type { Logger } from '../logger';
import type { HubMetrics } from '../metrics';
import { offboardUser } from '../offboarding';

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
  /**
   * The run was cut short: a circuit breaker tripped (too many departures in the batch or in the
   * rolling window), or the lookups stopped early.
   */
  aborted: boolean;
}

const HOUR_MS = 3_600_000;
/** The per-batch breaker needs at least this many answers before it judges a batch (DISCORD-1). */
export const BREAKER_MIN_CHECKED = 5;
/** More than this share of departures (in a batch, or in the window) is a config problem (D-34). */
export const BREAKER_MAX_DEPARTURE_SHARE = 0.2;
/** The rolling breaker lets at least this many departures through per window, however few users. */
export const BREAKER_WINDOW_MIN_DEPARTURES = 3;
/** The offboarding reasons re-verification gives (and the rolling breaker counts). */
const REVERIFY_REASONS = ['left_guild', 'lost_role'] as const;
/** actor_label of re-verification's audit entries (offboardDepartures). */
const REVERIFY_ACTOR = 'worker';
/** Discord's "Unknown Guild": the bot isn't in the guild, or DISCORD_GUILD_ID is wrong (DISCORD-1). */
const UNKNOWN_GUILD = 10004;

interface DueUser {
  id: string;
  discordId: string;
  verifyFailures: number;
}

interface Check {
  user: DueUser;
  lookup: MemberLookup;
  verdict: MembershipVerdict;
}

type Departure = Check & { verdict: { kind: 'not_member' | 'missing_role' } };
type FailureReason = Extract<MembershipVerdict, { kind: 'error' }>['reason'];

/**
 * Re-verifies active users due for a check via the bot (handoff §5): a member passing the role policy
 * → refresh roles/isAdmin/nickname and last_verified_at; definitive not-member (404/10007) or a
 * missing required role → offboardUser(reason 'left_guild' | 'lost_role'); any error (config, auth,
 * rate limit, outage) → fail OPEN: increment verify_failures and alert after N in a row, never
 * offboard (DISCORD-1).
 *
 * Two circuit breakers, either of which makes the run offboard nobody and log an error (likely a
 * config problem: a wrong guild id, a kicked bot, a required role deleted and recreated):
 *  - per batch: more than 20% of the users Discord answered for (at least 5) are departures;
 *  - rolling: the users re-verification offboarded in the last intervalHours who are still in grace
 *    for it, plus this batch's departures, would exceed max(3, 20% of the users). Checks are
 *    staggered (a few users per run), so the per-batch rule alone almost never applies. See
 *    windowBreakerTrips for how it clears.
 */
export async function reverifyDueMembers(deps: ReverifyDeps): Promise<ReverifyResult> {
  const now = deps.now ?? new Date();
  const intervalHours = deps.intervalHours ?? 6;
  const due = await loadDueUsers(deps.db, now, intervalHours, deps.batchSize ?? 25);
  const checks = await lookUpAll(deps, due);
  const stoppedEarly = checks.length < due.length;

  // Every verdict is known before anything is written, so the breaker can judge the whole batch.
  let failures = 0;
  const departures: Departure[] = [];
  for (const check of checks) {
    const { user, verdict, lookup } = check;
    if (verdict.kind === 'ok') {
      await recordSafely(deps, user, () => recordMember(deps, user, verdict.member, now));
    } else if (verdict.kind === 'error') {
      failures++;
      await recordSafely(deps, user, () => recordFailure(deps, user, verdict.reason, lookup));
    } else {
      departures.push(check as Departure);
    }
  }

  // The batch rule judges the users Discord answered for: counting errors in would dilute it, and a
  // wrong role list during a partial outage would then offboard everyone it did get an answer for.
  const answered = checks.length - failures;
  const tripped =
    departures.length > 0 &&
    (await breakerTripped(deps, {
      checked: checks.length,
      answered,
      departures,
      now,
      intervalHours,
    }));
  const offboarded = tripped ? 0 : await offboardDepartures(deps, departures, now);
  return { checked: checks.length, offboarded, failures, aborted: tripped || stoppedEarly };
}

/**
 * True when the departures (not a member, or missing the required role) are more than 20% of at
 * least 5 users Discord answered for (members plus departures; lookup errors say nothing either
 * way): a whole guild doesn't leave at once, a wrong guild id or role list does.
 */
export function breakerTrips(answered: number, departures: number): boolean {
  return answered >= BREAKER_MIN_CHECKED && departures > answered * BREAKER_MAX_DEPARTURE_SHARE;
}

/**
 * Most departures the rolling window lets through: max(3, 20% of `population`), the users there
 * were at the start of the window (the active ones plus those the window offboarded), so the limit
 * doesn't shrink as the window's own offboardings are spent.
 */
export function windowBreakerLimit(population: number): number {
  return Math.max(BREAKER_WINDOW_MIN_DEPARTURES, population * BREAKER_MAX_DEPARTURE_SHARE);
}

/**
 * The rolling breaker (D-34): true when `recent` (users re-verification offboarded in the window who
 * are still in grace for it) plus this batch's `departures` exceed windowBreakerLimit. It clears by
 * itself: once the window has passed those offboardings, or once an admin restores the users (they
 * are active again) or confirms the offboarding (the reason becomes 'admin'). A tripped run
 * offboards nobody, so it never adds to `recent`.
 */
export function windowBreakerTrips(recent: number, departures: number, active: number): boolean {
  return recent + departures > windowBreakerLimit(active + recent);
}

/** Judges both breakers for a batch with departures; logs one error when either trips. */
async function breakerTripped(
  deps: ReverifyDeps,
  batch: {
    checked: number;
    answered: number;
    departures: readonly Departure[];
    now: Date;
    intervalHours: number;
  },
): Promise<boolean> {
  const departures = batch.departures.length;
  const { recent, active } = await windowCounts(deps.db, batch.now, batch.intervalHours);
  const rules = [
    ...(breakerTrips(batch.answered, departures) ? ['batch'] : []),
    ...(windowBreakerTrips(recent, departures, active) ? ['window'] : []),
  ];
  if (rules.length === 0) return false;
  deps.logger.error(
    {
      rules,
      checked: batch.checked,
      answered: batch.answered,
      departures,
      recentOffboarded: recent,
      activeUsers: active,
      windowLimit: windowBreakerLimit(active + recent),
      windowHours: batch.intervalHours,
    },
    'discord re-verification: too many members missing, offboarding nobody (check DISCORD_GUILD_ID, the bot and DISCORD_REQUIRED_ROLE_IDS)',
  );
  return true;
}

/**
 * The rolling window's counts. `recent`: distinct users with a 'user.offboarded' audit entry by
 * re-verification (actor label 'worker', no actor user) since now − intervalHours who are still in
 * grace for a membership reason. The audit entry says when and by whom; the user row says whether it
 * still stands, so a restore or an admin's own offboarding takes the user out of the count. Only
 * the window's entries are read (audit_log_at_idx). `active`: users now active.
 */
async function windowCounts(
  db: Db,
  now: Date,
  intervalHours: number,
): Promise<{ recent: number; active: number }> {
  const since = new Date(now.getTime() - intervalHours * HOUR_MS);
  const [recent] = await db
    .select({ n: countDistinct(users.id) })
    .from(auditLog)
    .innerJoin(users, eq(users.id, auditLog.targetId))
    .where(
      and(
        gt(auditLog.at, since),
        eq(auditLog.action, 'user.offboarded'),
        eq(auditLog.targetType, 'user'),
        eq(auditLog.actorLabel, REVERIFY_ACTOR),
        isNull(auditLog.actorUserId),
        eq(users.status, 'grace'),
        inArray(users.offboardReason, [...REVERIFY_REASONS]),
      ),
    );
  const [active] = await db.select({ n: count() }).from(users).where(eq(users.status, 'active'));
  return { recent: recent?.n ?? 0, active: active?.n ?? 0 };
}

/**
 * Active users with a Discord id never verified or verified before now − intervalHours. Fewest
 * consecutive failures first, then oldest: a failed check leaves last_verified_at as it was, so
 * ordering by it alone would put users whose lookups keep failing (a deleted Discord account, say)
 * at the head of every batch, and batchSize of them would starve everyone else for good.
 */
async function loadDueUsers(
  db: Db,
  now: Date,
  intervalHours: number,
  batchSize: number,
): Promise<DueUser[]> {
  const cutoff = new Date(now.getTime() - intervalHours * HOUR_MS);
  const rows = await db
    .select({ id: users.id, discordId: users.discordId, verifyFailures: users.verifyFailures })
    .from(users)
    .where(
      and(
        eq(users.status, 'active'),
        isNotNull(users.discordId),
        or(isNull(users.lastVerifiedAt), lt(users.lastVerifiedAt, cutoff)),
      ),
    )
    .orderBy(asc(users.verifyFailures), sql`${users.lastVerifiedAt} ASC NULLS FIRST`, asc(users.id))
    .limit(Math.max(1, Math.floor(batchSize)));
  return rows.flatMap((r) => (r.discordId ? [{ ...r, discordId: r.discordId }] : []));
}

/**
 * One lookup per user, in order (429s are honoured inside the client). Stops the batch early when
 * the rest would fail the same way:
 *  - the FIRST lookup says the bot can't look members up at all: a rejected token (401/403) or
 *    Unknown Guild (404 10004, DISCORD-1). Any other 404 code (10013 Unknown User, …) is about that
 *    one user and must not stop the run: they stay due, and would stop every later run too;
 *  - any lookup still rate-limited after the client's retries: the member-lookup bucket is shared
 *    by the whole guild, so the next lookup would only wait and fail again.
 */
async function lookUpAll(deps: ReverifyDeps, due: readonly DueUser[]): Promise<Check[]> {
  const checks: Check[] = [];
  for (const user of due) {
    const lookup = await fetchGuildMemberAsBot(deps.botToken, deps.policy.guildId, user.discordId, {
      fetchFn: deps.fetchFn,
      sleep: deps.sleep,
    });
    const verdict = evaluateMembership(lookup, deps.policy);
    checks.push({ user, lookup, verdict });
    if (checks.length === 1 && isRunWide(lookup)) {
      deps.logger.error(
        {
          reason: verdict.kind === 'error' ? verdict.reason : null,
          ...lookupStatus(lookup),
          due: due.length,
        },
        'discord re-verification stopped: the bot cannot look up guild members (see DISCORD-1)',
      );
      break;
    }
    if (lookup.kind === 'error' && lookup.reason === 'rate_limited') {
      deps.logger.warn(
        { checked: checks.length, due: due.length },
        'discord re-verification stopped: still rate-limited, the rest waits for the next run',
      );
      break;
    }
  }
  return checks;
}

/** An answer about the bot or the guild, not the user: every lookup of the run would get it. */
function isRunWide(lookup: MemberLookup): boolean {
  if (lookup.kind !== 'error') return false;
  return lookup.reason === 'auth' || (lookup.status === 404 && lookup.code === UNKNOWN_GUILD);
}

/**
 * Runs one user's bookkeeping write. A database error there (a lock timeout, say) must not end the
 * run for everyone after them, and is logged by code only: its message carries the bound values
 * (names, roles; DB-3).
 */
async function recordSafely(
  deps: ReverifyDeps,
  user: DueUser,
  write: () => Promise<void>,
): Promise<void> {
  try {
    await write();
  } catch (err) {
    deps.logger.error(
      { userId: user.id, pgCode: pgErrorCode(err) ?? 'unknown' },
      'discord re-verification: recording the result failed',
    );
  }
}

/** Refreshes what the member object says (as at sign-in) and resets the failure streak. */
async function recordMember(
  deps: ReverifyDeps,
  user: DueUser,
  member: DiscordGuildMember,
  now: Date,
): Promise<void> {
  const profile = member.user
    ? {
        name: displayName(member.user, member),
        image: avatarUrl(member.user, deps.policy.guildId, member),
      }
    : {};
  await deps.db
    .update(users)
    .set({
      ...profile,
      nickname: member.nick ?? null,
      roles: member.roles,
      isAdmin: isAdmin(user.discordId, member.roles, deps.policy),
      lastVerifiedAt: now,
      verifyFailures: 0,
    })
    .where(and(eq(users.id, user.id), eq(users.status, 'active')));
}

/**
 * Fail open (D-34): count the failure, never offboard. last_verified_at stays, so the user is due
 * again next run. Alerts (error log) once, when the streak reaches alertAfterFailures.
 */
async function recordFailure(
  deps: ReverifyDeps,
  user: DueUser,
  reason: FailureReason,
  lookup: MemberLookup,
): Promise<void> {
  deps.metrics.discordVerifyFailures.inc({ kind: reason });
  const [row] = await deps.db
    .update(users)
    .set({ verifyFailures: sql`${users.verifyFailures} + 1` })
    .where(eq(users.id, user.id))
    .returning({ verifyFailures: users.verifyFailures });
  const count = row?.verifyFailures ?? user.verifyFailures + 1;
  const log = { userId: user.id, reason, failures: count, ...lookupStatus(lookup) };
  if (count === (deps.alertAfterFailures ?? 5)) {
    deps.logger.error(log, 'discord re-verification keeps failing for a user');
  } else {
    deps.logger.warn(log, 'discord re-verification failed (fail open)');
  }
}

/** Offboards each departure in its own transaction; one failing doesn't stop the others. */
async function offboardDepartures(
  deps: ReverifyDeps,
  departures: readonly Departure[],
  now: Date,
): Promise<number> {
  let offboarded = 0;
  for (const { user, verdict } of departures) {
    const reason = verdict.kind === 'not_member' ? 'left_guild' : 'lost_role';
    try {
      const result = await offboardUser(deps.db, {
        userId: user.id,
        reason,
        graceDays: deps.graceDays,
        now,
        actorLabel: REVERIFY_ACTOR,
      });
      offboarded++;
      deps.logger.info(
        {
          userId: user.id,
          reason,
          transferred: result.transferred.length,
          hidden: result.hidden.length,
        },
        'discord re-verification: user offboarded',
      );
    } catch (err) {
      // Code only: a DB error's message carries bound parameters (DB-3).
      deps.logger.error(
        { userId: user.id, reason, pgCode: pgErrorCode(err) },
        'offboarding failed',
      );
    }
  }
  return offboarded;
}

function lookupStatus(lookup: MemberLookup): { status?: number; code?: number } {
  return lookup.kind === 'error' ? { status: lookup.status, code: lookup.code } : {};
}
