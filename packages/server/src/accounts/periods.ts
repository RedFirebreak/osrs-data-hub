/**
 * Gains periods in the viewer's time zone (handoff §12: "gains today and over 7 days", the skills
 * table's day/week/month/year, the guild leaderboards). "Today" starts at local midnight, which is
 * the only period that depends on the time zone; the others are rolling windows.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_PERIOD_TIMEZONE = 'UTC';

export interface PeriodStarts {
  /** Local midnight of `now`'s day in the time zone. */
  today: Date;
  /** now − 7 days. */
  week: Date;
  /** now − 30 days. */
  month: Date;
  /** now − 365 days. */
  year: Date;
}

/**
 * Where each gains period starts for a viewer: today = local midnight in `timezone` (see
 * startOfLocalDay), week/month/year = now − 7/30/365 days. An unknown time zone falls back to UTC
 * rather than failing the page: the stored setting is validated on save, so this only guards against
 * a runtime that lacks a zone the saving one knew.
 */
export function periodStarts(now: Date, timezone: string = DEFAULT_PERIOD_TIMEZONE): PeriodStarts {
  const t = now.getTime();
  return {
    today: startOfLocalDay(now, timezone),
    week: new Date(t - 7 * DAY_MS),
    month: new Date(t - 30 * DAY_MS),
    year: new Date(t - 365 * DAY_MS),
  };
}

/**
 * The first instant of `instant`'s calendar day in `timezone`, DST-safe:
 * - usually local 00:00;
 * - when 00:00 doesn't exist (a spring-forward at midnight, e.g. America/Santiago), the day starts at
 *   the transition, the first instant whose local date is that day;
 * - when 00:00 happens twice (a fall-back to midnight), the first occurrence.
 *
 * How: local midnight is `base − offset` for one of the UTC offsets in effect around it (base = the
 * local date's midnight read as UTC). The day's start is always one of those candidates, and it is the
 * earliest candidate whose local date is the target day. Offsets are read with Intl, so any IANA zone
 * the runtime knows works; an unknown zone falls back to UTC.
 */
export function startOfLocalDay(instant: Date, timezone: string): Date {
  const fmt = formatterFor(timezone);
  const day = localParts(fmt, instant.getTime());
  const base = Date.UTC(day.year, day.month - 1, day.day);
  const offsets = new Set<number>();
  // Offsets range from −12 h to +14 h, so local midnight falls within [base − 14 h, base + 12 h].
  for (let probe = base - 14 * HOUR_MS; probe <= base + 14 * HOUR_MS; probe += 2 * HOUR_MS) {
    offsets.add(offsetAt(fmt, probe));
  }
  let best: number | null = null;
  for (const offset of offsets) {
    const candidate = base - offset;
    const p = localParts(fmt, candidate);
    const sameDay = p.year === day.year && p.month === day.month && p.day === day.day;
    if (sameDay && (best === null || candidate < best)) best = candidate;
  }
  // Unreachable for real zones (the day's start is always a candidate); UTC midnight as a floor.
  return new Date(best ?? base);
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached) return cached;
  try {
    const fmt = makeFormatter(timezone);
    formatters.set(timezone, fmt);
    return fmt;
  } catch {
    // RangeError: unknown time zone. Not cached, so odd input can't grow the cache.
    return timezone === DEFAULT_PERIOD_TIMEZONE
      ? makeFormatter(DEFAULT_PERIOD_TIMEZONE)
      : formatterFor(DEFAULT_PERIOD_TIMEZONE);
  }
}

function makeFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
}

function localParts(fmt: Intl.DateTimeFormat, ms: number): LocalParts {
  const out: LocalParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of fmt.formatToParts(new Date(ms))) {
    if (part.type in out) out[part.type as keyof LocalParts] = Number(part.value);
  }
  return out;
}

/** Local time minus UTC at `ms`, in milliseconds (whole seconds: Intl has no sub-second offsets). */
function offsetAt(fmt: Intl.DateTimeFormat, ms: number): number {
  const p = localParts(fmt, ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}
