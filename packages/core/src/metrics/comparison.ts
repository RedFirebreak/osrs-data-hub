/**
 * Metrics' period comparison (D-106): the measure accumulated through the range, with the previous
 * period of the same length overlaid on the same axis (time since the period started). Pure.
 */
import { DAY_MS, HOUR_MS } from '../time';

/** An amount at a moment: XP gained in a bucket, a drop, a kill gain, active time in a bucket. */
export interface ValuePoint {
  at: number;
  value: number;
}

/** The longest span drawn in hours: two days, or eight for a `fine` line (a week, by the hour). */
const HOURLY_DAYS = 2;
const FINE_HOURLY_DAYS = 8;

/**
 * The step of the cumulative lines: hourly up to two days, daily up to 120 days, weekly beyond.
 * `minStepMs` raises it (a viewer without `activity` gets days at least, D-50). `fine` keeps the
 * hourly step up to eight days: a week drawn as one line wants its sessions visible as climbs, where
 * the comparison's two lines read better day by day.
 */
export function comparisonStepMs(spanMs: number, minStepMs = 0, fine = false): number {
  const hourly = (fine ? FINE_HOURLY_DAYS : HOURLY_DAYS) * DAY_MS;
  const step = spanMs <= hourly ? HOUR_MS : spanMs <= 120 * DAY_MS ? DAY_MS : 7 * DAY_MS;
  return Math.max(step, minStepMs);
}

/**
 * Cumulative totals of `points` in [from, to) at the end of every step: [ms since `from`, total].
 * The first entry is [0, 0], so a line starts at the period's start.
 */
export function cumulativeSeries(
  points: readonly ValuePoint[],
  from: number,
  to: number,
  stepMs: number,
): [number, number][] {
  const steps = Math.max(1, Math.ceil((to - from) / stepMs));
  const perStep = new Array<number>(steps).fill(0);
  for (const p of points) {
    if (p.at < from || p.at >= to) continue;
    perStep[Math.min(steps - 1, Math.floor((p.at - from) / stepMs))]! += p.value;
  }
  const out: [number, number][] = [[0, 0]];
  let total = 0;
  for (let i = 0; i < steps; i++) {
    total += perStep[i]!;
    out.push([Math.min(to - from, (i + 1) * stepMs), total]);
  }
  return out;
}

export interface PeriodComparison {
  stepMs: number;
  /** The range itself, cut at `now` when it ends later. */
  current: [number, number][];
  /** The period of the same length just before it; null when not asked for. */
  previous: [number, number][] | null;
}

/**
 * The comparison of [from, to) with [from − span, from). `points` may hold both periods. The current
 * line stops at `now` (a range ending in the future, like "today", has nothing after it yet).
 */
export function periodComparison(
  points: readonly ValuePoint[],
  range: { from: number; to: number; now?: number },
  opts: { compare: boolean; minStepMs?: number; fine?: boolean },
): PeriodComparison {
  const span = range.to - range.from;
  const stepMs = comparisonStepMs(span, opts.minStepMs, opts.fine);
  const end = Math.min(range.to, range.now ?? range.to);
  const current = cumulativeSeries(points, range.from, Math.max(range.from + 1, end), stepMs);
  const previous = opts.compare
    ? cumulativeSeries(points, range.from - span, range.from, stepMs)
    : null;
  return { stepMs, current, previous };
}
