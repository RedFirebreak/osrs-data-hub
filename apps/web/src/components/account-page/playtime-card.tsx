/**
 * "Playtime" on the character page and Home: everything the hub has of the character's play time in
 * one card, so it doesn't take a trip to the deep dive. The total since the hub's first session of
 * the character, today and the last 30 days, and a bar per day for the last two weeks. A bar shows the
 * day's time and sessions on hover and opens that day in the deep dive (D-122); the sessions
 * themselves and the 30-day chart stay there ("Sessions"). Gated by `activity`, as the
 * sessions are: renders nothing without it. Async server component; the page streams it behind a
 * skeleton.
 */
import { DAY_MS, formatNumber, type Viewer } from '@hub/core';
import { getDb } from '@hub/db';
import { getPlaytimeTotal, getSessions, type PlaySession } from '@hub/server';
import Link from 'next/link';
import type { PlaytimeDay } from '@/components/charts/options';
import { SectionCard } from '@/components/common/section-card';
import { Stat } from '@/components/common/stat';
import { formatInZone, localDate } from '@/lib/dates';
import { deepDiveDayHref, deepDiveHref } from '@/lib/routes';
import { playtimeByDay } from './playtime';
import { PlaytimeBars, type PlaytimeBar } from './playtime-bars';

/** Days behind "30 days" and "Days played". */
export const PLAYTIME_DAYS = 30;
/** Days drawn as bars. */
export const PLAYTIME_BARS = 14;

const MINUTE_MS = 60_000;

/** "42m", "3h 05m", "312h": minutes drop off once the hours are in the hundreds. */
export function formatPlaytime(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE_MS);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (h >= 100) return `${formatNumber(h)}h`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** Today, the window's total and the days with any play, from playtimeByDay's days (oldest first). */
export function summarizePlaytime(days: readonly PlaytimeDay[]) {
  return {
    todayMs: days.at(-1)?.ms ?? 0,
    totalMs: days.reduce((sum, d) => sum + d.ms, 0),
    daysPlayed: days.filter((d) => d.ms > 0).length,
  };
}

/**
 * How many sessions ran on each of `days` (local YYYY-MM-DD): a session counts on every local day from
 * the one it started on to the one it ended on (an open one: its last payload).
 */
export function sessionsPerDay(
  sessions: readonly Pick<PlaySession, 'startedAt' | 'durationMs'>[],
  days: readonly string[],
  timezone: string,
): number[] {
  return days.map((day) => {
    let n = 0;
    for (const session of sessions) {
      const start = Date.parse(session.startedAt);
      if (!Number.isFinite(start)) continue;
      const first = localDate(new Date(start), timezone);
      const last = localDate(new Date(start + Math.max(0, session.durationMs)), timezone);
      if (first <= day && day <= last) n++;
    }
    return n;
  });
}

export interface PlaytimeCardProps {
  publicId: string;
  viewer: Viewer;
  now: Date;
  timezone: string;
  /** Days drawn as bars, up to PLAYTIME_DAYS: the wide main column has room for all 30. */
  bars?: number;
}

export async function PlaytimeCard({
  publicId,
  viewer,
  now,
  timezone,
  bars = PLAYTIME_BARS,
}: PlaytimeCardProps) {
  const { db } = getDb();
  const [total, sessions] = await Promise.all([
    getPlaytimeTotal(db, viewer, publicId, { now }),
    getSessions(db, viewer, publicId, {
      from: new Date(now.getTime() - PLAYTIME_DAYS * DAY_MS),
      to: now,
    }),
  ]);
  if (!total || !sessions) return null;
  const days = playtimeByDay(sessions, { now, days: PLAYTIME_DAYS, timezone });
  const { todayMs, totalMs, daysPlayed } = summarizePlaytime(days);
  const since = total.since
    ? formatInZone(total.since, timezone, { day: 'numeric', month: 'short', year: 'numeric' })
    : null;

  return (
    <SectionCard
      id="playtime"
      title="Playtime"
      action={
        <Link
          href={`${deepDiveHref(publicId)}#activity`}
          className="text-sm font-medium underline-offset-4 hover:underline focus-visible:underline"
        >
          Sessions
        </Link>
      }
    >
      {total.sessions === 0 ? (
        <p className="text-sm text-muted-foreground">
          No play sessions yet. Time is counted while the player is logged in with the plugin
          running.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <p
              className="text-3xl leading-tight font-semibold tracking-tight tabular-nums"
              title={`${formatNumber(Math.floor(total.totalMs / MINUTE_MS))} minutes`}
            >
              {formatPlaytime(total.totalMs)}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              In {formatNumber(total.sessions)} {total.sessions === 1 ? 'session' : 'sessions'}
              {since && <> since {since}</>}
            </p>
          </div>
          <dl className="grid grid-cols-3 gap-3">
            <Stat label="Today" value={formatPlaytime(todayMs)} muted={todayMs === 0} />
            <Stat label="30 days" value={formatPlaytime(totalMs)} muted={totalMs === 0} />
            <Stat label="Days played" value={`${daysPlayed} of ${days.length}`} />
          </dl>
          <Bars
            days={days.slice(-Math.min(bars, PLAYTIME_DAYS))}
            sessions={sessions}
            publicId={publicId}
            timezone={timezone}
          />
        </div>
      )}
    </SectionCard>
  );
}

/** The bars' days as the client draws them: labels, times and where each day leads. */
function Bars({
  days,
  sessions,
  publicId,
  timezone,
}: {
  days: readonly PlaytimeDay[];
  sessions: readonly PlaySession[];
  publicId: string;
  timezone: string;
}) {
  if (days.length === 0) return null;
  // A local day (YYYY-MM-DD) as a date: noon UTC of it is that day in UTC.
  const dayText = (day: string, options: Intl.DateTimeFormatOptions) =>
    formatInZone(`${day}T12:00:00Z`, 'UTC', options) ?? day;
  const counts = sessionsPerDay(
    sessions,
    days.map((d) => d.day),
    timezone,
  );
  const bars: PlaytimeBar[] = days.map((d, i) => ({
    day: d.day,
    ms: d.ms,
    sessions: counts[i] ?? 0,
    label: dayText(d.day, { weekday: 'short', day: 'numeric', month: 'short' }),
    played: d.ms > 0 ? formatPlaytime(d.ms) : null,
    href: d.ms > 0 ? deepDiveDayHref(publicId, d.day) : null,
  }));
  return (
    <PlaytimeBars
      days={bars}
      firstLabel={dayText((days[0] as PlaytimeDay).day, { day: 'numeric', month: 'short' })}
    />
  );
}
