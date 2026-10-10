/**
 * A chart's numbers as a table under it ("Show as table", closed by default): a chart is one
 * role="img" element, so the table is what a screen reader and anyone who prefers numbers reads.
 * The rows are whatever the chart is about, in the order given (a table of dated rows lists the
 * newest first, §12). Server- and client-safe.
 *
 *   <ChartDataTable columns={['Up to', 'XP']} rows={[['10 Oct, 14:00', '12,000 XP']]} />
 */
import { cn } from '@/lib/utils';

export interface ChartDataTableProps {
  columns: readonly string[];
  /** One row per line of the table; the first cell is its heading. */
  rows: readonly (readonly string[])[];
}

export function ChartDataTable({ columns, rows }: ChartDataTableProps) {
  return (
    <details className="mt-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none hover:text-foreground">Show as table</summary>
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
  );
}
