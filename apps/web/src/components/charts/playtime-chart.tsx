'use client';
/**
 * Playtime per day (the account page's activity section): a bar per day in hours, drawn by the lazy
 * EChart. The days come from the server (components/account-page/playtime.ts cuts sessions at the
 * viewer's local midnights). The same numbers are in a table below the chart (newest day first:
 * ChartWithTable's rule) for screen readers and anyone who prefers a table.
 */
import { formatDuration } from '@hub/core';
import { useCallback } from 'react';
import { ChartWithTable } from './chart-with-table';
import { playtimeOption, type ChartTheme, type PlaytimeDay } from './options';

export interface PlaytimeChartProps {
  days: readonly PlaytimeDay[];
  className?: string;
}

export function PlaytimeChart({ days, className }: PlaytimeChartProps) {
  const option = useCallback((theme: ChartTheme) => playtimeOption(days, theme), [days]);
  const total = days.reduce((sum, d) => sum + d.ms, 0);
  return (
    <ChartWithTable
      className={className}
      option={option}
      label={`Playtime per day over the last ${days.length} days, ${formatDuration(total / 1000)} in total`}
      columns={['Day', 'Played']}
      rows={days.map((d) => ({
        day: d.day,
        values: [d.ms > 0 ? formatDuration(d.ms / 1000) : '—'],
      }))}
    />
  );
}
