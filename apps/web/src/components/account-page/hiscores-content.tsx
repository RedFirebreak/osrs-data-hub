/**
 * The official hiscores on the account page (D-105): boss kill counts (most kills first), clues and
 * the other activities, each with its rank, and the rank on the account's own iron table beside it
 * for an iron account. Server component.
 */
import { formatNumber, type HiscoreMode } from '@hub/core';
import type { HiscoresActivityView, HiscoresView } from '@hub/server';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/** The iron table's name, for its rank column ("Ironman rank"). */
export const MODE_LABELS: Readonly<Record<HiscoreMode, string | null>> = {
  regular: null,
  ironman: 'Ironman',
  hardcore_ironman: 'Hardcore',
  ultimate_ironman: 'Ultimate',
};

const GROUPS = [
  { kind: 'boss', title: 'Bosses' },
  { kind: 'clue', title: 'Clue scrolls' },
  { kind: 'activity', title: 'Minigames and more' },
] as const;

/** The card's line under the title: the Overall rank (and the iron one). */
export function hiscoresDescription(view: HiscoresView): React.ReactNode {
  const overall = view.skills.find((s) => s.skill === 'Overall');
  const mode = MODE_LABELS[view.mode];
  if (!overall || overall.rank === null) return 'From the official OSRS hiscores.';
  return (
    <span>
      Overall rank{' '}
      <span className="font-medium text-foreground tabular-nums">{formatNumber(overall.rank)}</span>
      {mode !== null && overall.modeRank !== null && (
        <>
          {' '}
          · {mode} rank{' '}
          <span className="font-medium text-foreground tabular-nums">
            {formatNumber(overall.modeRank)}
          </span>
        </>
      )}
    </span>
  );
}

/** Why there is nothing to show yet, or why what is shown may be old. */
function statusNote(view: HiscoresView): string | null {
  switch (view.status) {
    case 'pending':
      return 'Not looked up yet. The hub reads the official hiscores shortly.';
    case 'not_found':
      return view.fetchedAt === null
        ? 'Not on the official hiscores under this name: too low to be ranked yet, or renamed.'
        : 'No longer on the official hiscores under this name (renamed?). This is the last lookup that found it.';
    case 'mismatch':
      return view.fetchedAt === null
        ? 'The official hiscores show less than this account has reached. The hub looks again later.'
        : 'The latest lookup showed less than this account has reached, so this is the one before it.';
    default:
      return null;
  }
}

export function HiscoresContent({ view }: { view: HiscoresView }) {
  const note = statusNote(view);
  const mode = MODE_LABELS[view.mode];
  const groups = GROUPS.map((g) => ({
    ...g,
    rows: view.activities.filter((a) => a.kind === g.kind),
  })).filter((g) => g.rows.length > 0);
  // Most kills first: the bosses someone plays stand out; ties keep Jagex's (alphabetical) order.
  for (const g of groups) {
    if (g.kind === 'boss') g.rows = [...g.rows].sort((a, b) => b.score - a.score);
  }
  return (
    <div className="flex flex-col gap-4">
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
      {view.fetchedAt !== null && groups.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No kill counts, clues or minigames on the hiscores yet. Most bosses show from 5 kills.
        </p>
      )}
      {groups.map((g) => (
        <ActivityTable key={g.kind} title={g.title} rows={g.rows} mode={mode} />
      ))}
    </div>
  );
}

function ActivityTable({
  title,
  rows,
  mode,
}: {
  title: string;
  rows: readonly HiscoresActivityView[];
  mode: string | null;
}) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-medium text-muted-foreground">{title}</h3>
      <Table className="tabular-nums">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col">{title === 'Bosses' ? 'Boss' : 'Name'}</TableHead>
            <TableHead scope="col" className="text-right">
              Score
            </TableHead>
            <TableHead scope="col" className="text-right">
              Rank
            </TableHead>
            {mode !== null && (
              <TableHead scope="col" className="hidden text-right sm:table-cell">
                {mode} rank
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.activity}>
              <TableHead scope="row" className="font-medium">
                {row.activity}
              </TableHead>
              <TableCell className="text-right">{formatNumber(row.score)}</TableCell>
              <TableCell className={cn('text-right', row.rank === null && 'text-muted-foreground')}>
                {row.rank === null ? '–' : formatNumber(row.rank)}
              </TableCell>
              {mode !== null && (
                <TableCell
                  className={cn(
                    'hidden text-right sm:table-cell',
                    row.modeRank === null && 'text-muted-foreground',
                  )}
                >
                  {row.modeRank === null ? '–' : formatNumber(row.modeRank)}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
