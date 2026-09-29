/**
 * An account's current state (latest_state) as the public API returns it, section by section, for
 * GET /accounts/{id} and GET /snapshot. Each section is read only when the principal holds its
 * category on the account; the mapping helpers are the account page's (accounts/account-page.ts), so
 * the UI and the API agree on what a section contains.
 */
import {
  LOCATION_STALE_MS,
  OVERALL,
  isOnline,
  itemsValue,
  overallXp,
  realLevel,
  sortSkillsForDisplay,
  totalLevel,
} from '@hub/core';
import { latestState, type DbOrTx } from '@hub/db';
import { getTableColumns, inArray, sql } from 'drizzle-orm';
import { parseLocation, vitalsOf } from '../accounts/account-page';
import { latestOf } from '../accounts/sections';
import { parseSkills } from '../accounts/xp';
import type { ApiItem, ApiMeter } from './types';
import { toApiItems } from './types';

export type LatestRow = typeof latestState.$inferSelect;

/** Presence (`activity`). */
export interface ApiPresence {
  /** In game now (D-28: the last game state is an in-game one and the presence timeout hasn't run out). */
  online: boolean;
  /** Last known world, also while offline. */
  world: number | null;
  /** The last known world is a special one (league, deadman, …), handoff §7.1.9. */
  specialWorld: boolean;
  /** Last known game state as the plugin sent it (LOGGED_IN, LOGIN_SCREEN, HOPPING, …). */
  gameState: string | null;
  /** When the hub last received anything for the account. */
  lastSeen: string;
}

/** HP, prayer and spellbook (`activity`); each null until the plugin first sent it. */
export interface ApiVitals {
  hp: ApiMeter | null;
  prayer: ApiMeter | null;
  spellbook: string | null;
}

export interface ApiSkill {
  /** The plugin's skill name ("Attack", …); "Overall" is derived by the hub. */
  skill: string;
  /** As sent: virtual above 99 (PLUGIN-9). For Overall, the real total level (D-44). */
  level: number;
  /** min(level, 99); for Overall the real total level. */
  realLevel: number;
  xp: number;
}

/** Skills (`stats`): Overall first, then the in-game grid order. */
export interface ApiSkills {
  /** Σ min(level, 99), as the game shows it (D-44). */
  totalLevel: number;
  overallXp: number;
  skills: ApiSkill[];
}

/** The live position (`location_live`). */
export interface ApiLocation {
  x: number;
  y: number;
  plane: number;
  isOnBoat: boolean;
  /** No location received for more than 2 minutes (D-18, D-74): the player may be elsewhere now. */
  stale: boolean;
}

/** Worn equipment (`equipment`). `value` is Σ gePrice × quantity. */
export interface ApiEquipment {
  items: ApiItem[];
  value: number;
}

/** The inventory (`inventory`), one entry per slot. `value` is Σ gePrice × quantity. */
export interface ApiInventory {
  items: ApiItem[];
  value: number;
}

/**
 * latest_state rows by account id. The large jsonb sections are read only when `need` says some
 * account's category allows them (the live map's key, activity + location_live, never pays for
 * inventories); the others come back null.
 */
export async function loadLatestRows(
  db: DbOrTx,
  accountIds: readonly number[],
  need: { skills: boolean; equipment: boolean; inventory: boolean },
): Promise<Map<number, LatestRow>> {
  const out = new Map<number, LatestRow>();
  if (accountIds.length === 0) return out;
  const columns = getTableColumns(latestState);
  const skipped = sql<unknown>`null`;
  const rows = await db
    .select({
      ...columns,
      skills: need.skills ? columns.skills : skipped,
      equipment: need.equipment ? columns.equipment : skipped,
      inventory: need.inventory ? columns.inventory : skipped,
    })
    .from(latestState)
    .where(inArray(latestState.accountId, [...accountIds]));
  for (const row of rows) out.set(row.accountId, row);
  return out;
}

/** Presence from a latest_state row (online per @hub/core isOnline). */
export function presenceOf(row: LatestRow, now: Date): ApiPresence {
  return {
    online: isOnline(row, now),
    world: row.world,
    specialWorld: row.specialWorld,
    gameState: row.gameState,
    lastSeen: row.lastSeen.toISOString(),
  };
}

/** When the vitals section was last received: the newest of its three parts, or null. */
export function vitalsUpdatedAt(row: LatestRow): Date | null {
  return latestOf(row.healthUpdatedAt, row.prayerUpdatedAt, row.spellbookUpdatedAt);
}

/** HP, prayer and spellbook (the account page's vitalsOf). */
export function vitalsFrom(row: LatestRow): ApiVitals {
  return vitalsOf(row);
}

/** Skills, or null when the plugin never sent stats (or they aren't readable). */
export function skillsOf(row: LatestRow): ApiSkills | null {
  if (row.skillsUpdatedAt === null) return null;
  const parsed = parseSkills(row.skills);
  if (parsed === null) return null;
  const total = totalLevel(parsed);
  const overall = overallXp(parsed);
  const skills = sortSkillsForDisplay([OVERALL, ...Object.keys(parsed)]).map((skill): ApiSkill => {
    if (skill === OVERALL) return { skill, level: total, realLevel: total, xp: overall };
    const { xp, level } = parsed[skill] as { xp: number; level: number };
    return { skill, level, realLevel: realLevel(level), xp };
  });
  return { totalLevel: total, overallXp: overall, skills };
}

/** The live location, or null when never sent (or not a location). */
export function locationOf(row: LatestRow, now: Date): ApiLocation | null {
  const at = row.locationUpdatedAt;
  const loc = at === null ? null : parseLocation(row.location);
  if (at === null || loc === null) return null;
  return { ...loc, stale: now.getTime() - at.getTime() > LOCATION_STALE_MS };
}

/** Items with their value, or null when the section was never sent. */
export function itemsOf(
  items: unknown,
  updatedAt: Date | null,
): { items: ApiItem[]; value: number } | null {
  if (updatedAt === null || !Array.isArray(items)) return null;
  return { items: toApiItems(items), value: itemsValue(items) ?? 0 };
}
