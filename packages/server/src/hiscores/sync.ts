/**
 * The sync-hiscores job (D-105): looks up the accounts that are due (hiscoreDue in @hub/core) on the
 * official hiscores, one request at a time, at most one every HISCORES_REQUEST_INTERVAL_MS, and
 * stores what it read. A push-back from the hiscores pauses every lookup (./pause) and ends the run.
 *
 * Storing an `ok` lookup, under the account's lock (ingest/lock):
 * - while the account is offline and the plugin reports its skills, the hiscores are compared with
 *   them (planHiscoreXp): a skill the hiscores have lower is a `mismatch` and nothing is stored;
 *   XP they have higher (play outside RuneLite) is written to xp_samples at the lookup time, noted
 *   in hiscore_xp_fills and raised in latest_state.skills;
 * - every activity score that changed since the last lookup goes into activity_scores;
 * - the row in account_hiscores gets the tables as read.
 */
import {
  HISCORE_DUE_REASONS,
  HISCORE_MISMATCH_RETRY_MS,
  HISCORE_NOT_FOUND_RETRY_MS,
  XP_BUCKET_MS,
  floorTo,
  hiscoreDue,
  hiscoreModeForAccountType,
  hiscoreUrl,
  isOnline,
  normalizeName,
  planHiscoreXp,
  planScoreRows,
  readStoredHiscores,
  type HiscoreDueReason,
  type HiscoreMode,
  type Hiscores,
  type ScoreRow,
} from '@hub/core';
import {
  accountHiscores,
  activityScores,
  hiscoreXpFills,
  latestState,
  osrsAccounts,
  skills as skillsTable,
  xpSamples,
  type Db,
  type HiscoreStatus,
  type Tx,
} from '@hub/db';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { knownChunks, lockChunkCreation, rememberChunks, xpChunkKey } from '../ingest/chunks';
import { lockAccount } from '../ingest/lock';
import { setLocalTimeouts } from '../ingest/store';
import { getMetrics, type HiscoreLookupResult, type HubMetrics } from '../metrics';
import { lookupHiscores, type FetchFn, type HiscoreLookup } from './client';
import { getHiscorePause, type HiscorePause } from './pause';

/** How long one run may keep looking up: the job is scheduled every minute. */
const DEFAULT_BUDGET_MS = 45_000;

export interface SyncHiscoresDeps {
  /** HISCORES_URL, without a trailing slash. */
  baseUrl: string;
  /** HISCORES_REQUEST_INTERVAL_MS: the least time between two requests. */
  requestIntervalMs: number;
  fetchFn?: FetchFn;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pause?: HiscorePause;
  /** How long the run may go on starting lookups. */
  budgetMs?: number;
  metrics?: HubMetrics;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

export interface SyncHiscoresResult {
  /** Accounts due at the start of the run. */
  due: number;
  /** Lookups by result. */
  results: Record<HiscoreLookupResult, number>;
  /** Lookups that added XP to an account. */
  filled: number;
  /** The end of the pause the run found or caused; null when not paused. */
  pausedUntil: string | null;
}

/** One account that may be due, as loaded for hiscoreDue. */
interface Candidate {
  id: number;
  name: string;
  mode: HiscoreMode;
  online: boolean;
  reason: HiscoreDueReason;
  lastAttemptAt: Date | null;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function syncHiscores(db: Db, deps: SyncHiscoresDeps): Promise<SyncHiscoresResult> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const pause = deps.pause ?? getHiscorePause();
  const metrics = deps.metrics ?? getMetrics();
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const result: SyncHiscoresResult = {
    due: 0,
    results: { ok: 0, not_found: 0, mismatch: 0, throttled: 0, error: 0 },
    filled: 0,
    pausedUntil: null,
  };
  const started = now();
  const paused = pause.pausedUntil(started);
  if (paused) return { ...result, pausedUntil: paused.toISOString() };

  const due = await loadDue(db, started);
  result.due = due.length;
  let requests = 0;
  /** Waits out the interval before every request but the run's first. */
  const lookup = async (mode: HiscoreMode, name: string): Promise<HiscoreLookup> => {
    if (requests++ > 0) await sleep(deps.requestIntervalMs);
    return lookupHiscores(hiscoreUrl(deps.baseUrl, mode, name), { fetchFn: deps.fetchFn });
  };

  for (const account of due) {
    // The next request waits out the interval first: stop when that would end past the budget.
    const wait = requests > 0 ? deps.requestIntervalMs : 0;
    if (now().getTime() - started.getTime() + wait >= budgetMs) break;
    const main = await lookup('regular', account.name);
    let modeTable: HiscoreLookup | null = null;
    if (main.kind === 'ok' && account.mode !== 'regular') {
      modeTable = await lookup(account.mode, account.name);
    }
    const failed = [main, modeTable].find((l) => l?.kind === 'throttled' || l?.kind === 'error');
    if (failed) {
      const kind = failed.kind as 'throttled' | 'error';
      const until = pause.trip(now(), failed.kind === 'throttled' ? failed.retryAfterMs : null);
      result.results[kind]++;
      metrics.hiscoreLookups.inc({ result: kind });
      result.pausedUntil = until.toISOString();
      deps.logger?.warn(
        { status: failed.kind === 'throttled' ? failed.status : null, until: result.pausedUntil },
        'hiscores pushed back: lookups paused',
      );
      break;
    }
    pause.reset();
    const stored = await storeLookup(db, account, {
      main,
      modeTable: modeTable?.kind === 'ok' ? modeTable.hiscores : null,
      at: now(),
    });
    if (stored.status === null) continue; // the account was deleted meanwhile
    result.results[stored.status]++;
    metrics.hiscoreLookups.inc({ result: stored.status });
    if (stored.filled) {
      result.filled++;
      metrics.hiscoreXpFills.inc();
    }
  }
  return result;
}

/**
 * Every active account that is due now, most urgent first (HISCORE_DUE_REASONS order), then the
 * longest since its last lookup. An account whose owner is in grace (status hidden) waits.
 */
async function loadDue(db: Db, now: Date): Promise<Candidate[]> {
  const { rows } = await db.execute<{
    id: number;
    name: string;
    account_type: number | null;
    lookup_name: string | null;
    mode: HiscoreMode | null;
    last_attempt_at: string | Date | null;
    next_attempt_at: string | Date | null;
    game_state: string | null;
    last_seen: string | Date | null;
    tick_delay: number | null;
    last_session_end: string | Date | null;
  }>(sql`
    SELECT a.id, a.current_name AS name, a.account_type,
           h.lookup_name, h.mode, h.last_attempt_at, h.next_attempt_at,
           ls.game_state, ls.last_seen, ls.tick_delay,
           (SELECT ps.ended_at FROM play_sessions ps WHERE ps.account_id = a.id
            ORDER BY ps.started_at DESC LIMIT 1) AS last_session_end
    FROM osrs_accounts a
    LEFT JOIN account_hiscores h ON h.account_id = a.id
    LEFT JOIN latest_state ls ON ls.account_id = a.id
    WHERE a.status = 'active'`);
  const out: Candidate[] = [];
  for (const r of rows) {
    const mode = hiscoreModeForAccountType(r.account_type);
    const online = isOnline(
      { gameState: r.game_state, lastSeen: toDate(r.last_seen), tickDelay: r.tick_delay },
      now,
    );
    const lastAttemptAt = toDate(r.last_attempt_at);
    const reason = hiscoreDue(
      {
        name: r.name,
        mode,
        online,
        lastSessionEnd: toDate(r.last_session_end),
        lookup:
          r.lookup_name === null || r.mode === null || lastAttemptAt === null
            ? null
            : {
                name: r.lookup_name,
                mode: r.mode,
                lastAttemptAt,
                nextAttemptAt: toDate(r.next_attempt_at),
              },
      },
      now,
    );
    if (reason) out.push({ id: r.id, name: r.name, mode, online, reason, lastAttemptAt });
  }
  const rank = (c: Candidate) => HISCORE_DUE_REASONS.indexOf(c.reason);
  return out.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.lastAttemptAt?.getTime() ?? 0) - (b.lastAttemptAt?.getTime() ?? 0) ||
      a.id - b.id,
  );
}

function toDate(v: string | Date | null): Date | null {
  if (v === null) return null;
  return v instanceof Date ? v : new Date(v);
}

type Skills = Record<string, { xp: number; level: number }>;

/** Stores one lookup (see the module comment). The main table's lookup is `ok` or `not_found`. */
async function storeLookup(
  db: Db,
  account: Candidate,
  lookup: { main: HiscoreLookup; modeTable: Hiscores | null; at: Date },
): Promise<{ status: HiscoreStatus | null; filled: boolean }> {
  const { at } = lookup;
  const known = knownChunks(db);
  const chunk = xpChunkKey(at);
  const out = await db.transaction(async (tx) => {
    await setLocalTimeouts(tx);
    await lockAccount(tx, account.id);
    const [exists] = await tx
      .select({ id: osrsAccounts.id })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.id, account.id));
    if (!exists) return null; // deleted meanwhile
    const [prev] = await tx
      .select({
        main: accountHiscores.main,
        status: accountHiscores.status,
        lookupName: accountHiscores.lookupName,
      })
      .from(accountHiscores)
      .where(eq(accountHiscores.accountId, account.id));
    const attempt = { lookupName: account.name, mode: account.mode, lastAttemptAt: at };

    if (lookup.main.kind !== 'ok') {
      await upsertRow(tx, account.id, {
        ...attempt,
        status: 'not_found',
        nextAttemptAt: new Date(at.getTime() + HISCORE_NOT_FOUND_RETRY_MS),
      });
      return { status: 'not_found' as const, filled: false, wroteXp: false };
    }
    const main = lookup.main.hiscores;

    // The XP check and fill: only offline (the hiscores lag behind a player in game) and only
    // against skills the plugin reports, which is also what tells a reused name apart.
    let fill: { writes: ReturnType<typeof planHiscoreXp>['writes']; skills: Skills } | null = null;
    if (!account.online) {
      const [state] = await tx
        .select({ skills: latestState.skills })
        .from(latestState)
        .where(eq(latestState.accountId, account.id));
      const reported = state?.skills as Skills | null | undefined;
      if (reported) {
        const plan = planHiscoreXp(reported, main.skills);
        if (plan.mismatchSkill !== null) {
          await upsertRow(tx, account.id, {
            ...attempt,
            status: 'mismatch',
            nextAttemptAt: new Date(at.getTime() + HISCORE_MISMATCH_RETRY_MS),
          });
          return { status: 'mismatch' as const, filled: false, wroteXp: false };
        }
        if (plan.skills) fill = { writes: plan.writes, skills: plan.skills };
      }
    }

    // The scores continue a series only from an ok lookup of the same name (planScoreRows).
    const continues =
      prev !== undefined &&
      prev.status === 'ok' &&
      normalizeName(prev.lookupName) === normalizeName(account.name);
    await insertScores(
      tx,
      account.id,
      planScoreRows(continues ? prevActivities(prev.main) : null, main.activities),
      at,
    );
    let wroteXp = false;
    if (fill) wroteXp = await writeXp(tx, account.id, fill, at, known, chunk);
    await upsertRow(tx, account.id, {
      ...attempt,
      status: 'ok',
      nextAttemptAt: null,
      fetchedAt: at,
      main,
      modeTable: lookup.modeTable,
    });
    return { status: 'ok' as const, filled: wroteXp, wroteXp };
  });
  if (!out) return { status: null, filled: false };
  if (out.wroteXp) rememberChunks(known, [chunk]);
  return { status: out.status, filled: out.filled };
}

async function upsertRow(
  tx: Tx,
  accountId: number,
  row: {
    lookupName: string;
    mode: HiscoreMode;
    status: HiscoreStatus;
    lastAttemptAt: Date;
    nextAttemptAt: Date | null;
    fetchedAt?: Date;
    main?: Hiscores;
    modeTable?: Hiscores | null;
  },
): Promise<void> {
  // A lookup that isn't ok keeps the tables (and fetched_at) of the last one that was.
  const data =
    row.fetchedAt === undefined
      ? {}
      : { fetchedAt: row.fetchedAt, main: row.main ?? null, modeTable: row.modeTable ?? null };
  const values = {
    lookupName: row.lookupName,
    mode: row.mode,
    status: row.status,
    lastAttemptAt: row.lastAttemptAt,
    nextAttemptAt: row.nextAttemptAt,
    ...data,
  };
  await tx
    .insert(accountHiscores)
    .values({ accountId, ...values })
    .onConflictDoUpdate({ target: accountHiscores.accountId, set: values });
}

/** The activity scores of a stored main table, by name. */
function prevActivities(stored: unknown): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of readStoredHiscores(stored)?.activities ?? [])
    if (a.score !== null) out.set(a.name, a.score);
  return out;
}

/** The rows planScoreRows planned, at the lookup's time. */
async function insertScores(
  tx: Tx,
  accountId: number,
  rows: readonly ScoreRow[],
  at: Date,
): Promise<void> {
  if (rows.length === 0) return;
  await tx
    .insert(activityScores)
    .values(rows.map((r) => ({ accountId, readAt: at, ...r })))
    .onConflictDoNothing();
}

/**
 * The XP fill: samples in the 5-minute bucket of the lookup (a bucket keeps the highest value, as
 * ingest's do), and the raised skills in latest_state. False when a skill has no id (never seen,
 * which planHiscoreXp's own rule rules out).
 */
async function writeXp(
  tx: Tx,
  accountId: number,
  fill: { writes: ReturnType<typeof planHiscoreXp>['writes']; skills: Skills },
  at: Date,
  known: ReadonlySet<string>,
  chunk: string,
): Promise<boolean> {
  const names = fill.writes.map((w) => w.skill);
  const ids = new Map(
    (
      await tx
        .select({ id: skillsTable.id, name: skillsTable.name })
        .from(skillsTable)
        .where(inArray(skillsTable.name, names))
    ).map((r) => [r.name, r.id]),
  );
  if (names.some((n) => !ids.has(n))) return false;
  // See TSDB-12: one chunk creator at a time, before the first hypertable write.
  await lockChunkCreation(tx, known, [chunk]);
  const bucket = floorTo(at, XP_BUCKET_MS);
  const rows = fill.writes.map((w) => ({
    accountId,
    skillId: ids.get(w.skill)!,
    bucket,
    xp: w.xp,
    level: w.level,
  }));
  await tx
    .insert(xpSamples)
    .values(rows)
    .onConflictDoUpdate({
      target: [xpSamples.accountId, xpSamples.skillId, xpSamples.bucket],
      set: {
        xp: sql`GREATEST(${xpSamples.xp}, excluded.xp)`,
        level: sql`GREATEST(${xpSamples.level}, excluded.level)`,
      },
    });
  await tx
    .insert(hiscoreXpFills)
    .values(rows.map(({ level: _, ...r }) => r))
    .onConflictDoUpdate({
      target: [hiscoreXpFills.accountId, hiscoreXpFills.skillId, hiscoreXpFills.bucket],
      set: { xp: sql`GREATEST(${hiscoreXpFills.xp}, excluded.xp)` },
    });
  await tx
    .update(latestState)
    .set({ skills: fill.skills, skillsUpdatedAt: at })
    .where(eq(latestState.accountId, accountId));
  return true;
}
