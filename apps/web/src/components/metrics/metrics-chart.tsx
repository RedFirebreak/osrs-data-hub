'use client';
/**
 * A Deep dive chart with its numbers as a table below it (ChartDataTable). Like ChartWithTable, but
 * the rows are whatever the chart is about (cells of a heatmap, sessions, steps), not only days.
 * Drawn by the lazy EChart; dims while the view reloads.
 *
 *   <MetricsChart option={option} label="…" columns={['Day', 'XP']} rows={[['Oct 5', '12,000']]} />
 */
import { ChartDataTable } from '@/components/charts/data-table';
import type { EChartEvents } from '@/components/charts/echart';
import { LazyEChart } from '@/components/charts/lazy-echart';
import type { ChartOption, ChartTheme } from '@/components/charts/options';
import { cn } from '@/lib/utils';
import { useMetricsQuery } from './metrics-nav';

export interface MetricsChartProps {
  option: (theme: ChartTheme) => ChartOption;
  label: string;
  columns: readonly string[];
  /** One row per line of the table; the first cell is its heading. */
  rows: readonly (readonly string[])[];
  /** Sizing of the chart (default h-64). */
  className?: string;
  onEvents?: EChartEvents;
  brush?: boolean;
  /** A line under the chart (help text). */
  note?: React.ReactNode;
}

export function MetricsChart({
  option,
  label,
  columns,
  rows,
  className,
  onEvents,
  brush,
  note,
}: MetricsChartProps) {
  const { pending } = useMetricsQuery();
  return (
    <div>
      <LazyEChart
        option={option}
        label={label}
        busy={pending}
        className={cn('h-64', className)}
        onEvents={onEvents}
        brush={brush}
      />
      {note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
      <ChartDataTable columns={columns} rows={rows} />
    </div>
  );
}
