/**
 * The official OSRS hiscores (D-105): the hub reads an account's public skills and activity scores
 * (boss kill counts, clues, minigames) from Jagex's `index_lite.json`, by the account's current name.
 * Pure rules only; fetching and storing are in packages/server/src/hiscores.
 */
import { isRecord } from './guards';
import type { XpWrite } from './ingest/types';
import { normalizeName, toJagexName } from './names';
import { OVERALL, overallXp, totalLevel } from './skills';

/** The hiscore tables the hub reads: the main one, and an iron account's own (D-105). */
export const HISCORE_MODES = [
  'regular',
  'ironman',
  'hardcore_ironman',
  'ultimate_ironman',
] as const;
export type HiscoreMode = (typeof HISCORE_MODES)[number];

/** The `m=` path segment of each mode's table. */
export const HISCORE_TABLES: Readonly<Record<HiscoreMode, string>> = {
  regular: 'hiscore_oldschool',
  ironman: 'hiscore_oldschool_ironman',
  hardcore_ironman: 'hiscore_oldschool_hardcore_ironman',
  ultimate_ironman: 'hiscore_oldschool_ultimate',
};

/**
 * The table an account is ranked on besides the main one, from the IRONMAN varbit the plugin sends
 * (0 normal, 1 IM, 2 UIM, 3 HCIM, 4 GIM, 5 HCGIM, 6 UGIM). Group irons are `regular`: whether they
 * appear on the solo iron tables is unverified (D-105). Unknown (null) is `regular` too.
 */
export function hiscoreModeForAccountType(accountType: number | null | undefined): HiscoreMode {
  switch (accountType) {
    case 1:
      return 'ironman';
    case 2:
      return 'ultimate_ironman';
    case 3:
      return 'hardcore_ironman';
    default:
      return 'regular';
  }
}

/**
 * The lookup URL of `name` on `mode`'s table under `base` (HISCORES_URL, no trailing slash). The name
 * is put the way RuneLite's own lookup sends it: toJagexName, so a non-breaking space the client
 * reports becomes a plain one.
 */
export function hiscoreUrl(base: string, mode: HiscoreMode, name: string): string {
  const player = encodeURIComponent(toJagexName(name));
  return `${base}/m=${HISCORE_TABLES[mode]}/index_lite.json?player=${player}`;
}

/** One skill row. `rank` and `xp` are null where the hiscores say -1 (not listed). */
export interface HiscoreSkill {
  name: string;
  rank: number | null;
  /** The real level (at most 99; the total level for Overall), as the hiscores give it. */
  level: number;
  xp: number | null;
}

/** One activity row (a boss, a clue tier, a minigame). Null where the hiscores say -1. */
export interface HiscoreActivity {
  name: string;
  rank: number | null;
  score: number | null;
}

export interface Hiscores {
  skills: HiscoreSkill[];
  activities: HiscoreActivity[];
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * `index_lite.json` → Hiscores, leniently: rows are read by name, never by position (Jagex inserts
 * a row whenever a boss is added, which shifts every position after it), a row without a string name
 * is skipped, and -1 (or anything that isn't a whole number ≥ 0) is null. Null when the body isn't
 * the hiscores' shape at all (no `skills` array with an Overall row), e.g. a Cloudflare page.
 */
export function parseHiscores(body: unknown): Hiscores | null {
  if (!isRecord(body) || !Array.isArray(body.skills) || !Array.isArray(body.activities)) {
    return null;
  }
  const skills: HiscoreSkill[] = [];
  for (const row of body.skills as unknown[]) {
    if (!isRecord(row) || typeof row.name !== 'string' || row.name === '') continue;
    skills.push({
      name: row.name,
      rank: positive(row.rank),
      level: count(row.level) ?? 1,
      xp: count(row.xp),
    });
  }
  if (!skills.some((s) => s.name === OVERALL)) return null;
  const activities: HiscoreActivity[] = [];
  for (const row of body.activities as unknown[]) {
    if (!isRecord(row) || typeof row.name !== 'string' || row.name === '') continue;
    activities.push({ name: row.name, rank: positive(row.rank), score: count(row.score) });
  }
  return { skills, activities };
}

/** A rank: a whole number ≥ 1, else null. */
function positive(value: unknown): number | null {
  const n = count(value);
  return n !== null && n >= 1 ? n : null;
}

function nullableCount(value: unknown): number | null | undefined {
  if (value === null) return null;
  return count(value) ?? undefined;
}

/**
 * Hiscores as the hub stored them (account_hiscores jsonb: the parser's output, with null for "not
 * listed"), read back leniently: a row that doesn't have that shape is skipped. Null when the value
 * isn't a stored table at all.
 */
export function readStoredHiscores(value: unknown): Hiscores | null {
  if (!isRecord(value) || !Array.isArray(value.skills) || !Array.isArray(value.activities)) {
    return null;
  }
  const skills: HiscoreSkill[] = [];
  for (const row of value.skills as unknown[]) {
    if (!isRecord(row) || typeof row.name !== 'string') continue;
    const rank = nullableCount(row.rank);
    const xp = nullableCount(row.xp);
    const level = count(row.level);
    if (rank === undefined || xp === undefined || level === null) continue;
    skills.push({ name: row.name, rank, level, xp });
  }
  const activities: HiscoreActivity[] = [];
  for (const row of value.activities as unknown[]) {
    if (!isRecord(row) || typeof row.name !== 'string') continue;
    const rank = nullableCount(row.rank);
    const score = nullableCount(row.score);
    if (rank === undefined || score === undefined) continue;
    activities.push({ name: row.name, rank, score });
  }
  return { skills, activities };
}

export const ACTIVITY_KINDS = ['boss', 'clue', 'activity'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** The activity rows that aren't bosses or clues (minigames, points, the collection log). */
const NON_BOSS_ACTIVITIES: ReadonlySet<string> = new Set([
  'Grid Points',
  'League Points',
  'Deadman Points',
  'Bounty Hunter - Hunter',
  'Bounty Hunter - Rogue',
  'Bounty Hunter (Legacy) - Hunter',
  'Bounty Hunter (Legacy) - Rogue',
  'LMS - Rank',
  'PvP Arena - Rank',
  'Soul Wars Zeal',
  'Rifts closed',
  'Colosseum Glory',
  'Collections Logged',
]);

/**
 * What an activity row is: `clue` for the "Clue Scrolls (…)" rows, `activity` for the known
 * minigames and points, `boss` for everything else. A row the hub doesn't know counts as a boss,
 * since nearly every row Jagex added since kill counts came to the hiscores (2019) is one; the rows
 * the hiscores list among the bosses (Barrows Chests, Wintertodt, Tempoross…) are bosses here too.
 */
export function activityKind(name: string): ActivityKind {
  if (name.startsWith('Clue Scrolls')) return 'clue';
  return NON_BOSS_ACTIVITIES.has(name) ? 'activity' : 'boss';
}

/** XP needed for each level 1..126 (RuneLite Experience), index = level − 1. */
const XP_FOR_LEVEL: readonly number[] = (() => {
  const table = [0];
  let points = 0;
  for (let level = 1; level < 126; level++) {
    points += Math.floor(level + 300 * 2 ** (level / 7));
    table.push(Math.floor(points / 4));
  }
  return table;
})();

/** The virtual level (1..126) for an XP value, as the plugin sends it (RuneLite getLevelForXp). */
export function levelForXp(xp: number): number {
  let level = 1;
  while (level < XP_FOR_LEVEL.length && XP_FOR_LEVEL[level]! <= xp) level++;
  return level;
}

/** One activity_scores row to write. */
export interface ScoreRow {
  activity: string;
  score: number;
  /** Starts a series: never a gain (see planScoreRows). */
  baseline: boolean;
}

/**
 * The activity_scores rows of an `ok` lookup (D-105). `prev` is the score of each activity at the
 * account's last `ok` lookup, or null when this lookup doesn't continue a series: the first lookup,
 * the first after a rename, or the first after one that wasn't `ok` (what happened in between is
 * unknown). Then every known score is a baseline. Otherwise a changed score is a row, and a score
 * seen for the first time is a baseline too: below the hiscores' threshold it was unknown, not 0.
 */
export function planScoreRows(
  prev: ReadonlyMap<string, number> | null,
  activities: readonly HiscoreActivity[],
): ScoreRow[] {
  const rows: ScoreRow[] = [];
  for (const { name, score } of activities) {
    if (score === null) continue;
    const before = prev?.get(name);
    if (before === score) continue;
    rows.push({ activity: name, score, baseline: before === undefined });
  }
  return rows;
}

type Skills = Record<string, { xp: number; level: number }>;

export interface HiscoreXpPlan {
  /** Skills whose XP the hiscores have higher than the hub, then Overall when anything changed. */
  writes: XpWrite[];
  /** `prev` with the raised skills, for latest_state.skills; null when nothing is raised. */
  skills: Skills | null;
  /** The first skill the hiscores have LOWER than the hub (they lag, or the name is someone else's). */
  mismatchSkill: string | null;
}

/**
 * Which XP the hiscores add to what the plugin reported (D-105): the gap a player made outside
 * RuneLite (mobile, the official client). Only skills the plugin already reports (`prev`, the
 * account's latest_state skills) and that the hiscores rank are compared; Overall is derived as
 * ingest does (overallXp/totalLevel of the merged skills), never taken from the hiscores.
 *
 * Any compared skill lower on the hiscores than in `prev` is a mismatch: nothing is written, since
 * either the hiscores haven't caught up or the name now belongs to someone else. Otherwise every
 * skill the hiscores have higher is written with the virtual level for its XP.
 */
export function planHiscoreXp(prev: Skills, hiscore: readonly HiscoreSkill[]): HiscoreXpPlan {
  const raised: Skills = {};
  for (const row of hiscore) {
    if (row.name === OVERALL || row.rank === null || row.xp === null) continue;
    const old = prev[row.name];
    if (old === undefined) continue;
    if (row.xp < old.xp) return { writes: [], skills: null, mismatchSkill: row.name };
    if (row.xp > old.xp) raised[row.name] = { xp: row.xp, level: levelForXp(row.xp) };
  }
  const names = Object.keys(raised);
  if (names.length === 0) return { writes: [], skills: null, mismatchSkill: null };
  const merged: Skills = { ...prev, ...raised };
  const writes: XpWrite[] = names.map((skill) => ({ skill, ...raised[skill]! }));
  writes.push({ skill: OVERALL, xp: overallXp(merged), level: totalLevel(merged) });
  return { writes, skills: merged, mismatchSkill: null };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** How long after a session ends its account is looked up: the hiscores take a while to catch up. */
export const HISCORE_SESSION_DELAY_MS = 10 * MINUTE_MS;
/** Every account is looked up at least this often, which catches play outside RuneLite. */
export const HISCORE_REFRESH_MS = 24 * HOUR_MS;
/** The wait after a `not_found` (unless the account is renamed meanwhile). */
export const HISCORE_NOT_FOUND_RETRY_MS = 6 * HOUR_MS;
/** The wait after a `mismatch`. */
export const HISCORE_MISMATCH_RETRY_MS = HOUR_MS;

/** Why an account is looked up now, most urgent first. */
export const HISCORE_DUE_REASONS = ['new', 'renamed', 'session', 'daily'] as const;
export type HiscoreDueReason = (typeof HISCORE_DUE_REASONS)[number];

export interface HiscoreDueInput {
  /** The account's current name and the mode its account type gives (hiscoreModeForAccountType). */
  name: string;
  mode: HiscoreMode;
  /** In game now (presence): its hiscores lag behind what it is doing. */
  online: boolean;
  /** When its latest play session ended; null while none has ended. */
  lastSessionEnd: Date | null;
  /** Its latest lookup; null when it was never looked up. */
  lookup: {
    name: string;
    mode: HiscoreMode;
    lastAttemptAt: Date;
    nextAttemptAt: Date | null;
  } | null;
}

/**
 * Whether an account is looked up now, and why (D-105), or null:
 * - `new`: never looked up, even while online, so a new account shows its kill counts at once;
 * - otherwise never while online (the hiscores lag, which would read as a mismatch), nor before the
 *   lookup's nextAttemptAt, except for a rename;
 * - `renamed`: its name (as the game compares names) or its mode changed since the last lookup;
 * - `session`: a session ended after the last lookup, at least HISCORE_SESSION_DELAY_MS ago;
 * - `daily`: the last lookup is HISCORE_REFRESH_MS old.
 */
export function hiscoreDue(input: HiscoreDueInput, now: Date): HiscoreDueReason | null {
  const { lookup } = input;
  if (lookup === null) return 'new';
  if (input.online) return null;
  const t = now.getTime();
  if (normalizeName(lookup.name) !== normalizeName(input.name) || lookup.mode !== input.mode) {
    return 'renamed';
  }
  if (lookup.nextAttemptAt !== null && lookup.nextAttemptAt.getTime() > t) return null;
  const last = lookup.lastAttemptAt.getTime();
  const ended = input.lastSessionEnd?.getTime();
  if (ended !== undefined && ended > last && ended <= t - HISCORE_SESSION_DELAY_MS) {
    return 'session';
  }
  return last <= t - HISCORE_REFRESH_MS ? 'daily' : null;
}
