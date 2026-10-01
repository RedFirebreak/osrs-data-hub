/**
 * A page size as a caller asked for it, for the list read models (the feed, the admin lists, the
 * live replay): a whole number from 1 to `max`, or `fallback` when it is missing or not a finite
 * number.
 */
export function clampLimit(limit: number | undefined, max: number, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(limit)));
}
