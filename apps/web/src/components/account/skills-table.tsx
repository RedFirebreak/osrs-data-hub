/**
 * The skills table (handoff §12): Overall first, then the skills in the in-game grid order (the read
 * model already sorts them), with the real level (a virtual level above 99 is shown subtly next to
 * it, PLUGIN-9), XP, and XP gained today / over 7, 30 and 365 days. Overall's level is the real total
 * level (D-44). Server component.
 */
import { MAX_REAL_LEVEL, OVERALL, formatGain, formatNumber } from '@hub/core';
import type { SkillRow } from '@hub/server';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

const GAIN_COLUMNS = [
  { key: 'day', label: 'Today', title: 'Since midnight in your time zone' },
  { key: 'week', label: '7 days', title: 'Over the last 7 days' },
  { key: 'month', label: '30 days', title: 'Over the last 30 days' },
  { key: 'year', label: '1 year', title: 'Over the last 365 days' },
] as const;

export interface SkillsTableProps {
  rows: readonly SkillRow[];
  className?: string;
}

/** Shown after the real level when the plugin's level is virtual (above 99), else null. */
export function virtualLevel(row: Pick<SkillRow, 'skill' | 'level'>): number | null {
  return row.skill !== OVERALL && row.level > MAX_REAL_LEVEL ? row.level : null;
}

export function SkillsTable({ rows, className }: SkillsTableProps) {
  return (
    <Table className={cn('tabular-nums', className)}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col">Skill</TableHead>
          <TableHead scope="col" className="text-right">
            Level
          </TableHead>
          <TableHead scope="col" className="text-right">
            XP
          </TableHead>
          {GAIN_COLUMNS.map((c) => (
            <TableHead key={c.key} scope="col" className="text-right" title={c.title}>
              {c.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const overall = row.skill === OVERALL;
          const virtual = virtualLevel(row);
          return (
            <TableRow key={row.skill} className={cn(overall && 'bg-muted/40 font-medium')}>
              <TableHead scope="row" className="font-medium">
                {overall ? 'Overall' : row.skill}
              </TableHead>
              <TableCell className="text-right">
                {formatNumber(row.realLevel)}
                {virtual !== null && (
                  <span
                    className="ml-1 text-xs text-muted-foreground"
                    title={`Virtual level ${virtual}`}
                  >
                    ({virtual})<span className="sr-only"> virtual level</span>
                  </span>
                )}
              </TableCell>
              <TableCell className="text-right">{formatNumber(row.xp)}</TableCell>
              {GAIN_COLUMNS.map((c) => {
                const gain = row.gains[c.key];
                return (
                  <TableCell
                    key={c.key}
                    className={cn(
                      'text-right',
                      gain > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground',
                    )}
                  >
                    {formatGain(gain)}
                  </TableCell>
                );
              })}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
