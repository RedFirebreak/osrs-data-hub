/**
 * The time range of a Metrics view (D-106): a preset ending now ("today" from local midnight in the
 * viewer's time zone, the others rolling), or a custom range of local days or of two instants.
 */
import {
  DAY_MS,
  DEFAULT_METRICS_RANGE,
  HOUR_MS,
  MAX_METRICS_RANGE_DAYS,
  localClock,
  type MetricsQuery,
  type MetricsRange,
} from '@hub/core';
import { startOfLocalDay } from '../accounts/periods';

export interface MetricsRangeWindow {
  from: Date;
  to: Date;
  /** The preset the window came from; `custom` for a custom one. */
  preset: MetricsRange;
}

const PRESET_DAYS: Readonly<Record<Exclude<MetricsRange, 'today' | 'custom'>, number>> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
};

/**
 * The window of a query at `now`. A custom range of days runs from the first day's local midnight
 * to the end of the last day; one of instants as given. Either is cut at `now` and at
 * MAX_METRICS_RANGE_DAYS (keeping its end), and one that ends before it starts falls back to the
 * default preset.
 */
export function resolveMetricsRange(
  query: Pick<MetricsQuery, 'range' | 'from' | 'to'>,
  now: Date,
  timezone: string,
): MetricsRangeWindow {
  const preset = query.range;
  if (preset === 'today') return { from: startOfLocalDay(now, timezone), to: now, preset };
  if (preset === 'custom' && query.from && query.to) {
    const from = boundTime(query.from, timezone, 'start');
    const to = Math.min(boundTime(query.to, timezone, 'end'), now.getTime());
    if (Number.isFinite(from) && Number.isFinite(to) && from < to) {
      return {
        from: new Date(Math.max(from, to - MAX_METRICS_RANGE_DAYS * DAY_MS)),
        to: new Date(to),
        preset,
      };
    }
  }
  const days = PRESET_DAYS[preset as keyof typeof PRESET_DAYS] ?? PRESET_DAYS[DEFAULT_RANGE];
  return {
    from: new Date(now.getTime() - days * DAY_MS),
    to: now,
    preset: preset in PRESET_DAYS ? preset : DEFAULT_RANGE,
  };
}

const DEFAULT_RANGE = DEFAULT_METRICS_RANGE as keyof typeof PRESET_DAYS;

/** A bound's instant: an ISO instant as is, a day at its local start (or the next day's start). */
function boundTime(bound: string, timezone: string, edge: 'start' | 'end'): number {
  if (bound.length > 10) return Date.parse(bound);
  const start = startOfLocalDate(bound, timezone);
  if (start === null) return NaN;
  if (edge === 'start') return start.getTime();
  const next = new Date(Date.parse(`${bound}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  return startOfLocalDate(next, timezone)?.getTime() ?? NaN;
}

/** Local midnight of a calendar day (YYYY-MM-DD) in the zone, DST-safe; null for a bad day. */
export function startOfLocalDate(day: string, timezone: string): Date | null {
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(utcMidnight)) return null;
  // UTC offsets run from −12 h to +14 h: some hour in that window lies on the local day.
  for (let h = -14; h <= 14; h++) {
    const probe = utcMidnight + h * HOUR_MS;
    if (localClock(probe, timezone).day === day) return startOfLocalDay(new Date(probe), timezone);
  }
  return null;
}
