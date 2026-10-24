/**
 * Deep dive's bosses (D-126): a card per boss, the way the character page's hiscores tiles look but
 * larger, so each carries what the range adds: the kill count with the kills read in the range
 * (`+n`), the ranks, and with `events` the loot from it in the range and per kill (left off without
 * loot). Kills in the range
 * first, then the most kills; the first BOSSES_SHOWN show, the rest fold under "All N bosses". A
 * card opens the boss's page with this view's range. Server component.
 */
import { formatGp, formatNumber, metricsSearch, type MetricsQuery } from '@hub/core';
import type { BossMetrics } from '@hub/server';
import Link from 'next/link';
import {
  ActivityInitial,
  BOSSES_SHOWN,
  GainBadge,
} from '@/components/account-page/hiscores-content';
import { HiscoreIcon } from '@/components/icons/osrs-icon';
import { bossHref } from '@/lib/routes';
import { cn } from '@/lib/utils';

export interface BossCardsProps {
  bosses: readonly BossMetrics[];
  publicId: string;
  query: MetricsQuery;
  showGp: boolean;
  /** The iron table's name for an iron account ("Ironman"), else null. */
  modeLabel: string | null;
}

/** The loot per kill in the range: only when both the kills and the loot are known. */
export function lootPerKill(boss: Pick<BossMetrics, 'gained' | 'gp'>): number | null {
  return boss.gp && boss.gained > 0 ? Math.round(boss.gp / boss.gained) : null;
}

/** The ranks line under a card's name: "Rank 4,321 · Ironman 12", or null when unranked. */
export function bossRanks(boss: BossMetrics, modeLabel: string | null): string | null {
  const parts: string[] = [];
  if (boss.rank !== null) parts.push(`Rank ${formatNumber(boss.rank)}`);
  if (modeLabel !== null && boss.modeRank !== null) {
    parts.push(`${modeLabel} ${formatNumber(boss.modeRank)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

const GRID = 'grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4';

export function BossCards({ bosses, publicId, query, showGp, modeLabel }: BossCardsProps) {
  // A boss page has a range of its own: it keeps this view's, not its measure or session.
  const search = metricsSearch({ ...query, session: null, measure: 'xp', skills: [], bosses: [] });
  const card = (b: BossMetrics) => (
    <li key={b.activity} className="min-w-0">
      <BossCard
        boss={b}
        href={bossHref(publicId, b.activity, search)}
        showGp={showGp}
        modeLabel={modeLabel}
      />
    </li>
  );
  return (
    <div className="flex flex-col gap-2">
      <ul className={GRID}>{bosses.slice(0, BOSSES_SHOWN).map(card)}</ul>
      {bosses.length > BOSSES_SHOWN && (
        <details className="group flex flex-col gap-2">
          <summary className="w-fit cursor-pointer rounded-md text-sm font-medium underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
            <span className="group-open:hidden">All {bosses.length} bosses</span>
            <span className="hidden group-open:inline">Fewer bosses</span>
          </summary>
          <ul className={cn(GRID, 'mt-2')}>{bosses.slice(BOSSES_SHOWN).map(card)}</ul>
        </details>
      )}
    </div>
  );
}

function BossCard({
  boss,
  href,
  showGp,
  modeLabel,
}: {
  boss: BossMetrics;
  href: ReturnType<typeof bossHref>;
  showGp: boolean;
  modeLabel: string | null;
}) {
  const ranks = bossRanks(boss, modeLabel);
  const perKill = lootPerKill(boss);
  return (
    <Link
      href={href}
      className="pressable flex h-full flex-col gap-3 rounded-xl border bg-muted/50 p-3 hover:border-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span className="flex items-center gap-3">
        <HiscoreIcon
          activity={boss.activity}
          className="size-10"
          holdSpace
          fallback={<ActivityInitial activity={boss.activity} className="size-10 text-sm" />}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-medium" title={boss.activity}>
            {boss.activity}
          </span>
          <span className="truncate text-xs text-muted-foreground tabular-nums">
            {ranks ?? 'Unranked'}
          </span>
        </span>
      </span>
      <span className="flex items-baseline gap-1.5 tabular-nums">
        <span className="text-2xl leading-none font-semibold">{formatNumber(boss.score)}</span>
        <span className="text-xs text-muted-foreground">kills</span>
        {boss.gained > 0 ? (
          <GainBadge gained={boss.gained} className="ml-auto text-sm" />
        ) : (
          <span className="ml-auto text-xs text-muted-foreground">none in range</span>
        )}
      </span>
      {/* No loot in the range: no row of dashes, which keeps a phone's column of cards short. */}
      {showGp && boss.gp ? (
        <span className="grid grid-cols-2 gap-2 border-t pt-2 text-xs tabular-nums">
          <span className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Loot in range</span>
            <span className="font-medium">{formatGp(boss.gp)} gp</span>
          </span>
          <span className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Per kill</span>
            <span className="font-medium">
              {perKill === null ? '—' : `${formatGp(perKill)} gp`}
            </span>
          </span>
        </span>
      ) : null}
    </Link>
  );
}
