/**
 * The XP chart's range picker: preset ranges → the `from`/`to` window the XP route is asked for.
 * Pure and client-safe (only @hub/core's time constants), unit-tested.
 */
import { DAY_MS } from '@hub/core';

export const XP_RANGES = ['24h', '7d', '30d', '90d', '1y', 'all'] as const;
export type XpRange = (typeof XP_RANGES)[number];

export const XP_RANGE_LABELS: Readonly<Record<XpRange, string>> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  '1y': '1 year',
  all: 'All time',
};

const RANGE_MS: Readonly<Record<Exclude<XpRange, 'all'>, number>> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  '90d': 90 * DAY_MS,
  '1y': 365 * DAY_MS,
};

/** 'all' without a known first-seen time: ten years back (the hub keeps daily XP forever). */
const ALL_FALLBACK_MS = 10 * 365 * DAY_MS;

/**
 * The window for a preset ending at `now`: `to` = now, `from` = now − the preset's length; 'all'
 * starts at the account's first-seen time (or ten years back when unknown or invalid). `from` is
 * never after `to`, so a first-seen time in the future (clock skew) still gives a valid window.
 */
export function rangeWindow(
  range: XpRange,
  now: Date,
  firstSeen?: string | Date | null,
): { from: Date; to: Date } {
  const to = now.getTime();
  let from: number;
  if (range === 'all') {
    const first =
      firstSeen === null || firstSeen === undefined ? NaN : new Date(firstSeen).getTime();
    from = Number.isFinite(first) ? first : to - ALL_FALLBACK_MS;
  } else {
    from = to - RANGE_MS[range];
  }
  return { from: new Date(Math.min(from, to)), to: new Date(to) };
}

/** The query string of GET /api/app/accounts/[publicId]/xp for one skill over a window. */
export function xpQuery(skill: string, window: { from: Date; to: Date }): string {
  const q = new URLSearchParams({
    skills: skill,
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    resolution: 'auto',
  });
  return q.toString();
}
