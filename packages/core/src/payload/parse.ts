import { z } from 'zod';
import { isPlainObject } from '../guards';
import { INT32_MAX, INT32_MIN, SMALLINT_MAX, SMALLINT_MIN } from '../ints';
import { stripNul } from '../json';
import { OVERALL } from '../skills';
import type { ParseResult, PlayerSnapshot, RawEvent, SkillValue } from './types';

/** Cap on listed sections/reasons, so a hostile body can't bloat raw_payloads.meta. */
const MAX_LISTED = 64;
/**
 * Nesting limit for an event element or a player section. The plugin nests ≈5 levels; a 256 KB body
 * can nest ~100k, which parses fine but overflows the stack in stripNul and JSON.stringify.
 */
const MAX_DEPTH = 32;
/**
 * stats.skills limits. The plugin sends 24 skills named by Skill.getName() (≤ 12 characters); a name
 * becomes a row of the `skills` table, whose unique index can't hold a long one (54000).
 */
const MAX_SKILLS = 64;
const MAX_SKILL_NAME = 64;
/** player.locationTrail limit. The plugin keeps at most 300 points per message. */
const MAX_TRAIL_POINTS = 512;
/** Names the plugin never puts in stats (plugin Skill.values()); accepting them corrupts the totals. */
const RESERVED_SKILLS: ReadonlyMap<string, string> = new Map([
  [OVERALL, 'Overall is derived by the hub, never sent by the plugin'],
  ['Combat', 'Combat only appears in levelUp events, never in stats'],
  ['__proto__', 'not a skill name'],
]);

const int32 = z.number().int().min(INT32_MIN).max(INT32_MAX);
const nonNegInt32 = z.number().int().min(0).max(INT32_MAX);
const smallint = z.number().int().min(SMALLINT_MIN).max(SMALLINT_MAX);

/** The plugin sends accountType and world as strings ("3", "302"); numbers are accepted too. */
const intFromStringOrNumber = (min: number, max: number) =>
  z
    .union([
      z.number(),
      z
        .string()
        .regex(/^[0-9]{1,10}$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(min).max(max));

const meter = z.looseObject({ current: smallint, max: smallint });

const itemsSection = z.looseObject({
  items: z.array(
    z.looseObject({
      id: int32,
      quantity: int32,
      gePrice: z.number().int(),
      haPrice: z.number().int().optional(),
      name: z.string().optional(),
      equipmentSlot: z.string().optional(),
      inventorySlot: nonNegInt32.optional(),
      rarity: z.number().optional(),
    }),
  ),
});

const PLAYER = {
  name: z.string().min(1).max(64),
  accountHash: z.string().min(1).max(128),
  accountType: intFromStringOrNumber(0, 127),
  world: intFromStringOrNumber(1, INT32_MAX),
  worldTypes: z.array(z.string()),
  location: z.looseObject({
    x: int32,
    y: int32,
    plane: smallint,
    isOnBoat: z.boolean().optional(),
  }),
  locationTrail: z
    .array(
      z.looseObject({
        x: int32,
        y: int32,
        plane: smallint,
        isOnBoat: z.boolean().optional(),
        timestamp: z.number().int(),
      }),
    )
    .max(MAX_TRAIL_POINTS, `more than ${MAX_TRAIL_POINTS} points`),
  spellbook: z.looseObject({ id: smallint, name: z.string() }),
  // z.custom keeps the object itself: zod's looseObject silently drops a "__proto__" key.
  stats: z.looseObject({
    skills: z.custom<Record<string, unknown>>(isPlainObject, 'expected an object'),
  }),
  skill: z.looseObject({ xp: nonNegInt32, level: z.number().int().min(0).max(SMALLINT_MAX) }),
};

const eventEnvelope = z.looseObject({
  type: z.string().min(1).max(64),
  eventId: z.string().min(1).max(128),
});

/**
 * Parses the ingest body text. `not_json` when JSON.parse fails, `not_object` when the root is not a
 * plain object. Otherwise ALWAYS ok, section by section and lenient (handoff §7.1.5, D-10):
 *
 * - zod with `z.looseObject` at every level: zod 4's `z.object` strips unknown keys (ZOD-1).
 * - A key whose value is JSON `null` counts as missing, at every level (Gson never writes nulls): a
 *   null optional key is left out, a null required key invalidates its section. An array element
 *   that is null is a wrong shape, and an event's `data` may be null.
 * - root: `events` (missing → [] and a skipped reason; not an array → [], section `events` and a
 *   reason), `state` (string or null), `tickDelay` (integer 0..2^31−1, else 0), `timestamp` (finite
 *   number, else null). A present but invalid state/tickDelay/timestamp also records a reason.
 * - Sanitizing: every player section and `state` go through stripNul before validation (NUL removed,
 *   lone surrogates → U+FFFD, in strings and keys; lengths are checked afterwards). Postgres text and
 *   jsonb reject NUL and jsonb rejects lone surrogates (DB-1), and the snapshot reaches latest_state
 *   and accounts without further cleaning. Events are returned as sent: `raw`/`data` are the original
 *   objects and `type`/`eventId` keep such characters (normalizeEvents sanitizes all of them).
 * - player: if not an object → player null (section `player` and a reason). Each section is
 *   validated on its own; a section with the wrong shape is omitted and its path pushed to
 *   skipped.sections: name (string, 1..64 chars), accountHash (string, 1..128 chars), accountType
 *   (string of digits or number, an integer 0..127 → number), world (string of digits or number, an
 *   integer 1..2^31−1 → number), worldTypes (string[]), location ({x, y: int32, plane: smallint,
 *   isOnBoat?: boolean}), locationTrail (plugin 1.6: an array of at most 512 points {x, y: int32,
 *   plane: smallint, isOnBoat?: boolean, timestamp: safe integer}, oldest first; an invalid point or
 *   more points drops the whole section; [] is kept), health / prayerPoints ({current, max}: smallint integers → `health` /
 *   `prayer`), spellbook ({id: smallint integer, name: string}), stats.skills (object of at most 64
 *   entries {xp: integer 0..2^31−1, level: integer 0..32767}, more → section `player.stats`; an
 *   invalid ENTRY, or a name that is empty, longer than 64 characters, "Overall" (hub-derived),
 *   "Combat" (levelUp-only) or "__proto__", drops only that skill and records
 *   `player.stats.skills.<name>`; with no valid entry left `skills` is omitted),
 *   inventory.items / equipment.items (arrays of {id: int32, quantity: int32, gePrice: safe integer,
 *   haPrice?: safe integer, name?: string, equipmentSlot?: string, inventorySlot?: integer
 *   0..2^31−1 (plugin 1.5.1; the grid places only 0..27), rarity?: number}; an invalid item drops
 *   the whole section; [] is kept). The integer ranges are the Java types the plugin sends and the
 *   Postgres columns they land in, so a bad value drops a section instead of failing the transaction
 *   (a deterministic 500 blocks the plugin's queue).
 * - events: each element must be an object with string `type` (1..64 chars), string `eventId`
 *   (1..128 chars) and a `data` key (any JSON value); `timestamp` finite number, else null (a present
 *   but invalid one records a reason, the event is kept). Invalid elements are skipped and counted.
 *   `raw` is the original element object and `data` is taken from it, not from zod's output.
 * - A "player" with none of name/accountHash is still returned (the caller decides what to do).
 * - An event element or player section nested deeper than 32 levels is invalid (the plugin nests ≈5;
 *   deeper values would overflow the stack in stripNul and JSON.stringify).
 * - skipped.sections and skipped.reasons list at most 64 entries each (reasons then end with a
 *   "… N more" line); skill names in paths are sanitized and cut to 64 characters.
 */
export function parsePayload(bodyText: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return { ok: false, error: 'not_json' };
  }
  return parsePayloadValue(json);
}

/** Same as parsePayload but for an already-parsed JSON value. */
export function parsePayloadValue(json: unknown): ParseResult {
  if (!isPlainObject(json)) return { ok: false, error: 'not_object' };
  const skipped = new Skipped();

  const playerValue = own(json, 'player');
  const player = playerValue === undefined ? null : parsePlayer(playerValue, skipped);
  const events = parseEvents(own(json, 'events'), skipped);
  const state = rootField(json, 'state', z.string().transform(stripNul), skipped) ?? null;
  const tickDelay = rootField(json, 'tickDelay', nonNegInt32, skipped) ?? 0;
  const timestamp = rootField(json, 'timestamp', z.number(), skipped) ?? null;

  return {
    ok: true,
    payload: { player, events, state, tickDelay, timestamp, skipped: skipped.result() },
  };
}

function parsePlayer(value: unknown, skipped: Skipped): PlayerSnapshot | null {
  if (!isPlainObject(value)) {
    skipped.section('player', 'expected an object');
    return null;
  }
  const section = <S extends z.ZodType>(key: string, schema: S) =>
    field(value, key, `player.${key}`, schema, skipped);

  const player: PlayerSnapshot = {};
  const name = section('name', PLAYER.name);
  if (name !== undefined) player.name = name;
  const accountHash = section('accountHash', PLAYER.accountHash);
  if (accountHash !== undefined) player.accountHash = accountHash;
  const accountType = section('accountType', PLAYER.accountType);
  if (accountType !== undefined) player.accountType = accountType;
  const world = section('world', PLAYER.world);
  if (world !== undefined) player.world = world;
  const worldTypes = section('worldTypes', PLAYER.worldTypes);
  if (worldTypes !== undefined) player.worldTypes = worldTypes;
  const location = section('location', PLAYER.location);
  if (location !== undefined) player.location = location;
  const locationTrail = section('locationTrail', PLAYER.locationTrail);
  if (locationTrail !== undefined) player.locationTrail = locationTrail;
  const health = section('health', meter);
  if (health !== undefined) player.health = health;
  const prayer = section('prayerPoints', meter);
  if (prayer !== undefined) player.prayer = prayer;
  const spellbook = section('spellbook', PLAYER.spellbook);
  if (spellbook !== undefined) player.spellbook = spellbook;
  const skills = parseSkills(section('stats', PLAYER.stats), skipped);
  if (skills !== undefined) player.skills = skills;
  const inventory = section('inventory', itemsSection);
  if (inventory !== undefined) player.inventory = inventory.items;
  const equipment = section('equipment', itemsSection);
  if (equipment !== undefined) player.equipment = equipment.items;
  return player;
}

function parseSkills(
  stats: { skills: Record<string, unknown> } | undefined,
  skipped: Skipped,
): Record<string, SkillValue> | undefined {
  if (stats === undefined) return undefined;
  const entries = Object.entries(stats.skills);
  if (entries.length > MAX_SKILLS) {
    skipped.section('player.stats', `more than ${MAX_SKILLS} skills`);
    return undefined;
  }
  const valid: [string, SkillValue][] = [];
  for (const [name, value] of entries) {
    const path = `player.stats.skills.${pathKey(name)}`;
    const reserved = RESERVED_SKILLS.get(name);
    if (reserved !== undefined) {
      skipped.section(path, reserved);
      continue;
    }
    if (name.length === 0 || name.length > MAX_SKILL_NAME) {
      skipped.section(path, `name must be 1..${MAX_SKILL_NAME} characters`);
      continue;
    }
    const r = PLAYER.skill.safeParse(value);
    if (r.success) valid.push([name, r.data]);
    else skipped.section(path, describe(r.error));
  }
  // fromEntries defines own properties (no prototype setter is ever reached).
  return valid.length > 0 ? Object.fromEntries(valid) : undefined;
}

function parseEvents(value: unknown, skipped: Skipped): RawEvent[] {
  if (value === undefined) {
    skipped.reason('events: missing');
    return [];
  }
  if (!Array.isArray(value)) {
    skipped.section('events', 'expected an array');
    return [];
  }
  const events: RawEvent[] = [];
  for (const [i, element] of (value as unknown[]).entries()) {
    const invalid = (why: string) => {
      skipped.events++;
      skipped.reason(`events[${i}]: ${why}`);
    };
    if (!isPlainObject(element)) {
      invalid('expected an object');
      continue;
    }
    if (nestedTooDeep(element)) {
      invalid(`nested deeper than ${MAX_DEPTH} levels`);
      continue;
    }
    const r = eventEnvelope.safeParse(element);
    if (!r.success) {
      invalid(describe(r.error));
      continue;
    }
    if (!Object.hasOwn(element, 'data')) {
      invalid('data: missing');
      continue;
    }
    const ts = own(element, 'timestamp');
    const timestamp = typeof ts === 'number' && Number.isFinite(ts) ? ts : null;
    if (timestamp === null && ts !== undefined) {
      skipped.reason(`events[${i}].timestamp: expected a finite number`);
    }
    events.push({
      type: r.data.type,
      data: element.data,
      eventId: r.data.eventId,
      timestamp,
      raw: element,
    });
  }
  return events;
}

/** A player section: prepared, then validated; invalid → omitted, path recorded. */
function field<S extends z.ZodType>(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  schema: S,
  skipped: Skipped,
): z.output<S> | undefined {
  const value = own(obj, key);
  if (value === undefined) return undefined;
  if (nestedTooDeep(value)) {
    skipped.section(path, `nested deeper than ${MAX_DEPTH} levels`);
    return undefined;
  }
  const r = schema.safeParse(prepare(value));
  if (r.success) return r.data;
  skipped.section(path, describe(r.error));
  return undefined;
}

/** A root scalar: invalid → undefined (the caller's default) and a reason, not a section. */
function rootField<S extends z.ZodType>(
  obj: Record<string, unknown>,
  key: string,
  schema: S,
  skipped: Skipped,
): z.output<S> | undefined {
  const value = own(obj, key);
  if (value === undefined) return undefined;
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  skipped.reason(`${key}: ${describe(r.error)}`);
  return undefined;
}

class Skipped {
  events = 0;
  private readonly sections: string[] = [];
  private readonly reasons: string[] = [];
  private unlisted = 0;

  section(path: string, why: string): void {
    if (this.sections.length < MAX_LISTED) this.sections.push(path);
    this.reason(`${path}: ${why}`);
  }

  reason(text: string): void {
    if (this.reasons.length < MAX_LISTED) this.reasons.push(text);
    else this.unlisted++;
  }

  result(): { sections: string[]; events: number; reasons: string[] } {
    const reasons = this.unlisted > 0 ? [...this.reasons, `… ${this.unlisted} more`] : this.reasons;
    return { sections: this.sections, events: this.events, reasons };
  }
}

/** Own property, with JSON null read as missing (Gson never writes null). */
function own(obj: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(obj, key)) return undefined;
  const value = obj[key];
  return value === null ? undefined : value;
}

/**
 * Copy of a player section to validate: stripNul on every string and key (nothing downstream cleans
 * the snapshot before its text/jsonb writes, DB-1), and object keys whose value is null left out (a
 * null counts as missing at every level). Only called on values that passed nestedTooDeep.
 */
function prepare(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prepare);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [stripNul(k), prepare(v)]),
    );
  }
  return stripNul(value);
}

/** True when objects/arrays nest more than MAX_DEPTH levels (iterative: the input can be deep). */
function nestedTooDeep(value: unknown): boolean {
  const stack: [unknown, number][] = [[value, 1]];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [v, depth] = top;
    if (typeof v !== 'object' || v === null) continue;
    if (depth > MAX_DEPTH) return true;
    for (const child of Object.values(v)) stack.push([child, depth + 1]);
  }
  return false;
}

/** The first zod issue as "path: message" (zod messages don't echo the input value). */
function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid';
  return issue.path.length > 0
    ? `${issue.path.map(String).join('.')}: ${issue.message}`
    : issue.message;
}

/** A skill name (already sanitized with its section) as a path segment: at most 64 code points. */
function pathKey(name: string): string {
  return Array.from(name).slice(0, MAX_SKILL_NAME).join('');
}
