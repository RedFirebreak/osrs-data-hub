'use client';
/**
 * Guild boss leaderboards (D-110): kills gained per boss over 7 or 30 days, among the accounts whose
 * hiscores the viewer may read; the boss with the most kills overall is picked first. A first
 * hiscores reading (and the first after a rename) is a starting point, never a gain, so nobody's
 * lifetime kill count lands in one week.
 */
import { formatNumber } from '@hub/core';
import type { BossLeaderboard, BossLeaderboardPeriod } from '@hub/server';
import { TrophyIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { AccountLink } from '@/components/accounts/account-link';
import { NativeSelect } from '@/components/common/native-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { PERIOD_LABELS } from './leaderboards';

const PERIODS: readonly BossLeaderboardPeriod[] = ['week', 'month'];

export interface BossLeaderboardsProps {
  boards: Readonly<Record<BossLeaderboardPeriod, readonly BossLeaderboard[]>>;
}

/** Every boss on either period's boards, the month's order first (most kills overall). */
export function bossOptions(boards: BossLeaderboardsProps['boards']): string[] {
  return [...new Set([...boards.month, ...boards.week].map((b) => b.activity))];
}

export function BossLeaderboards({ boards }: BossLeaderboardsProps) {
  const id = useId();
  const bosses = bossOptions(boards);
  const [period, setPeriod] = useState<BossLeaderboardPeriod>('week');
  const [boss, setBoss] = useState(() => boards.week[0]?.activity ?? bosses[0] ?? '');

  return (
    <Tabs value={period} onValueChange={(v) => setPeriod(v as BossLeaderboardPeriod)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TabsList aria-label="Period">
          {PERIODS.map((p) => (
            <TabsTrigger key={p} value={p} className="px-3">
              {PERIOD_LABELS[p]}
            </TabsTrigger>
          ))}
        </TabsList>
        <div>
          <label htmlFor={`${id}-boss`} className="sr-only">
            Boss
          </label>
          <NativeSelect
            id={`${id}-boss`}
            value={boss}
            onChange={(e) => setBoss(e.target.value)}
            className="h-7 w-auto max-w-56"
          >
            {bosses.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {PERIODS.map((p) => {
        const entries = boards[p].find((b) => b.activity === boss)?.entries ?? [];
        return (
          <TabsContent key={p} value={p} className="pt-2">
            {entries.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nobody has gained {boss} kills in the last {PERIOD_LABELS[p]}.
              </p>
            ) : (
              <ol
                aria-label={`${boss} kills gained, ${PERIOD_LABELS[p].toLowerCase()}`}
                className="flex flex-col divide-y"
              >
                {entries.map((e, i) => (
                  <li key={e.publicId} className="flex items-center gap-3 py-2 text-sm">
                    <span
                      className={cn(
                        'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums',
                        i === 0
                          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {i === 0 ? (
                        <TrophyIcon role="img" aria-label="1st" className="size-3.5" />
                      ) : (
                        i + 1
                      )}
                    </span>
                    <AccountLink
                      publicId={e.publicId}
                      name={e.name}
                      className="min-w-0 flex-1 truncate"
                    />
                    <span className="shrink-0 font-medium tabular-nums">
                      +{formatNumber(e.kills)} {e.kills === 1 ? 'kill' : 'kills'}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </TabsContent>
        );
      })}
    </Tabs>
  );
}
