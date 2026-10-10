/**
 * Local calendar positions of an instant in a time zone (weekday, hour, day), for Metrics' heatmap
 * and per-day charts. Pure apart from Intl. An unknown time zone falls back to UTC, as the gains
 * periods do: the stored setting is validated on save, so this only guards a runtime that lacks a
 * zone the saving one knew.
 */
import { MINUTE_MS } from '../time';

export interface LocalClock {
  /** YYYY-MM-DD in the zone. */
  day: string;
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  /** 0…23. */
  hour: number;
  /** Minutes since local midnight, 0…1439. */
  minuteOfDay: number;
}

const WEEKDAYS: Readonly<Record<string, number>> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

const formatters = new Map<string, Intl.DateTimeFormat>();
/** Intl accepts any capitalization of a zone name, so input could grow the cache without this. */
const MAX_CACHED_FORMATTERS = 1_000;

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached) return cached;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = makeFormatter(timezone);
  } catch {
    return formatterFor('UTC');
  }
  if (formatters.size < MAX_CACHED_FORMATTERS) formatters.set(timezone, fmt);
  return fmt;
}

function makeFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The local clock of `ms` in `timezone`. Each call formats once; callers that walk thousands of
 * 5-minute buckets use a LocalClockCache, which formats once per hour.
 */
export function localClock(ms: number, timezone: string): LocalClock {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timezone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS[parts.weekday ?? 'Mon'] ?? 0,
    hour,
    minuteOfDay: hour * 60 + minute,
  };
}

/**
 * localClock with one Intl call per quarter hour: every zone's offset is a multiple of 15 minutes, so
 * within one UTC quarter hour the local clock only moves by the minutes elapsed. Cached per quarter
 * hour, then shifted by the minutes into it.
 */
export class LocalClockCache {
  private readonly cache = new Map<number, LocalClock>();
  constructor(private readonly timezone: string) {}

  at(ms: number): LocalClock {
    const quarter = Math.floor(ms / (15 * MINUTE_MS));
    let base = this.cache.get(quarter);
    if (!base) {
      base = localClock(quarter * 15 * MINUTE_MS, this.timezone);
      if (this.cache.size > 100_000) this.cache.clear();
      this.cache.set(quarter, base);
    }
    const extra = Math.floor((ms - quarter * 15 * MINUTE_MS) / MINUTE_MS);
    if (extra === 0) return base;
    // Local quarter hours line up with UTC ones, so the extra minutes never cross an hour or a day.
    const minuteOfDay = base.minuteOfDay + extra;
    return { ...base, minuteOfDay, hour: Math.floor(minuteOfDay / 60) };
  }
}
