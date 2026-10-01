'use client';
/**
 * A per-day chart with its numbers in a table below it ("Show as table", closed by default), for
 * screen readers and anyone who prefers a table: the chart itself is one role="img" element. Drawn by
 * the lazy EChart, so echarts never loads on the server.
 *
 *   const option = useCallback((theme: ChartTheme) => playtimeOption(days, theme), [days]);
 *   <ChartWithTable
 *     option={option}
 *     label="Playtime per day over the last 30 days, 12h 30m in total"
 *     columns={['Day', 'Played']}
 *     rows={days.map((d) => ({ day: d.day, values: [formatDuration(d.ms / 1000)] }))}
 *   />
 *
 * `option` is a function of the resolved theme; pass a memoized one (see echart.tsx). The table
 * lists the newest day first, whatever order the rows come in (a chart's own order is oldest first,
 * left to right): tables default to newest first, so a chart built on this gets that for free.
 */
import { LazyEChart } from './lazy-echart';
import type { ChartOption, ChartTheme } from './options';

export interface ChartTableRow {
  /** The row's calendar day, YYYY-MM-DD: its first cell and its key. */
  day: string;
  /** One text per column after the day. */
  values: readonly string[];
}

export interface ChartWithTableProps {
  option: (theme: ChartTheme) => ChartOption;
  /** What the chart shows, for screen readers. */
  label: string;
  /** Column headings: the day column first, then one per value. */
  columns: readonly string[];
  /** One row per day, in any order: the table sorts them newest first. */
  rows: readonly ChartTableRow[];
  className?: string;
}

/** The rows by day, newest first (YYYY-MM-DD sorts as text). */
function newestFirst(rows: readonly ChartTableRow[]): ChartTableRow[] {
  return [...rows].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

export function ChartWithTable({ option, label, columns, rows, className }: ChartWithTableProps) {
  return (
    <div className={className}>
      <LazyEChart option={option} label={label} />
      <details className="mt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">
          Show as table
        </summary>
        <table className="mt-2 w-full text-left tabular-nums">
          <thead>
            <tr>
              {columns.map((heading, i) => (
                <th
                  key={heading}
                  scope="col"
                  className={i === 0 ? 'py-1 font-medium' : 'py-1 text-right font-medium'}
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {newestFirst(rows).map((row) => (
              <tr key={row.day} className="border-t">
                <td className="py-1">
                  <time dateTime={row.day}>{row.day}</time>
                </td>
                {row.values.map((value, i) => (
                  <td key={columns[i + 1] ?? i} className="py-1 text-right">
                    {value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
