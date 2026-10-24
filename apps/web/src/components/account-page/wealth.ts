/**
 * The wealth card's numbers from wealth_daily's days (UTC, carried plus bank, D-124). Pure, so the
 * card and its tests share them.
 */
import { DAY_MS, utcDay } from '@hub/core';
import type { WealthDay } from '@hub/server';

/** One UTC day of the card's graph: the wealth at its end, carried over from the day before. */
export interface WealthPoint {
  day: string;
  /** Carried plus bank at the day's end; null before the first day with data. */
  value: number | null;
  /** The bank part of it; null while no bank value was known. */
  bank: number | null;
  /**
   * The bank wasn't known yet that day, and `value` counts the first bank value read later in its
   * place: the line doesn't jump up the day the plugin first saw the bank (that is no gain).
   */
  bankAssumed: boolean;
  /** value minus the day before's value; null without both. */
  change: number | null;
}

/**
 * `end` minus `start`. When the start has no bank value yet and the end has one, the end's bank is
 * left out: finding out what the bank holds isn't a gain (as readWealthChange on the server).
 */
export function wealthDelta(start: WealthDay, end: WealthDay): number {
  const firstBank = start.bankValue === null && end.bankValue !== null ? end.bankValue : 0;
  return end.lastValue - start.lastValue - firstBank;
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
  const firstBank = history.find((d) => d.bankValue !== null)?.bankValue ?? null;
  const out: WealthPoint[] = [];
  for (let i = opts.days - 1; i >= 0; i--) {
    const day = utcDay(new Date(opts.now.getTime() - i * DAY_MS));
    const row = byDay.get(day);
    const change = row && last ? wealthDelta(last, row) : row ? null : last ? 0 : null;
    if (row) last = row;
    const bankAssumed = last !== null && last.bankValue === null && firstBank !== null;
    out.push({
      day,
      value: last === null ? null : last.lastValue + (bankAssumed ? (firstBank as number) : 0),
      bank: last?.bankValue ?? null,
      bankAssumed,
      change,
    });
  }
  return out;
}

/** The card's headline: wealth now, and the change today and over the whole window. */
export function summarizeWealth(history: readonly WealthDay[], points: readonly WealthPoint[]) {
  const latest = history.at(-1) ?? null;
  const firstIn = points.findIndex((p) => p.value !== null);
  const startDay = firstIn >= 0 ? points[firstIn]?.day : undefined;
  // The window's base: the last day before it, else its own first day with data.
  const base =
    [...history].reverse().find((d) => startDay !== undefined && d.day < startDay) ??
    history.find((d) => d.day === startDay) ??
    null;
  return {
    latest,
    today: points.at(-1)?.change ?? null,
    window: latest && base ? wealthDelta(base, latest) : null,
  };
}
