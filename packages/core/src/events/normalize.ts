import { isRecord } from '../guards';
import { INT32_MAX, INT32_MIN, SMALLINT_MAX, SMALLINT_MIN } from '../ints';
import { stripNul } from '../json';
import type { RawEvent } from '../payload/types';
import { clampEventTime } from '../time';
import { parseCombatTaskName } from './combat-task';
import {
  knownPluginEventType,
  type KnownEventType,
  type NormalizedEvent,
  type NormalizeResult,
  type ShutdownReason,
} from './types';
import { itemsValue } from './values';

/**
 * levelUp elements kept per event: the plugin sends at most one per skill plus Combat (25 today;
 * parsePayload allows 64 skills). It bounds sub_index (a smallint) and the rows per event, each of
 * which stores the whole event.
 */
const MAX_LEVEL_UPS = 64;

const SHUTDOWN_REASONS: Readonly<Record<string, ShutdownReason>> = {
  Logout: 'logout',
  Shutdown: 'shutdown',
  Disabled: 'disabled',
};

/** The columns every type fills the same way; the per-type ones default to null. */
type Columns = Pick<
  NormalizedEvent,
  'valueGp' | 'itemId' | 'npcId' | 'skill' | 'level' | 'tier' | 'points'
>;

const NO_COLUMNS: Columns = {
  valueGp: null,
  itemId: null,
  npcId: null,
  skill: null,
  level: null,
  tier: null,
  points: null,
};

/**
 * Normalizes plugin events into `events` rows (handoff §7.5):
 * - type: the stored name of a known plugin type (EVENT_TYPES); unknown types kept as sent. The type
 *   is cleaned (see text columns below) before anything else, so a type that reads as a known name
 *   is treated as one.
 * - occurredAt: clampEventTime(event.timestamp, recv).
 * - clientShutdown: not a row; data "Logout" | "Shutdown" | "Disabled" → shutdown reason
 *   logout | shutdown | disabled (anything else → 'shutdown'). The LAST one wins.
 * - levelUp: data must be an array; each element {skill: string, level: int} becomes a row with
 *   subIndex = its index in the original array (stable across resends). Invalid elements are
 *   skipped and counted; a non-array levelUp is skipped as one event. skill "Combat" is kept. A
 *   skill must be a non-blank string (it is trimmed) and a level an integer in the smallint range.
 *   Only the first 64 elements are used (the plugin sends one per skill plus Combat); elements past
 *   index 63 are skipped and counted, which bounds sub_index (a smallint) and the rows per event.
 * - loot / pkLoot: valueGp = Σ gePrice × quantity over data.items (64-bit via BigInt, clamped to
 *   Number.MAX_SAFE_INTEGER) when items is a valid array (every entry an object with integer
 *   gePrice and quantity; [] sums to 0), else data.totalValue, else null;
 *   itemId = data.highestValueItem.id; npcId = data.npcId.
 * - death: valueGp = Σ over data.lostItems (valid as above), else data.valueLost;
 *   npcId = data.killerNpcId.
 * - collectionLog: valueGp = data.value; itemId = data.itemId unless negative (-1 = unresolved →
 *   null).
 * - superiorSpawn: npcId = data.npcId.
 * - achievementDiary: tier = lowercased trimmed data.tier.
 * - combatTask: tier likewise; points = parseCombatTaskName(data.taskName).points.
 * - data: the original event object (`raw`) through stripNul (NUL removed, lone surrogates → U+FFFD,
 *   in all strings and keys). A levelUp's rows all carry the whole event.
 * Numbers that aren't finite/integers where an int is expected become null (never throw), and so
 * do ids outside int32 and level/points outside smallint (the column types). A fallback value
 * (totalValue, valueLost, value) is clamped to [0, Number.MAX_SAFE_INTEGER]. An empty tier is null.
 * Text columns (pluginEventId, type, skill, tier) are cleaned like `data` (stripNul: NUL removed,
 * lone surrogates → U+FFFD): Postgres text rejects NUL like jsonb does (DB-1), and parsePayload leaves
 * type/eventId as sent. An event whose eventId is not a string, or is empty after that, is skipped
 * and counted.
 */
export function normalizeEvents(events: readonly RawEvent[], recv: Date): NormalizeResult {
  const rows: NormalizedEvent[] = [];
  let shutdown: NormalizeResult['shutdown'] = null;
  let skipped = 0;

  for (const event of events) {
    const occurredAt = clampEventTime(event.timestamp, recv);
    // Cleaned first, so a type that reads as a known name after cleaning is treated as one.
    const pluginType = stripNul(String(event.type));

    if (pluginType === 'clientShutdown') {
      const data = event.data;
      const reason =
        typeof data === 'string' && Object.hasOwn(SHUTDOWN_REASONS, data)
          ? SHUTDOWN_REASONS[data]
          : undefined;
      shutdown = { reason: reason ?? 'shutdown', occurredAt };
      continue;
    }

    const pluginEventId = typeof event.eventId === 'string' ? stripNul(event.eventId) : '';
    if (pluginEventId === '') {
      skipped += 1;
      continue;
    }
    // By the plugin's name only: a type sent under a stored name ('level_up') is an unknown type.
    const known = knownPluginEventType(pluginType);
    const type = known ?? pluginType;
    const base = { pluginEventId, type, occurredAt, data: stripNul(event.raw) };

    if (known === 'level_up') {
      if (!Array.isArray(event.data)) {
        skipped += 1;
        continue;
      }
      event.data.forEach((element: unknown, subIndex) => {
        const levelUp = subIndex < MAX_LEVEL_UPS ? parseLevelUp(element) : null;
        if (levelUp === null) {
          skipped += 1;
          return;
        }
        rows.push({ ...base, subIndex, ...NO_COLUMNS, ...levelUp });
      });
      continue;
    }

    rows.push({ ...base, subIndex: 0, ...NO_COLUMNS, ...columnsFor(known, event.data) });
  }

  return { events: rows, shutdown, skipped };
}

function parseLevelUp(element: unknown): { skill: string; level: number } | null {
  if (!isRecord(element)) return null;
  const skill = typeof element.skill === 'string' ? stripNul(element.skill).trim() : '';
  const level = smallint(element.level);
  if (skill === '' || level === null) return null;
  return { skill, level };
}

/** Type-specific columns, for every type but level_up (unknown types get none). */
function columnsFor(type: KnownEventType | undefined, data: unknown): Partial<Columns> {
  const d = isRecord(data) ? data : {};
  switch (type) {
    case 'loot':
    case 'pk_loot':
      return {
        valueGp: recomputedValue(d.items) ?? gp(d.totalValue),
        itemId: int32(isRecord(d.highestValueItem) ? d.highestValueItem.id : undefined),
        npcId: int32(d.npcId),
      };
    case 'death':
      return {
        valueGp: recomputedValue(d.lostItems) ?? gp(d.valueLost),
        npcId: int32(d.killerNpcId),
      };
    case 'collection_log': {
      const itemId = int32(d.itemId);
      return { valueGp: gp(d.value), itemId: itemId !== null && itemId >= 0 ? itemId : null };
    }
    case 'superior_spawn':
      return { npcId: int32(d.npcId) };
    case 'achievement_diary':
      return { tier: tier(d.tier) };
    case 'combat_task':
      return { tier: tier(d.tier), points: smallint(parseCombatTaskName(d.taskName).points) };
    default:
      return {};
  }
}

/**
 * itemsValue over an array whose every entry is an item with integer gePrice and quantity; null
 * otherwise, so the plugin's own total is used instead of a partial sum.
 */
function recomputedValue(items: unknown): number | null {
  if (!Array.isArray(items)) return null;
  const valid = items.every(
    (item) => isRecord(item) && Number.isInteger(item.gePrice) && Number.isInteger(item.quantity),
  );
  return valid ? itemsValue(items) : null;
}

function intIn(value: unknown, min: number, max: number): number | null {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max
    ? (value as number)
    : null;
}

function int32(value: unknown): number | null {
  return intIn(value, INT32_MIN, INT32_MAX);
}

function smallint(value: unknown): number | null {
  return intIn(value, SMALLINT_MIN, SMALLINT_MAX);
}

/** A gp amount (a Java long) for a bigint column: an integer clamped to [0, MAX_SAFE_INTEGER]. */
function gp(value: unknown): number | null {
  if (!Number.isInteger(value)) return null;
  return Math.min(Math.max(value as number, 0), Number.MAX_SAFE_INTEGER);
}

function tier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = stripNul(value).trim().toLowerCase();
  return t === '' ? null : t;
}
