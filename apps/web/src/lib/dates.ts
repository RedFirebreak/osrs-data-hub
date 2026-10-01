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

/** YYYY-MM-DD of `instant` in `timezone` (UTC when the zone is unknown to this runtime). */
export function localDate(instant: Date, timezone: string): string {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return instant.toISOString().slice(0, 10);
  }
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * A time known only to the day (a read model's local-midnight stamp for viewers without the
 * `activity` category, D-50) relative to `now`, both as calendar days in `timezone`: "today",
 * "yesterday", or "on 27 Sep" ("on 27 Sep 2025" in another year); `day` is its YYYY-MM-DD (for
 * <time dateTime>). Compares calendar dates, so a 23- or 25-hour DST day changes nothing. Null for
 * an invalid date.
 */
export function dayOnlyLabel(
  at: string | Date,
  now: string | Date,
  timezone: string,
): { day: string; text: string } | null {
  const date = at instanceof Date ? at : new Date(at);
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(current.getTime())) return null;
  const day = localDate(date, timezone);
  const today = localDate(current, timezone);
  const daysAgo = Math.round((Date.parse(today) - Date.parse(day)) / (24 * 60 * 60 * 1000));
  if (daysAgo === 0) return { day, text: 'today' };
  if (daysAgo === 1) return { day, text: 'yesterday' };
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', timeZone: 'UTC' };
  if (day.slice(0, 4) !== today.slice(0, 4)) options.year = 'numeric';
  // `day` is a calendar date: formatted at UTC midnight so it never shifts.
  const text = new Intl.DateTimeFormat('en-GB', options).format(new Date(`${day}T00:00:00Z`));
  return { day, text: `on ${text}` };
}
