/**
 * What MCP tool results look like (D-132): a one-line `summary` the model can quote, `generated_at`,
 * names before ids, GP values formatted beside the number, and lists capped at MCP_LIST_CAP with a
 * `next_cursor` or `truncated`. The REST endpoint stays the place for the full shape.
 */
import { formatDuration, formatGp } from '@hub/core';

/** Longest list a tool returns (D-132). */
export const MCP_LIST_CAP = 50;

/** A GP value as a model reads it: `35.2M`. Null stays null. */
export function gp(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : formatGp(value);
}

/** A large count (XP, kills) as a model reads it: `1.25M`. */
export function compact(value: number): string {
  return formatGp(value);
}

/** Minutes as a model reads them: `1h 30m`. */
export function minutes(ms: number): string {
  return formatDuration(ms / 1000);
}

/** The first `cap` of `list`, and whether any were left out. */
export function capped<T>(
  list: readonly T[],
  cap = MCP_LIST_CAP,
): { items: T[]; truncated: boolean } {
  return { items: list.slice(0, cap), truncated: list.length > cap };
}

/** "1 account" / "3 accounts". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** The day of an ISO time, as a model reads it: `2026-10-21`. */
export function day(iso: string): string {
  return iso.slice(0, 10);
}

/** A tool's result object: the summary first, then the data, then `generated_at`. */
export function result<T extends Record<string, unknown>>(
  summary: string,
  data: T,
  now: Date = new Date(),
): { summary: string } & T & { generated_at: string } {
  return { summary, ...data, generated_at: now.toISOString() };
}
