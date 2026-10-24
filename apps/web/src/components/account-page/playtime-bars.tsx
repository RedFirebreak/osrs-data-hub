'use client';
/**
 * The playtime card's bars (D-122): a bar per day, today last and in the foreground colour. Hovering
 * or focusing a bar shows a card like the Sessions chart's tooltip (the day, the time played, the
 * sessions), and a day that was played opens that day in the deep dive: what the hours went to. The
 * days come from the server (playtime-card.tsx); this only draws them.
 */
import { HOUR_MS } from '@hub/core';
import type { Route } from 'next';
import Link from 'next/link';
import { useState } from 'react';
import { cn } from '@/lib/utils';

export interface PlaytimeBar {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  ms: number;
  /** Play sessions that ran on the day. */
  sessions: number;
  /** "Tue 20 Oct". */
  label: string;
  /** "10h 20m", or null for a day without play. */
  played: string | null;
  /** The day in the deep dive; null for a day without play. */
  href: Route | null;
}

export interface PlaytimeBarsProps {
  days: readonly PlaytimeBar[];
  /** "1 Oct": under the first bar. */
  firstLabel: string;
}

/** What a bar says to a screen reader: the day, the time and the sessions. */
export function barLabel(bar: PlaytimeBar): string {
  if (bar.played === null) return `${bar.label}: not played`;
  const sessions = `${bar.sessions} ${bar.sessions === 1 ? 'session' : 'sessions'}`;
  return `${bar.label}: ${bar.played} in ${sessions}. Opens the day in Deep dive`;
}

export function PlaytimeBars({ days, firstLabel }: PlaytimeBarsProps) {
  const [shown, setShown] = useState<number | null>(null);
  if (days.length === 0) return null;
  // At least an hour high, so a quiet fortnight doesn't draw ten minutes as a full bar.
  const max = Math.max(HOUR_MS, ...days.map((d) => d.ms));
  const active = shown === null ? undefined : days[shown];
  // The card sits over its bar, kept inside the row at both ends.
  const at = shown === null ? 0 : ((shown + 0.5) / days.length) * 100;

  return (
    <figure className="flex flex-col gap-1">
      <div className="relative" onMouseLeave={() => setShown(null)}>
        <ul aria-label="Playtime per day" className="flex h-14 items-end gap-1">
          {days.map((d, i) => {
            const bar = (
              <span
                aria-hidden
                className={cn(
                  'block w-full rounded-sm transition-colors',
                  i === days.length - 1 ? 'bg-foreground' : 'bg-foreground/35',
                  d.ms === 0 && 'bg-muted',
                  shown === i && d.ms > 0 && 'bg-foreground',
                )}
                style={{ height: d.ms > 0 ? `${Math.max(8, (d.ms / max) * 100)}%` : '3px' }}
              />
            );
            const common = {
              onMouseEnter: () => setShown(i),
              onFocus: () => setShown(i),
              onBlur: () => setShown(null),
              className:
                'flex h-full flex-1 items-end rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
            };
            return (
              <li key={d.day} className="flex h-full min-w-0 flex-1">
                {d.href ? (
                  <Link href={d.href} aria-label={barLabel(d)} {...common}>
                    {bar}
                  </Link>
                ) : (
                  <span aria-label={barLabel(d)} role="img" tabIndex={-1} {...common}>
                    {bar}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {active && (
          <div
            role="presentation"
            aria-hidden
            className="pointer-events-none absolute bottom-full z-10 mb-2 w-52 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
            style={{
              left: `clamp(0px, calc(${at}% - 6.5rem), calc(100% - 13rem))`,
            }}
          >
            <p className="text-muted-foreground">{active.label}</p>
            {active.played === null ? (
              <p className="mt-1 font-medium">Not played</p>
            ) : (
              <>
                <p className="mt-1 flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2.5 rounded-[3px] bg-[#2a78d6] dark:bg-[#3987e5]"
                  />
                  <span className="font-semibold tabular-nums">{active.played}</span>
                  <span className="text-muted-foreground">played</span>
                </p>
                <p className="mt-0.5 pl-[18px] text-muted-foreground tabular-nums">
                  {active.sessions} {active.sessions === 1 ? 'session' : 'sessions'}
                </p>
                <p className="mt-1.5 border-t pt-1.5 text-muted-foreground">
                  Click to open the day
                </p>
              </>
            )}
          </div>
        )}
      </div>
      <figcaption className="flex justify-between text-xs text-muted-foreground">
        <span>{firstLabel}</span>
        <span>Today</span>
      </figcaption>
    </figure>
  );
}
