'use client';
/**
 * The wealth card's graph (D-125): the last 30 days as a line of the total over a light area.
 * Hovering or focusing a day shows a card like the playtime bars' (the day, the wealth, the bank,
 * the change), and a day opens in the deep dive. The days come from the server (wealth-card.tsx);
 * this only draws them.
 */
import type { Route } from 'next';
import Link from 'next/link';
import { useState } from 'react';
import { cn } from '@/lib/utils';

export interface WealthGraphDay {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** Carried plus bank at the day's end; null before the first day with data. */
  value: number | null;
  bank: number | null;
  /** The bank wasn't known yet: the value counts the first bank value read later. */
  bankAssumed: boolean;
  change: number | null;
  /** "Tue 20 Oct". */
  label: string;
  /** "2.47B" */
  valueText: string | null;
  bankText: string | null;
  /** "+1.2M", "-340K" */
  changeText: string | null;
  /** The day in the deep dive. */
  href: Route;
}

export interface WealthGraphProps {
  days: readonly WealthGraphDay[];
  /** "25 Sep": under the first day. */
  firstLabel: string;
}

/** What a day says to a screen reader. */
export function dayLabel(d: WealthGraphDay): string {
  if (d.valueText === null) return `${d.label}: no wealth known`;
  const change = d.changeText === null ? '' : `, ${d.changeText} gp that day`;
  return `${d.label}: ${d.valueText} gp${change}. Opens the day in Deep dive`;
}

export function WealthGraph({ days, firstLabel }: WealthGraphProps) {
  const [shown, setShown] = useState<number | null>(null);
  if (days.length === 0 || days.every((d) => d.value === null)) return null;
  const active = shown === null ? undefined : days[shown];
  const at = shown === null ? 0 : ((shown + 0.5) / days.length) * 100;

  return (
    <figure className="flex flex-col gap-1">
      <div className="relative h-20" onMouseLeave={() => setShown(null)}>
        <Line days={days} shown={shown} />
        {/* One hit area per day over the drawing: hover, focus and the link to the day. */}
        <ul aria-label="Wealth per day" className="absolute inset-0 flex">
          {days.map((d, i) => (
            <li key={d.day} className="flex h-full min-w-0 flex-1">
              <Link
                href={d.href}
                aria-label={dayLabel(d)}
                onMouseEnter={() => setShown(i)}
                onFocus={() => setShown(i)}
                onBlur={() => setShown(null)}
                className="h-full flex-1 rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              />
            </li>
          ))}
        </ul>
        {active && (
          <div
            role="presentation"
            aria-hidden
            className="pointer-events-none absolute bottom-full z-10 mb-2 w-52 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
            style={{ left: `clamp(0px, calc(${at}% - 6.5rem), calc(100% - 13rem))` }}
          >
            <p className="text-muted-foreground">{active.label}</p>
            {active.valueText === null ? (
              <p className="mt-1 font-medium">No wealth known yet</p>
            ) : (
              <>
                <p className="mt-1 flex items-center gap-2">
                  <span aria-hidden className="size-2.5 rounded-[3px] bg-foreground" />
                  <span className="font-semibold tabular-nums">{active.valueText} gp</span>
                  <span className="text-muted-foreground">wealth</span>
                </p>
                <p className="mt-0.5 pl-[18px] text-muted-foreground tabular-nums">
                  {active.bankAssumed
                    ? 'Bank not read yet: counted as when first read'
                    : active.bankText === null
                      ? 'Bank not known yet'
                      : `${active.bankText} in the bank`}
                </p>
                {active.changeText !== null && (
                  <p className={cn('mt-0.5 pl-[18px] tabular-nums', toneOf(active.change ?? 0))}>
                    {active.changeText} gp that day
                  </p>
                )}
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

function toneOf(change: number): string {
  if (Math.round(change) >= 1) return 'text-emerald-700 dark:text-emerald-300';
  if (Math.round(change) <= -1) return 'text-red-700 dark:text-red-300';
  return 'text-muted-foreground';
}

/** The total as a line over a light area. */
function Line({ days, shown }: { days: readonly WealthGraphDay[]; shown: number | null }) {
  const values = days.flatMap((d) => (d.value === null ? [] : [d.value]));
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || Math.max(max, 1);
  const lo = Math.max(0, min - span * 0.15);
  const hi = max + span * 0.1;
  // Each day at the middle of its hit area, so the hover lines up with the point.
  const x = (i: number) => ((i + 0.5) / days.length) * 100;
  const y = (v: number) => 40 - ((v - lo) / (hi - lo)) * 40;
  const path = (pick: (d: WealthGraphDay) => number | null) => {
    const pts = days
      .map((d, i) => ({ i, v: pick(d) }))
      .filter((p): p is { i: number; v: number } => p.v !== null);
    if (pts.length === 0) return null;
    const first = pts[0] as { i: number };
    const coords = pts.map((p) => `${x(p.i).toFixed(2)},${y(p.v).toFixed(2)}`);
    return {
      line: coords.join(' '),
      area: `M${x(first.i).toFixed(2)},40 L${coords.join(' L')} L${x(days.length - 1).toFixed(2)},40 Z`,
    };
  };
  const total = path((d) => d.value);
  const point = shown === null ? null : days[shown];
  const dot = shown !== null && point && point.value !== null ? point.value : null;
  return (
    <>
      <svg
        aria-hidden
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full overflow-visible"
      >
        {total && <path d={total.area} className="fill-foreground/10" />}
        {shown !== null && (
          <line
            x1={x(shown)}
            x2={x(shown)}
            y1={0}
            y2={40}
            className="stroke-foreground/30"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {total && (
          <polyline
            points={total.line}
            fill="none"
            className="stroke-foreground"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        )}
      </svg>
      {dot !== null && shown !== null && (
        <span
          aria-hidden
          className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
          style={{ left: `${x(shown)}%`, top: `${(y(dot) / 40) * 100}%` }}
        />
      )}
    </>
  );
}
