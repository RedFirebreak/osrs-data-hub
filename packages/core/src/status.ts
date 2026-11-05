/**
 * The player's status as the plugin sends it in `player.status` (after plugin 1.6.3, PR #54; D-143):
 * run energy, special attack, poison or venom, the wilderness level and the effects that are running
 * (potions, teleblock, …), each with when it ends. Pure.
 */
import { isRecord } from './guards';

export const POISON_TYPES = ['none', 'poison', 'venom'] as const;
export type PoisonType = (typeof POISON_TYPES)[number];

export interface StatusEffect {
  /** Fixed, `a-z 0-9 _`: RuneLite's GameTimer name in lower case ("stamina", "divine_super_combat"). */
  id: string;
  /** The plugin's display name ("Stamina"); shown for an id the hub doesn't know. */
  name: string;
  /** When it ends, epoch ms. The real end can be up to `precision` earlier. */
  endsAt: number;
  /** How coarse `endsAt` is, ms (the game counts most effects down in steps). */
  precision: number;
}

/** What latest_state.status holds, and what the hub reads back. */
export interface StatusState {
  /** Whole percent, 0 … 100. */
  runEnergy: number;
  running: boolean;
  /** Whole percent, 0 … 100. */
  specialAttack: number;
  /** `damage` is the next hit, null with "none". */
  poison: { type: PoisonType; damage: number | null };
  /** The wilderness level, null outside the wilderness (or when the plugin keeps location to itself). */
  wildernessLevel: number | null;
  /** In the plugin's order (its registry), only what was running when sent. */
  effects: StatusEffect[];
}

/**
 * The item whose picture stands for an effect: the 4-dose potion RuneLite's Timers & Buffs shows
 * (gameval ItemID). Magic imbue and teleblock are spells and have no item, so no picture.
 */
export const STATUS_EFFECT_ITEMS: Readonly<Record<string, number>> = {
  stamina: 12625,
  antifire: 2452,
  superantifire: 21978,
  antipoison: 2446,
  antivenom: 12905,
  divine_super_attack: 23697,
  divine_super_strength: 23709,
  divine_super_defence: 23721,
  divine_ranging: 23733,
  divine_magic: 23745,
  divine_super_combat: 23685,
  divine_bastion: 24635,
  divine_battlemage: 24623,
  moonlight_potion: 29080,
  goading: 30137,
  prayer_regeneration: 30125,
  surge_potion: 30875,
  menaphite_remedy: 27202,
  imbuedheart: 20724,
  overload: 11730,
};

/**
 * What is still running at `now`: an effect whose `endsAt` has passed is over, even when no message
 * said so (the player stopped sending, or logged out).
 */
export function runningEffects(
  effects: readonly StatusEffect[],
  now: Date | number,
): StatusEffect[] {
  const at = typeof now === 'number' ? now : now.getTime();
  return effects.filter((e) => e.endsAt > at);
}

/**
 * The status as it stands at `now` (D-143). Offline nothing runs and no one is poisoned or in the
 * wilderness, as logging out turns prayers off (D-119); run energy and special attack keep their last
 * value, which is what the game has when the player logs back in.
 */
export function statusAt(state: StatusState, now: Date | number, online: boolean): StatusState {
  if (!online) {
    return {
      ...state,
      poison: { type: 'none', damage: null },
      wildernessLevel: null,
      effects: [],
    };
  }
  return { ...state, effects: runningEffects(state.effects, now) };
}

/** The status without the wilderness level, for a reader without `location_live` (the plugin's own rule). */
export function withoutWilderness(state: StatusState): StatusState {
  return state.wildernessLevel === null ? state : { ...state, wildernessLevel: null };
}

/**
 * The time an effect has left, rounded down: "1:02:03", "4:05", "0:09". Never negative.
 */
export function formatEffectLeft(endsAt: number, now: number): string {
  const total = Math.max(0, Math.floor((endsAt - now) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * Moves every effect's end by `offsetMs`: an end time from a player's clock that is plainly wrong
 * (isPlausibleClock) is moved onto the hub's by the payload's own time (ingest).
 */
export function shiftStatusClock(state: StatusState, offsetMs: number): StatusState {
  if (offsetMs === 0) return state;
  return { ...state, effects: state.effects.map((e) => ({ ...e, endsAt: e.endsAt + offsetMs })) };
}

const percent = (value: unknown): number | null =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 100
    ? (value as number)
    : null;
const count = (value: unknown): number | null =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
const EFFECT_ID = /^[a-z0-9_]{1,64}$/;

function readEffect(value: unknown): StatusEffect | null {
  if (!isRecord(value)) return null;
  const { id, name } = value;
  const endsAt = count(value.endsAt);
  const precision = count(value.precision);
  if (typeof id !== 'string' || !EFFECT_ID.test(id) || endsAt === null) return null;
  return {
    id,
    name: typeof name === 'string' && name !== '' ? name : id,
    endsAt,
    precision: precision ?? 0,
  };
}

/**
 * latest_state.status read back (jsonb, written by ingest from parsePayload's StatusState). Anything
 * that isn't that shape reads as null, an effect that isn't as left out: a reader never throws on a
 * stored value.
 */
export function readStatusState(value: unknown): StatusState | null {
  if (!isRecord(value)) return null;
  const runEnergy = percent(value.runEnergy);
  const specialAttack = percent(value.specialAttack);
  if (runEnergy === null || specialAttack === null) return null;
  const poison = isRecord(value.poison) ? value.poison : {};
  const type = POISON_TYPES.includes(poison.type as PoisonType)
    ? (poison.type as PoisonType)
    : 'none';
  const level = count(value.wildernessLevel);
  return {
    runEnergy,
    running: value.running === true,
    specialAttack,
    poison: { type, damage: type === 'none' ? null : count(poison.damage) },
    wildernessLevel: level !== null && level > 0 ? level : null,
    effects: Array.isArray(value.effects)
      ? value.effects.map(readEffect).filter((e): e is StatusEffect => e !== null)
      : [],
  };
}
