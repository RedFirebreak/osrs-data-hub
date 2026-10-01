/**
 * The guild activity feed's hub-wide filter (D-81), set by an admin: loot below a minimum value, and
 * level-ups past 99 (virtual levels, PLUGIN-9), stay out of the guild page's activity feed. The
 * account page's timeline, the dashboard, toasts and the public API are not filtered: the events are
 * stored and shown everywhere else as before.
 */
import { isLootEvent } from './events/types';
import { MAX_REAL_LEVEL } from './skills';

export interface GuildFeedFilter {
  /** Loot and PK loot below this many gp (a missing value counts as 0) are left out. 0 = all. */
  minLootValue: number;
  /** Whether level-ups past 99 in a skill are shown. */
  showVirtualLevels: boolean;
}

export const DEFAULT_GUILD_FEED_FILTER: GuildFeedFilter = {
  minLootValue: 0,
  showVirtualLevels: false,
};

/** Highest accepted minimum loot value (2^31, above the max cash stack), as for toasts. */
export const MAX_GUILD_FEED_MIN_LOOT_VALUE = 2 ** 31;

/**
 * The plugin's levelUp "skill" for combat level, whose real maximum is 126: never a virtual level.
 * It only appears in levelUp events (payload/parse.ts).
 */
export const COMBAT_LEVEL_SKILL = 'Combat';

/** Whether a level_up row is a virtual level: a skill (not Combat) past 99. */
export function isVirtualLevelUp(event: {
  type: string;
  skill: string | null;
  level: number | null;
}): boolean {
  return (
    event.type === 'level_up' &&
    event.skill !== COMBAT_LEVEL_SKILL &&
    event.level !== null &&
    event.level > MAX_REAL_LEVEL
  );
}

/**
 * Whether an event belongs in the guild activity feed under `filter`. Every type but loot, PK loot
 * and level-ups always does. The same rule as the feed's SQL (packages/server list-feed.ts), which
 * the guild page's live events are checked against in the browser.
 */
export function inGuildFeed(
  event: { type: string; valueGp: number | null; skill: string | null; level: number | null },
  filter: GuildFeedFilter,
): boolean {
  if (isLootEvent(event.type) && (event.valueGp ?? 0) < filter.minLootValue) return false;
  if (!filter.showVirtualLevels && isVirtualLevelUp(event)) return false;
  return true;
}
