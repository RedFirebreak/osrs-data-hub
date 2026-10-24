/**
 * "Playtime" on the character page and Home: everything the hub has of the character's play time in
 * one card, so it doesn't take a trip to the deep dive. The total since the hub's first session of
 * the character, today and the last 30 days, and a bar per day for the last two weeks. The sessions
 * themselves and the 30-day chart stay on the deep dive ("Sessions"). Gated by `activity`, as the
 * sessions are: renders nothing without it. Async server component; the page streams it behind a
 * skeleton.
 */
import { DAY_MS, HOUR_MS, formatNumber, type Viewer } from '@hub/core';
import { getDb } from '@hub/db';
import { getPlaytimeTotal, getSessions } from '@hub/server';
import Link from 'next/link';
import type { PlaytimeDay } from '@/components/charts/options';
import { SectionCard } from '@/components/common/section-card';
import { Stat } from '@/components/common/stat';
import { formatInZone } from '@/lib/dates';
import { deepDiveHref } from '@/lib/routes';
import { cn } from '@/lib/utils';
import { playtimeByDay } from './playtime';

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
          <PlaytimeBars days={days.slice(-Math.min(bars, PLAYTIME_DAYS))} />
        </div>
      )}
    </SectionCard>
  );
}

/**
 * A bar per day, today last and in the foreground colour. Plain HTML, so it renders on the server;
 * each bar's day and time are in its title and in a visually hidden list for screen readers.
 */
function PlaytimeBars({ days }: { days: readonly PlaytimeDay[] }) {
  if (days.length === 0) return null;
  // At least an hour high, so a quiet fortnight doesn't draw ten minutes as a full bar.
  const max = Math.max(HOUR_MS, ...days.map((d) => d.ms));
  // A local day (YYYY-MM-DD) as a date: noon UTC of it is that day in UTC.
  const dayText = (day: string, options: Intl.DateTimeFormatOptions) =>
    formatInZone(`${day}T12:00:00Z`, 'UTC', options) ?? day;
  const label = (d: PlaytimeDay) =>
    `${dayText(d.day, { weekday: 'short', day: 'numeric', month: 'short' })}: ${
      d.ms > 0 ? formatPlaytime(d.ms) : 'not played'
    }`;
  return (
    <figure className="flex flex-col gap-1">
      <div aria-hidden className="flex h-12 items-end gap-1">
        {days.map((d, i) => (
          <div
            key={d.day}
            title={label(d)}
            className={cn(
              'flex-1 rounded-sm',
              i === days.length - 1 ? 'bg-foreground' : 'bg-foreground/35',
              d.ms === 0 && 'bg-muted',
            )}
            style={{ height: d.ms > 0 ? `${Math.max(8, (d.ms / max) * 100)}%` : '3px' }}
          />
        ))}
      </div>
      <figcaption className="flex justify-between text-xs text-muted-foreground">
        <span>{dayText((days[0] as PlaytimeDay).day, { day: 'numeric', month: 'short' })}</span>
        <span>Today</span>
      </figcaption>
      <ul className="sr-only">
        {days.map((d) => (
          <li key={d.day}>{label(d)}</li>
        ))}
      </ul>
    </figure>
  );
}
