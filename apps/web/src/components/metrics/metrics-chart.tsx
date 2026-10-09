'use client';
/**
 * A Metrics chart with its numbers as a table below it ("Show as table", closed by default): the
 * chart is one role="img" element, so the table is what a screen reader and anyone who prefers
 * numbers reads. Like ChartWithTable, but the rows are whatever the chart is about (cells of a
 * heatmap, sessions, steps), not only days. Drawn by the lazy EChart; dims while the view reloads.
 *
 *   <MetricsChart option={option} label="…" columns={['Day', 'XP']} rows={[['Oct 5', '12,000']]} />
 */
import { LazyEChart } from '@/components/charts/lazy-echart';
import type { EChartEvents } from '@/components/charts/echart';
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
      <details className="mt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">
          Show as table
        </summary>
        <div className="max-h-80 overflow-auto">
          <table className="mt-2 w-full text-left tabular-nums">
            <thead>
              <tr>
                {columns.map((heading, i) => (
                  <th
                    key={heading}
                    scope="col"
                    className={cn('py-1 font-medium', i > 0 && 'text-right')}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={`${row[0]}-${r}`} className="border-t">
                  {row.map((cell, i) =>
                    i === 0 ? (
                      <th key={i} scope="row" className="py-1 font-normal">
                        {cell}
                      </th>
                    ) : (
                      <td key={i} className="py-1 text-right">
                        {cell}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
