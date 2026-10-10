/**
 * Sessions & playtime (the `activity` category, handoff §12): playtime per day over the last 30 days
 * as a bar chart, and the most recent play sessions (start, duration, worlds, how they ended).
 * Sessions on special worlds are included (D-45). Server component; the chart is a lazy client chart.
 */
import { formatDuration } from '@hub/core';
import type { PlaySession } from '@hub/server';
import { PlaytimeChart } from '@/components/charts/playtime-chart';
import type { PlaytimeDay } from '@/components/charts/options';
import { Stat } from '@/components/common/stat';
import { Badge } from '@/components/ui/badge';
import { DATE_TIME_OPTIONS, formatInZone } from '@/lib/dates';
import { sessionEndLabel } from './items';

/** Sessions listed under the chart. */
export const RECENT_SESSIONS = 8;

/** Worlds of one session listed before "and N more" (a world hopper can visit a hundred). */
export const WORLDS_SHOWN = 3;

export interface ActivityContentProps {
  /** Sessions of the last 30 days, newest first (getSessions). */
  sessions: readonly PlaySession[];
  /** Playtime per local day, oldest first (playtimeByDay). */
  playtime: readonly PlaytimeDay[];
  timezone: string;
}

export function ActivityContent({ sessions, playtime, timezone }: ActivityContentProps) {
  const totalMs = playtime.reduce((sum, d) => sum + d.ms, 0);
  const daysPlayed = playtime.filter((d) => d.ms > 0).length;
  if (sessions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No play sessions in the last 30 days. Sessions appear here while the player is logged in
        with the plugin running.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-3 gap-4">
        <Stat label="Played, 30 days" value={formatDuration(totalMs / 1000)} />
        <Stat label="Days played" value={`${daysPlayed} of ${playtime.length}`} />
        <Stat label="Sessions" value={String(sessions.length)} />
      </dl>
      <PlaytimeChart days={playtime} />
      <div>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">Recent sessions</h3>
        <ul className="divide-y text-sm">
          {sessions.slice(0, RECENT_SESSIONS).map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <time dateTime={s.startedAt} className="min-w-28 font-medium">
                {formatInZone(s.startedAt, timezone, DATE_TIME_OPTIONS)}
              </time>
              <span className="tabular-nums">{formatDuration(s.durationMs / 1000)}</span>
              {s.worlds.length > 0 && <SessionWorlds worlds={s.worlds} />}
              <Badge
                variant={s.endReason === null ? 'secondary' : 'outline'}
                className="ml-auto text-muted-foreground"
              >
                {sessionEndLabel(s.endReason)}
              </Badge>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** "Worlds 395, 394, 390 and 41 more", the rest behind the "more" (as previous names in the header). */
function SessionWorlds({ worlds }: { worlds: readonly number[] }) {
  return (
    <span className="text-muted-foreground">
      {worlds.length === 1 ? 'World' : 'Worlds'} {worlds.slice(0, WORLDS_SHOWN).join(', ')}
      {worlds.length > WORLDS_SHOWN && (
        <details className="inline [&[open]>summary]:hidden">
          <summary className="inline cursor-pointer underline-offset-4 hover:underline">
            {' '}
            and {worlds.length - WORLDS_SHOWN} more
          </summary>
          , {worlds.slice(WORLDS_SHOWN).join(', ')}
        </details>
      )}
    </span>
  );
}
