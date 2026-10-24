/**
 * The wealth card's numbers from wealth_daily's days (UTC, carried plus bank, D-124). Pure, so the
 * card and its tests share them.
 *
 * A bank value is never guessed for the days before the plugin first read it: what was carried then
 * may be in the bank by the time it is first read, so counting the first reading on those days
 * counts that gear twice, and leaving the bank out makes the first reading look like a gain. Once a
 * bank value is known, the days before it are left off the graph and no change is measured across
 * it (as readWealthChange on the server).
 */
import { DAY_MS, utcDay } from '@hub/core';
import type { WealthDay } from '@hub/server';

/** One UTC day of the card's graph: the wealth at its end, carried over from the day before. */
export interface WealthPoint {
  day: string;
  /**
   * Carried plus bank at the day's end; null before the first day with data, and before the first
   * bank reading once there is one.
   */
  value: number | null;
  /** The bank part of it; null while no bank value was known. */
  bank: number | null;
  /** value minus the day before's value; null without both. */
  change: number | null;
}

/**
 * `end` minus `start`; null when the bank was first read between them (the start has no bank value
 * and the end has one), as nothing says what the bank held at the start.
 */
export function wealthDelta(start: WealthDay, end: WealthDay): number | null {
  if (start.bankValue === null && end.bankValue !== null) return null;
  return end.lastValue - start.lastValue;
}

/**
 * The last `days` UTC days up to `now` (oldest first), each with the latest known wealth: a day
 * without a snapshot keeps the day before's value, as the wealth didn't change while not playing.
 * `history` may start before the window; its days before are the base of the first day's change.
 */
export function wealthPoints(
  history: readonly WealthDay[],
  opts: { now: Date; days: number },
): WealthPoint[] {
  const byDay = new Map(history.map((d) => [d.day, d]));
  const first = utcDay(new Date(opts.now.getTime() - (opts.days - 1) * DAY_MS));
  let last: WealthDay | null = null;
  for (const d of history) if (d.day < first) last = d;
  const banked = history.some((d) => d.bankValue !== null);
  const out: WealthPoint[] = [];
  for (let i = opts.days - 1; i >= 0; i--) {
    const day = utcDay(new Date(opts.now.getTime() - i * DAY_MS));
    const row = byDay.get(day);
    const change = row && last ? wealthDelta(last, row) : row ? null : last ? 0 : null;
    if (row) last = row;
    const known = last !== null && (!banked || last.bankValue !== null);
    out.push({
      day,
      value: known ? (last as WealthDay).lastValue : null,
      bank: last?.bankValue ?? null,
      change: known ? change : null,
    });
  }
  return out;
}

/** The card's headline: wealth now, and the change today and over the whole window. */
export function summarizeWealth(history: readonly WealthDay[], points: readonly WealthPoint[]) {
  const latest = history.at(-1) ?? null;
  const startDay = points[0]?.day;
  // The window's base: the last day before it, else its own first day with data.
  let base =
    [...history].reverse().find((d) => startDay !== undefined && d.day < startDay) ??
    history.find((d) => startDay !== undefined && d.day >= startDay) ??
    null;
  // The bank was first read inside the window: measure from that day instead.
  if (base && latest && base.bankValue === null && latest.bankValue !== null) {
    base =
      history.find((d) => startDay !== undefined && d.day >= startDay && d.bankValue !== null) ??
      null;
  }
  const window = latest && base && base.day !== latest.day ? wealthDelta(base, latest) : null;
  return {
    latest,
    today: points.at(-1)?.change ?? null,
    window,
  };
}
