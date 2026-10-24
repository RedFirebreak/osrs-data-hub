import { formatGp, formatNumber } from '../format';
import { isRecord } from '../guards';
import { INT32_MAX } from '../ints';
import { parseCombatTaskName } from './combat-task';
import { deathOutcome } from './death';
import { highestValueItem, storedEventData } from './stored';
import {
  EVENT_TYPES,
  UNKNOWN_EVENT_ICON,
  isKnownEventType,
  storedEventType,
  type EventIconHint,
  type KnownEventType,
} from './types';

/** Minimal event shape needed to describe it (a stored row, possibly redacted). */
export interface DescribableEvent {
  type: string;
  valueGp: number | null;
  skill: string | null;
  level: number | null;
  tier: string | null;
  points: number | null;
  /** The stored original event: {type, data, eventId, timestamp}. */
  data: unknown;
}

export interface EventDescription {
  /** Short title, e.g. "Loot", "Level up", "Death". */
  title: string;
  /**
   * One line for toasts and feeds, starting with the account name, e.g.
   * "Zezima received Dragon warhammer (38.2M) from Lizardman shaman",
   * "Zezima reached level 85 Strength", "Zezima died (reclaim fee up to 500K)",
   * "Zezima completed a Grandmaster combat task: No Pressure (6 points)",
   * "Zezima completed an Easy Varrock diary task", "Zezima: new collection log item Tanzanite fang",
   * "A superior Nechryarch spawned for Zezima", unknown types: "Zezima: questComplete".
   */
  line: string;
  /** lucide-react icon name hint. */
  icon: EventIconHint;
}

/** Longest piece of plugin-sent text (item, NPC, source, task name…) put into a line. */
const MAX_TEXT = 100;
/** Largest stack the plugin can send (a Java int). */
const MAX_QUANTITY = INT32_MAX;
/**
 * C0, DEL and C1 controls (U+009B is a terminal CSI) and the bidi marks, embeddings, overrides and
 * isolates (U+202E would reverse the rest of the toast line).
 */
const CONTROL_CHARS = /[\p{Cc}\p{Bidi_Control}]/gu;

/**
 * Human-readable description of a stored event. Never throws on odd data.
 *
 * - `type` may be the stored lower_snake name or the plugin's name (`levelUp`).
 * - Columns win over the stored data (valueGp, skill, level, tier, points); data fills the gaps.
 * - Values use formatGp. Loot: highestValueItem (with "N x" for a stack) + valueGp + source.text;
 *   pk_loot: "opened a loot chest worth …". Death: "was killed by <killerName>" when a killer is
 *   known (not "?"), then by deathOutcome (D-123): "(safe death)" for SAFE and EXCEPTIONAL ones,
 *   "(items lost: …)" for a death to a player or in the Wilderness, and otherwise what the grave
 *   costs: "(reclaim fee up to …)", "(free to reclaim)", or "(items in the grave)" without items. level_up: "reached level N Skill", and
 *   "reached combat level N" for "Combat". Tiers are capitalized with "a"/"an" to match.
 * - Plugin-sent text is trimmed, control characters (C0, DEL, C1 and bidi controls) become spaces,
 *   whitespace runs collapse and it is cut to 100 characters; anything missing, redacted or of the
 *   wrong type is left out of the line (a level, points or stack size must be an integer, a stack a
 *   Java int above 1). A blank account name reads "Someone". Unknown types use the type itself as the
 *   title, with the 'bell' icon.
 */
export function describeEvent(accountName: string, event: DescribableEvent): EventDescription {
  const name = clean(accountName) ?? 'Someone';
  const type = storedType(event.type);
  if (!isKnownEventType(type)) {
    const label = clean(type) ?? 'event';
    return { title: label, line: `${name}: ${label}`, icon: UNKNOWN_EVENT_ICON };
  }
  const { title, icon } = EVENT_TYPES[type];
  return { title, line: lineFor(type, name, event), icon };
}

/** The line of a known type. No default case: a type added to EVENT_TYPES must get its line here. */
function lineFor(type: KnownEventType, name: string, event: DescribableEvent): string {
  const d = storedEventData(event.data);

  switch (type) {
    case 'loot': {
      const top = highestValueItem(event.data);
      const item = clean(top.name);
      const value = finite(event.valueGp) ?? finite(d.totalValue);
      const source = clean(isRecord(d.source) ? d.source.text : undefined);
      let line = `${name} received ${item === null ? 'loot' : stack(item, top.quantity)}`;
      if (value !== null) line += ` (${formatGp(value)})`;
      if (source !== null) line += ` from ${source}`;
      return line;
    }
    case 'pk_loot': {
      const value = finite(event.valueGp) ?? finite(d.totalValue);
      return `${name} opened a loot chest${value === null ? '' : ` worth ${formatGp(value)}`}`;
    }
    case 'death': {
      const killerName = clean(d.killerName);
      const killer = killerName === '?' ? null : killerName;
      let line = killer === null ? `${name} died` : `${name} was killed by ${killer}`;
      const outcome = deathOutcome(d, finite(event.valueGp));
      if (outcome.kind === 'safe') line += ' (safe death)';
      else if (outcome.kind === 'lost') {
        if (outcome.value !== null) line += ` (items lost: ${formatGp(outcome.value)})`;
      } else if (outcome.fee === null) line += ' (items in the grave)';
      else if (outcome.fee === 0) line += ' (free to reclaim)';
      else line += ` (reclaim fee up to ${formatGp(outcome.fee)})`;
      return line;
    }
    case 'level_up': {
      // A level_up row's data holds the whole levelUp array; only a one-element array identifies it.
      const sent = isRecord(event.data) ? event.data.data : undefined;
      const only = Array.isArray(sent) && sent.length === 1 ? sent[0] : undefined;
      const fallback = isRecord(only) ? only : {};
      const skill = clean(event.skill) ?? clean(fallback.skill);
      const level = integer(event.level) ?? integer(fallback.level);
      let line: string;
      if (skill !== null && skill.toLowerCase() === 'combat') {
        line =
          level === null
            ? `${name} gained a combat level`
            : `${name} reached combat level ${level}`;
      } else if (skill !== null) {
        line =
          level === null
            ? `${name} gained a ${skill} level`
            : `${name} reached level ${level} ${skill}`;
      } else {
        line = level === null ? `${name} gained a level` : `${name} reached level ${level}`;
      }
      return line;
    }
    case 'collection_log': {
      const item = clean(d.itemName);
      return `${name}: new collection log item${item === null ? '' : ` ${item}`}`;
    }
    case 'superior_spawn': {
      const npc = clean(d.name);
      return `A superior ${npc === null ? '' : `${npc} `}spawned for ${name}`;
    }
    case 'achievement_diary': {
      const words = [capitalize(clean(event.tier) ?? clean(d.tier)), clean(d.region)].filter(
        (w): w is string => w !== null,
      );
      const what =
        words.length === 0 ? 'a diary task' : `${article(words[0])} ${words.join(' ')} diary task`;
      return `${name} completed ${what}`;
    }
    case 'combat_task': {
      const tier = capitalize(clean(event.tier) ?? clean(d.tier));
      const parsed = parseCombatTaskName(d.taskName);
      const task = clean(parsed.name);
      const points = integer(event.points) ?? parsed.points;
      let line = `${name} completed ${tier === null ? 'a' : `${article(tier)} ${tier}`} combat task`;
      if (task !== null) line += `: ${task}`;
      if (points !== null) line += ` (${points} ${points === 1 ? 'point' : 'points'})`;
      return line;
    }
  }
}

/** Plugin type names are mapped to the stored names; anything else is used as is. */
function storedType(type: unknown): string {
  return storedEventType(typeof type === 'string' ? type : String(type));
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) ? (value as number) : null;
}

/** Display-safe text: control characters → spaces, whitespace collapsed, trimmed, capped. */
function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  const chars = Array.from(text);
  return chars.length > MAX_TEXT ? `${chars.slice(0, MAX_TEXT - 1).join('')}…` : text;
}

/** "Coins" or "125,000 x Coins". */
function stack(item: string, quantity: unknown): string {
  const n = integer(quantity);
  return n !== null && n > 1 && n <= MAX_QUANTITY ? `${formatNumber(n)} x ${item}` : item;
}

function capitalize(text: string | null): string | null {
  if (text === null) return null;
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function article(word: string | undefined): string {
  return word !== undefined && /^[aeiou]/i.test(word) ? 'an' : 'a';
}
