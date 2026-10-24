/**
 * The official hiscores on the character page (D-105, D-122): tiles in the way of the skills panel,
 * each with the icon RuneLite's hiscore panel draws (osrs-icons `/hiscores/`), the name and the
 * score, the ranks in its tooltip. Bosses come first, most kills first; a boss tile opens the boss's
 * page. The first BOSSES_SHOWN show, the rest fold under "All N bosses". Clue scrolls (in Jagex's
 * order) and the minigames follow as tiles that don't link anywhere. Server component.
 */
import { formatNumber, type HiscoreMode } from '@hub/core';
import type { HiscoresActivityView, HiscoresView } from '@hub/server';
import Link from 'next/link';
import { HiscoreIcon } from '@/components/icons/osrs-icon';
import { bossHref } from '@/lib/routes';
import { cn } from '@/lib/utils';

/** Boss tiles shown before the rest fold away: four rows of the panel's three columns. */
export const BOSSES_SHOWN = 12;

/** The iron table's name, for its rank column ("Ironman rank"). */
export const MODE_LABELS: Readonly<Record<HiscoreMode, string | null>> = {
  regular: null,
  ironman: 'Ironman',
  hardcore_ironman: 'Hardcore',
  ultimate_ironman: 'Ultimate',
};

const GROUPS = [
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

export function HiscoresContent({ view, publicId }: { view: HiscoresView; publicId: string }) {
  const note = statusNote(view);
  const mode = MODE_LABELS[view.mode];
  // Most kills first: the bosses someone plays stand out; ties keep Jagex's (alphabetical) order.
  const bosses = view.activities.filter((a) => a.kind === 'boss').sort((a, b) => b.score - a.score);
  const groups = GROUPS.map((g) => ({
    ...g,
    rows: view.activities.filter((a) => a.kind === g.kind),
  })).filter((g) => g.rows.length > 0);
  const tile = (row: HiscoresActivityView, href?: ReturnType<typeof bossHref>) => (
    <li key={row.activity} className="min-w-0">
      <ActivityTile row={row} mode={mode} href={href} />
    </li>
  );
  return (
    <div className="flex flex-col gap-5">
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
      {view.fetchedAt !== null && bosses.length === 0 && groups.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No kill counts, clues or minigames on the hiscores yet. Most bosses show from 5 kills.
        </p>
      )}
      {bosses.length > 0 && (
        <section aria-label="Bosses" className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">Bosses</h3>
          <ul className={GRID}>
            {bosses
              .slice(0, BOSSES_SHOWN)
              .map((row) => tile(row, bossHref(publicId, row.activity)))}
          </ul>
          {bosses.length > BOSSES_SHOWN && (
            <details className="group flex flex-col gap-2">
              <summary className="w-fit cursor-pointer rounded-md text-sm font-medium underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
                <span className="group-open:hidden">All {bosses.length} bosses</span>
                <span className="hidden group-open:inline">Fewer bosses</span>
              </summary>
              <ul className={cn(GRID, 'mt-2')}>
                {bosses
                  .slice(BOSSES_SHOWN)
                  .map((row) => tile(row, bossHref(publicId, row.activity)))}
              </ul>
            </details>
          )}
        </section>
      )}
      {groups.map((g) => (
        <section key={g.kind} aria-label={g.title} className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">{g.title}</h3>
          <ul className={GRID}>{g.rows.map((row) => tile(row))}</ul>
        </section>
      ))}
    </div>
  );
}

const GRID = 'grid grid-cols-2 gap-1.5 sm:grid-cols-3 sm:gap-2';

/** What a tile says to a screen reader, and in its tooltip: the score and the ranks. */
export function activityTileLabel(row: HiscoresActivityView, mode: string | null): string {
  const parts = [`${row.activity}: ${formatNumber(row.score)}`];
  if (row.rank !== null) parts.push(`rank ${formatNumber(row.rank)}`);
  if (mode !== null && row.modeRank !== null) {
    parts.push(`${mode} rank ${formatNumber(row.modeRank)}`);
  }
  return parts.join(', ');
}

/** The name on a tile: a clue tier alone under "Clue scrolls" ("Beginner", "All"), else the name. */
export function tileName(row: HiscoresActivityView): string {
  const tier = row.kind === 'clue' ? /\(([^)]+)\)\s*$/.exec(row.activity)?.[1] : undefined;
  return tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : row.activity;
}

function ActivityTile({
  row,
  mode,
  href,
}: {
  row: HiscoresActivityView;
  mode: string | null;
  href?: ReturnType<typeof bossHref>;
}) {
  const label = activityTileLabel(row, mode);
  const inner = (
    <>
      <HiscoreIcon
        activity={row.activity}
        holdSpace
        fallback={
          <span
            aria-hidden
            className="grid size-7 shrink-0 place-items-center rounded-md bg-foreground/10 text-xs font-semibold text-muted-foreground"
          >
            {row.activity
              .replace(/^the\s+/i, '')
              .charAt(0)
              .toUpperCase()}
          </span>
        }
      />
      <span className="min-w-0 flex-1 truncate text-sm">{tileName(row)}</span>
      <span className="text-base leading-none font-semibold tabular-nums">
        {formatNumber(row.score)}
      </span>
    </>
  );
  const box =
    'flex items-center gap-2 rounded-lg border bg-muted/50 px-2.5 py-1.5 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none';
  return href ? (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className={cn(box, 'pressable hover:border-foreground/30')}
    >
      {inner}
    </Link>
  ) : (
    <div aria-label={label} title={label} role="group" className={box}>
      {inner}
    </div>
  );
}
