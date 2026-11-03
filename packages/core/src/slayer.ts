/**
 * The player's slayer state as the plugin sends it in `player.slayer` (after plugin 1.6.2, PR #52;
 * D-141): the current task, the slayer points and the task streaks. Pure.
 */
import { isRecord } from './guards';

/** The streaks the game counts apart: Krystilia's (wilderness) and Mortimer's tasks have their own. */
export const SLAYER_STREAKS = ['normal', 'wilderness', 'mortimer'] as const;
export type SlayerStreak = (typeof SLAYER_STREAKS)[number];

export interface SlayerTask {
  /** As the game names it ("Abyssal demons", "Kraken"); null when the plugin couldn't look it up. */
  name: string | null;
  /** Konar's tasks only ("Catacombs of Kourend"). */
  location: string | null;
  /** Kills left, at least 1 (a task with none left is no task). */
  remaining: number;
  /** The task's size when it was assigned, never below `remaining`. */
  amount: number;
}

/** What latest_state.slayer holds, and what the hub reads back. */
export interface SlayerState {
  /** null between tasks. */
  task: SlayerTask | null;
  points: number;
  /** Each streak as sent; null when the plugin didn't send it. */
  streaks: Record<SlayerStreak, number | null>;
}

/** Kills done of the task, 0 … amount. */
export function slayerKillsDone(task: SlayerTask): number {
  return Math.max(0, task.amount - task.remaining);
}

/** How far the task is, 0 … 1 (a task of size 0 counts as just begun). */
export function slayerProgress(task: SlayerTask): number {
  if (task.amount <= 0) return 0;
  return Math.min(1, Math.max(0, slayerKillsDone(task) / task.amount));
}

/** "Abyssal demons", or "Abyssal demons in the Catacombs of Kourend" for a Konar task. */
export function slayerTaskLabel(task: Pick<SlayerTask, 'name' | 'location'>): string {
  const name = task.name ?? 'Unknown task';
  return task.location === null ? name : `${name} in ${task.location}`;
}

/** The streak's name as a sentence part: "task streak", "Wilderness streak", "Mortimer streak". */
export function slayerStreakLabel(streak: string): string {
  switch (streak) {
    case 'wilderness':
      return 'Wilderness streak';
    case 'mortimer':
      return 'Mortimer streak';
    default:
      return 'task streak';
  }
}

/**
 * The streak to show first: the regular one, unless it is unknown or 0 while another isn't (a player
 * who only does Krystilia's tasks).
 */
export function mainSlayerStreak(
  state: SlayerState,
): { streak: SlayerStreak; value: number } | null {
  const sent = SLAYER_STREAKS.filter((s) => state.streaks[s] !== null);
  if (sent.length === 0) return null;
  const normal = state.streaks.normal;
  if (normal !== null && normal > 0) return { streak: 'normal', value: normal };
  const best = sent.reduce((a, b) => ((state.streaks[b] ?? 0) > (state.streaks[a] ?? 0) ? b : a));
  return { streak: best, value: state.streaks[best] ?? 0 };
}

/**
 * The state without a Konar task's location, for a reader without a location category: the area a
 * player was sent to says where they are, as an event's location does (redactEventData).
 */
export function withoutSlayerLocation(state: SlayerState): SlayerState {
  return state.task === null || state.task.location === null
    ? state
    : { ...state, task: { ...state.task, location: null } };
}

const count = (value: unknown): number | null =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/**
 * latest_state.slayer read back (jsonb, written by ingest from parsePayload's SlayerState). Anything
 * that isn't that shape reads as null, a task without kills left as no task: a reader never throws
 * on a stored value.
 */
export function readSlayerState(value: unknown): SlayerState | null {
  if (!isRecord(value)) return null;
  const points = count(value.points);
  if (points === null) return null;
  const t = isRecord(value.task) ? value.task : null;
  const remaining = t === null ? null : count(t.remaining);
  const streaks = isRecord(value.streaks) ? value.streaks : {};
  return {
    task:
      t !== null && remaining !== null && remaining > 0
        ? {
            name: text(t.name),
            location: text(t.location),
            remaining,
            amount: Math.max(count(t.amount) ?? remaining, remaining),
          }
        : null,
    points,
    streaks: {
      normal: count(streaks.normal),
      wilderness: count(streaks.wilderness),
      mortimer: count(streaks.mortimer),
    },
  };
}
