/**
 * Finished slayer tasks read back from their slayer_task_complete events (D-141), for the slayer
 * card's "Done in 7 days" and the deep dive's task list. Pure.
 */
import { isRecord } from '@hub/core';

/** One finished task, as its event tells it. */
export interface DoneSlayerTask {
  /** The event's public id. */
  id: string;
  /** ISO-8601 UTC. */
  at: string;
  task: string | null;
  /** Konar's area; left out of the event for a viewer without a location category. */
  location: string | null;
  amount: number | null;
  /** Points the task earned (the event's `points`, from `pointsEarned`). */
  points: number | null;
  /** The streak it brought the player to, and which one. */
  streak: number | null;
  streakType: string | null;
}

/** The totals over a list of finished tasks. */
export interface SlayerTaskTotals {
  tasks: number;
  kills: number;
  points: number;
}

/** What listFeed returns, as far as it is read here. */
interface CompleteEvent {
  id: string;
  occurredAt: string;
  points: number | null;
  data: unknown;
}

const count = (value: unknown): number | null =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** A slayer_task_complete feed event as a finished task; anything it lacks is null. */
export function doneSlayerTask(event: CompleteEvent): DoneSlayerTask {
  const stored = isRecord(event.data) ? event.data : {};
  const d = isRecord(stored.data) ? stored.data : {};
  return {
    id: event.id,
    at: event.occurredAt,
    task: text(d.task),
    location: text(d.location),
    amount: count(d.amount),
    points: event.points ?? count(d.pointsEarned),
    streak: count(d.streak),
    streakType: text(d.streakType),
  };
}

/** The tasks finished at or after `since`, newest first as the feed returns them. */
export function slayerTasksSince(events: readonly CompleteEvent[], since: Date): DoneSlayerTask[] {
  const from = since.getTime();
  return events.filter((e) => Date.parse(e.occurredAt) >= from).map(doneSlayerTask);
}

/** How many tasks, kills and points, counting what a task doesn't say as 0. */
export function slayerTaskTotals(tasks: readonly DoneSlayerTask[]): SlayerTaskTotals {
  return {
    tasks: tasks.length,
    kills: tasks.reduce((sum, t) => sum + (t.amount ?? 0), 0),
    points: tasks.reduce((sum, t) => sum + (t.points ?? 0), 0),
  };
}
