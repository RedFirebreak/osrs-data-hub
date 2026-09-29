'use client';
/**
 * Playtime per day (the account page's activity section): a bar per day in hours, drawn by the lazy
 * EChart. The days come from the server (components/account/playtime.ts cuts sessions at the viewer's
 * local midnights). The same numbers are in a table below the chart for screen readers and anyone who
 * prefers a table.
 */
import { formatDuration } from '@hub/core';
import { useCallback } from 'react';
import { LazyEChart } from './lazy-echart';
import { playtimeOption, type ChartTheme, type PlaytimeDay } from './options';

export interface PlaytimeChartProps {
  days: readonly PlaytimeDay[];
  className?: string;
}

export function PlaytimeChart({ days, className }: PlaytimeChartProps) {
  const option = useCallback((theme: ChartTheme) => playtimeOption(days, theme), [days]);
  const total = days.reduce((sum, d) => sum + d.ms, 0);
  return (
    <div className={className}>
      <LazyEChart
        option={option}
        label={`Playtime per day over the last ${days.length} days, ${formatDuration(total / 1000)} in total`}
      />
      <details className="mt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">Show as table</summary>
        <table className="mt-2 w-full text-left tabular-nums">
          <thead>
            <tr>
              <th scope="col" className="py-1 font-medium">
                Day
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Played
              </th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.day} className="border-t">
                <td className="py-1">
                  <time dateTime={d.day}>{d.day}</time>
                </td>
                <td className="py-1 text-right">{d.ms > 0 ? formatDuration(d.ms / 1000) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
