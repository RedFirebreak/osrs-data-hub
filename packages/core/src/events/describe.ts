import { formatGp, formatNumber } from '../format';
import { parseCombatTaskName } from './combat-task';
import { EVENT_TYPE_MAP } from './types';

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
   * "Zezima reached level 85 Strength", "Zezima died (inventory value lost: 34.9K)",
   * "Zezima completed a Grandmaster combat task: No Pressure (6 points)",
   * "Zezima completed an Easy Varrock diary task", "Zezima: new collection log item Tanzanite fang",
   * "A superior Nechryarch spawned for Zezima", unknown types: "Zezima: questComplete".
   */
  line: string;
  /** lucide-react icon name hint: 'gift' | 'skull' | 'trending-up' | 'book' | 'swords' | 'map' | 'sparkles' | 'bell'. */
  icon: string;
}

/** Longest piece of plugin-sent text (item, NPC, source, task name…) put into a line. */
const MAX_TEXT = 100;
/** Largest stack the plugin can send (a Java int). */
const MAX_QUANTITY = 2_147_483_647;
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
 *   known (not "?"), "(inventory value lost: …)" for dangerous deaths and "(safe death)" for SAFE and
 *   EXCEPTIONAL ones (the plugin never loses items there). level_up: "reached level N Skill", and
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
  const envelope = isObject(event.data) ? event.data : {};
  const d = isObject(envelope.data) ? envelope.data : {};

  switch (type) {
    case 'loot': {
      const top = isObject(d.highestValueItem) ? d.highestValueItem : {};
      const item = clean(top.name);
      const value = finite(event.valueGp) ?? finite(d.totalValue);
      const source = clean(isObject(d.source) ? d.source.text : undefined);
      let line = `${name} received ${item === null ? 'loot' : stack(item, top.quantity)}`;
      if (value !== null) line += ` (${formatGp(value)})`;
      if (source !== null) line += ` from ${source}`;
      return { title: 'Loot', line, icon: 'gift' };
    }
    case 'pk_loot': {
      const value = finite(event.valueGp) ?? finite(d.totalValue);
      const line = `${name} opened a loot chest${value === null ? '' : ` worth ${formatGp(value)}`}`;
      return { title: 'Loot chest', line, icon: 'gift' };
    }
    case 'death': {
      const killerName = clean(d.killerName);
      const killer = killerName === '?' ? null : killerName;
      const danger = typeof d.danger === 'string' ? d.danger.trim().toUpperCase() : null;
      const value = finite(event.valueGp) ?? finite(d.valueLost);
      let line = killer === null ? `${name} died` : `${name} was killed by ${killer}`;
      if (danger === 'SAFE' || danger === 'EXCEPTIONAL') line += ' (safe death)';
      else if (value !== null) line += ` (inventory value lost: ${formatGp(value)})`;
      return { title: 'Death', line, icon: 'skull' };
    }
    case 'level_up': {
      // A level_up row's data holds the whole levelUp array; only a one-element array identifies it.
      const only =
        Array.isArray(envelope.data) && envelope.data.length === 1 ? envelope.data[0] : undefined;
      const fallback = isObject(only) ? only : {};
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
      return { title: 'Level up', line, icon: 'trending-up' };
    }
    case 'collection_log': {
      const item = clean(d.itemName);
      const line = `${name}: new collection log item${item === null ? '' : ` ${item}`}`;
      return { title: 'Collection log', line, icon: 'book' };
    }
    case 'superior_spawn': {
      const npc = clean(d.name);
      const line = `A superior ${npc === null ? '' : `${npc} `}spawned for ${name}`;
      return { title: 'Superior spawn', line, icon: 'sparkles' };
    }
    case 'achievement_diary': {
      const words = [capitalize(clean(event.tier) ?? clean(d.tier)), clean(d.region)].filter(
        (w): w is string => w !== null,
      );
      const what =
        words.length === 0 ? 'a diary task' : `${article(words[0])} ${words.join(' ')} diary task`;
      return { title: 'Achievement diary', line: `${name} completed ${what}`, icon: 'map' };
    }
    case 'combat_task': {
      const tier = capitalize(clean(event.tier) ?? clean(d.tier));
      const parsed = parseCombatTaskName(d.taskName);
      const task = clean(parsed.name);
      const points = integer(event.points) ?? parsed.points;
      let line = `${name} completed ${tier === null ? 'a' : `${article(tier)} ${tier}`} combat task`;
      if (task !== null) line += `: ${task}`;
      if (points !== null) line += ` (${points} ${points === 1 ? 'point' : 'points'})`;
      return { title: 'Combat task', line, icon: 'swords' };
    }
    default: {
      const label = clean(type) ?? 'event';
      return { title: label, line: `${name}: ${label}`, icon: 'bell' };
    }
  }
}

/** Plugin type names are mapped to the stored names; anything else is used as is. */
function storedType(type: unknown): string {
  const t = typeof type === 'string' ? type : String(type);
  return Object.hasOwn(EVENT_TYPE_MAP, t) ? EVENT_TYPE_MAP[t as keyof typeof EVENT_TYPE_MAP] : t;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
