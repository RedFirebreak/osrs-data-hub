/**
 * An account's current state (latest_state) as the public API returns it, section by section, for
 * GET /accounts/{id}, GET /snapshot and the data export. Each section is read only when the
 * principal holds its category on the account; what a section contains comes from the account page's
 * helpers (accounts/account-page.ts, accounts/load.ts), so the UI and the API agree on it.
 */
import { floorTo, itemsValue, type Category } from '@hub/core';
import { latestState, type DbOrTx } from '@hub/db';
import { getTableColumns, inArray, sql } from 'drizzle-orm';
import { locationOf, skillLevels, vitalsOf } from '../accounts/account-page';
import { toPresence } from '../accounts/load';
import { latestOf } from '../accounts/sections';
import { parseSkills } from '../accounts/xp';
import type { ApiItem, ApiMeter, ApiSection } from './types';
import { toApiItems } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** When the vitals section was last received: the newest of its three parts, or null. */
function vitalsUpdatedAt(row: LatestRow): Date | null {
  return latestOf(row.healthUpdatedAt, row.prayerUpdatedAt, row.spellbookUpdatedAt);
}

/** Skills, or null when the plugin never sent stats (or they aren't readable). */
export function skillsOf(row: LatestRow): ApiSkills | null {
  if (row.skillsUpdatedAt === null) return null;
  const parsed = parseSkills(row.skills);
  return parsed === null ? null : skillLevels(parsed);
}

/** Items with their value, or null when the section was never sent. */
export function itemsOf(
  items: unknown,
  updatedAt: Date | null,
): { items: ApiItem[]; value: number } | null {
  if (updatedAt === null || !Array.isArray(items)) return null;
  return { items: toApiItems(items), value: itemsValue(items) ?? 0 };
}

/**
 * An account's current state by category, as GET /accounts/{id} and the export return it. Each
 * section follows ApiSection: `shared: true` with its data, `shared: false` when the plugin never
 * sent it, and OMITTED when the reader doesn't hold the category on the account.
 */
export interface ApiStateSections {
  /** `activity`; `updatedAt` = when the hub last heard from the account. */
  presence?: ApiSection<ApiPresence>;
  /** `activity`. */
  vitals?: ApiSection<ApiVitals>;
  /** `stats`. */
  skills?: ApiSection<ApiSkills>;
  /** `location_live`; its `updatedAt` is exact (a live position is presence by nature). */
  location?: ApiSection<ApiLocation>;
  /** `equipment`. */
  equipment?: ApiSection<ApiEquipment>;
  /** `inventory`. */
  inventory?: ApiSection<ApiInventory>;
}

/**
 * The current state of one account for a reader holding `categories` on it: its latest_state row
 * (the large jsonb sections only where a category allows them) as accountSections.
 */
export async function loadAccountSections(
  db: DbOrTx,
  accountId: number,
  categories: ReadonlySet<Category>,
  now: Date,
): Promise<ApiStateSections> {
  const rows = await loadLatestRows(db, [accountId], {
    skills: categories.has('stats'),
    equipment: categories.has('equipment'),
    inventory: categories.has('inventory'),
  });
  return accountSections(categories, rows.get(accountId), now);
}

/**
 * The sections of `row` that `categories` allow, in the order above; the others are omitted.
 * Without `activity`, the `updatedAt` of skills, equipment and inventory is cut to the UTC day: the
 * plugin sends them with every periodic update, so the exact time would be the last-seen time the
 * owner didn't share (D-50). (The account page cuts to the viewer's local day instead: by design.)
 */
export function accountSections(
  categories: ReadonlySet<Category>,
  row: LatestRow | undefined,
  now: Date,
): ApiStateSections {
  const can = (c: Category) => categories.has(c);
  const stamp = (at: Date | null) => (at === null || can('activity') ? at : floorTo(at, DAY_MS));
  const out: ApiStateSections = {};
  if (can('activity')) {
    out.presence = section(row?.lastSeen ?? null, row ? toPresence(row, now) : null);
    out.vitals = section(row ? vitalsUpdatedAt(row) : null, row ? vitalsOf(row) : null);
  }
  if (can('stats')) {
    out.skills = section(stamp(row?.skillsUpdatedAt ?? null), row ? skillsOf(row) : null);
  }
  if (can('location_live')) {
    out.location = section(row?.locationUpdatedAt ?? null, row ? locationOf(row, now) : null);
  }
  if (can('equipment')) {
    const at = row?.equipmentUpdatedAt ?? null;
    out.equipment = section(stamp(at), row ? itemsOf(row.equipment, at) : null);
  }
  if (can('inventory')) {
    const at = row?.inventoryUpdatedAt ?? null;
    out.inventory = section(stamp(at), row ? itemsOf(row.inventory, at) : null);
  }
  return out;
}

/** A shared section when there is data and a time, else "not shared". */
function section<T extends object>(updatedAt: Date | null, data: T | null): ApiSection<T> {
  if (updatedAt === null || data === null) return { shared: false, updatedAt: null };
  return { ...data, shared: true, updatedAt: updatedAt.toISOString() };
}
