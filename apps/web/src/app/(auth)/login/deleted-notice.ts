/**
 * What the login page says after "Delete my data" (D-78), which sends the browser to
 * `/login?deleted=<graceUntil>`. The parameter is parsed strictly and never rendered: only a date
 * built from it is shown, and anything that isn't an exact ISO-8601 UTC time (or a plain
 * YYYY-MM-DD) that exists on the calendar gives the notice without a date.
 */

export interface DeletedNotice {
  /**
   * When the deletion happens: the text to show and the ISO value for <time dateTime>; null when
   * the parameter isn't a valid date (the page then says it without one).
   */
  when: { label: string; dateTime: string } | null;
}

/** YYYY-MM-DD, optionally with THH:MM[:SS[.sss]]Z (what Date#toISOString gives, and shorter). */
const ISO_UTC = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z)?$/;

/**
 * The moment in `raw` (the first value when repeated), or null unless it matches ISO_UTC and names
 * a real moment: "2026-02-30" or "T24:00Z" are refused rather than rolled over, because the value
 * is rebuilt in full and must come back from Date unchanged. `dateOnly`: the value had no time.
 */
export function parseDeletedAt(raw: unknown): { at: Date; dateOnly: boolean } | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const m = ISO_UTC.exec(value);
  if (!m) return null;
  const [, day, hhmm, ss, ms] = m;
  const full = `${day}T${hhmm ?? '00:00'}:${ss ?? '00'}.${(ms ?? '').padEnd(3, '0')}Z`;
  const at = new Date(full);
  if (!Number.isFinite(at.getTime()) || at.toISOString() !== full) return null;
  return { at, dateOnly: hhmm === undefined };
}

const DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const TIME = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

/**
 * The notice for `?deleted=`, or null when the parameter is absent. The time is shown in UTC and
 * says so: a signed-out page doesn't know the user's time zone.
 */
export function deletedNotice(raw: unknown): DeletedNotice | null {
  if (raw === undefined || raw === null) return null;
  const parsed = parseDeletedAt(raw);
  if (!parsed) return { when: null };
  const { at, dateOnly } = parsed;
  const label = dateOnly ? DATE.format(at) : `${DATE.format(at)}, ${TIME.format(at)} UTC`;
  return { when: { label, dateTime: dateOnly ? at.toISOString().slice(0, 10) : at.toISOString() } };
}
