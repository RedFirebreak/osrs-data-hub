/**
 * Playtime per local day from play sessions (the account page's activity section). Server-side only:
 * it uses @hub/server's DST-safe startOfLocalDay, so import it from server components, never from a
 * 'use client' module (NEXT-12).
 */
import { HOUR_MS } from '@hub/core';
import { startOfLocalDay, type PlaySession } from '@hub/server';
import type { PlaytimeDay } from '@/components/charts/options';
import { localDate } from '@/lib/dates';

/**
 * Milliseconds played on each of the last `days` local days (today included, oldest first) in
 * `timezone`. A session is cut at local midnights, so one that runs past midnight counts on both
 * days; an open session counts up to its last payload (PlaySession.durationMs). Day boundaries follow
 * DST (a day can be 23 or 25 hours long).
 */
export function playtimeByDay(
  sessions: readonly Pick<PlaySession, 'startedAt' | 'durationMs'>[],
  opts: { now: Date; days: number; timezone: string },
): PlaytimeDay[] {
  const count = Math.max(0, Math.floor(opts.days));
  if (count === 0) return [];
  const today = startOfLocalDay(opts.now, opts.timezone).getTime();
  // Tomorrow's start: every day is 23–25 h long, so 26 h after today's start lies in tomorrow.
  const starts = [startOfLocalDay(new Date(today + 26 * HOUR_MS), opts.timezone).getTime(), today];
  while (starts.length < count + 1) {
    const earliest = starts.at(-1) as number;
    starts.push(startOfLocalDay(new Date(earliest - 1), opts.timezone).getTime());
  }
  starts.reverse(); // oldest first; the last entry is tomorrow's start (the end of today)

  const out: PlaytimeDay[] = [];
  for (let i = 0; i < count; i++) {
    const dayStart = starts[i] as number;
    const dayEnd = starts[i + 1] as number;
    let ms = 0;
    for (const session of sessions) {
      const start = Date.parse(session.startedAt);
      if (!Number.isFinite(start)) continue;
      const end = start + Math.max(0, session.durationMs);
      ms += Math.max(0, Math.min(end, dayEnd) - Math.max(start, dayStart));
    }
    out.push({ day: localDate(new Date(dayStart), opts.timezone), ms });
  }
  return out;
}
