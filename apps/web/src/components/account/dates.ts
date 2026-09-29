/**
 * Absolute dates on server-rendered account and guild pages, in the viewer's time zone (Settings).
 * Relative times ("3 min ago") use <RelativeTime>; these are for the fixed parts (a session's start,
 * "on the hub since"). Server- and client-safe.
 */

/** "29 Sep 2026, 14:05"-style text of `at` in `timezone` (UTC for an unknown zone); null if invalid. */
export function formatInZone(
  at: string | Date,
  timezone: string,
  options: Intl.DateTimeFormatOptions,
): string | null {
  const date = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: timezone }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(date);
  }
}

export const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
};

export const DAY_OPTIONS: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
};
