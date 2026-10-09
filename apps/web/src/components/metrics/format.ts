/**
 * How Metrics writes its measures (D-106): amounts, rates and their units, for the tiles, the cards,
 * the charts' tooltips and their tables alike. Pure and client-safe.
 */
import {
  HOUR_MS,
  MINUTE_MS,
  formatDuration,
  formatGp,
  formatNumber,
  type MetricsMeasure,
} from '@hub/core';

export const MEASURE_LABELS: Readonly<Record<MetricsMeasure, string>> = {
  xp: 'XP',
  gp: 'Loot',
  kills: 'Kills',
  active: 'Active time',
};

/** "12,345 XP", "1.2M gp", "14 kills", "1h 5m" (active time is in ms). */
export function formatAmount(measure: MetricsMeasure, value: number): string {
  switch (measure) {
    case 'xp':
      return `${formatNumber(value)} XP`;
    case 'gp':
      return `${formatGp(value)} gp`;
    case 'kills':
      return `${formatNumber(value)} ${Math.round(value) === 1 ? 'kill' : 'kills'}`;
    case 'active':
      return formatDuration(value / 1000);
  }
}

/** An amount for an axis label: "1.2M", "450K", "12", "3h". */
export function formatAxisAmount(measure: MetricsMeasure, value: number): string {
  if (measure === 'active') return `${Math.round((value / HOUR_MS) * 10) / 10}h`;
  return formatGp(value);
}

/**
 * A rate as rateOf gives it: per hour for XP, loot and kills ("85.2K XP/h"), the active share for
 * active time ("64% active"). null → "—".
 */
export function formatRate(measure: MetricsMeasure, rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return '—';
  switch (measure) {
    case 'xp':
      return `${formatGp(rate)} XP/h`;
    case 'gp':
      return `${formatGp(rate)} gp/h`;
    case 'kills':
      return `${rate >= 10 ? formatNumber(rate) : (Math.round(rate * 10) / 10).toString()} kills/h`;
    case 'active':
      return `${Math.round(rate * 100)}% active`;
  }
}

/** A rate for an axis label: "85K", "64%". */
export function formatAxisRate(measure: MetricsMeasure, rate: number): string {
  return measure === 'active' ? `${Math.round(rate * 100)}%` : formatGp(rate);
}

/** active ÷ online as "64%"; "—" without online time. */
export function formatShare(activeMs: number, onlineMs: number): string {
  return onlineMs > 0 ? `${Math.round((activeMs / onlineMs) * 100)}%` : '—';
}

/** A duration in ms: "1h 30m". */
export function formatMs(ms: number): string {
  return formatDuration(ms / 1000);
}

/** Minutes into a session: 0 → "0:00", 90 → "1:30". */
export function formatSessionMinute(minute: number): string {
  const m = Math.round(minute);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** The weekday names of the heatmap and the filter, Monday first (0 = Monday). */
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** An hour of the day as "18:00". */
export function formatHour(hour: number): string {
  return `${String(hour % 24).padStart(2, '0')}:00`;
}

/** Days to go, for a goal's ETA: "today", "3 days", "about 5 months", "years". */
export function formatEtaDays(days: number | null): string {
  if (days === null || !Number.isFinite(days)) return '—';
  if (days <= 0) return 'reached';
  if (days < 1) return 'within a day';
  if (days < 60) return `${Math.ceil(days)} ${Math.ceil(days) === 1 ? 'day' : 'days'}`;
  if (days < 730) return `about ${Math.round(days / 30)} months`;
  return `about ${Math.round(days / 365)} years`;
}

/** Play time to go, for a skill's next level: "45m", "12h 30m". */
export function formatEtaMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return ms < MINUTE_MS ? 'under a minute' : formatMs(ms);
}
