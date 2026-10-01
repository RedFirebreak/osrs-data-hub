'use client';
/**
 * Gains leaderboards (handoff §12 guild page): tabs for today / 7 days / 30 days and a skill selector
 * (Overall by default), each board the top accounts by XP gained whose stats the viewer may see.
 * "Today" starts at midnight in the viewer's time zone; special-world XP never counts.
 */
import { formatGain } from '@hub/core';
import type { Leaderboard, LeaderboardPeriod } from '@hub/server';
import { TrophyIcon } from 'lucide-react';
import { useState } from 'react';
import { SkillSelect, defaultSkill } from '@/components/account/skill-select';
import { AccountLink } from '@/components/accounts/account-link';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

export const PERIOD_LABELS: Readonly<Record<LeaderboardPeriod, string>> = {
  day: 'Today',
  week: '7 days',
  month: '30 days',
};

const PERIODS: readonly LeaderboardPeriod[] = ['day', 'week', 'month'];

export interface LeaderboardsProps {
  boards: Readonly<Record<LeaderboardPeriod, readonly Leaderboard[]>>;
  /** Skills to choose from, Overall first (the union of every period's boards). */
  skills: readonly string[];
}

export function Leaderboards({ boards, skills }: LeaderboardsProps) {
  const [skill, setSkill] = useState(() => defaultSkill(skills));
  const [period, setPeriod] = useState<LeaderboardPeriod>('day');

  return (
    <Tabs value={period} onValueChange={(v) => setPeriod(v as LeaderboardPeriod)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TabsList aria-label="Period">
          {PERIODS.map((p) => (
            <TabsTrigger key={p} value={p} className="px-3">
              {PERIOD_LABELS[p]}
            </TabsTrigger>
          ))}
        </TabsList>
        {skills.length > 0 && (
          <SkillSelect skills={skills} value={skill} onChange={setSkill} align="end" />
        )}
      </div>
      {PERIODS.map((p) => {
        const entries = boards[p].find((b) => b.skill === skill)?.entries ?? [];
        return (
          <TabsContent key={p} value={p} className="pt-2">
            {entries.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nobody has gained {skill || 'any'} XP{' '}
                {p === 'day' ? 'today' : `in the last ${PERIOD_LABELS[p]}`} yet.
              </p>
            ) : (
              <ol
                aria-label={`${skill} XP gained, ${PERIOD_LABELS[p].toLowerCase()}`}
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
                    <span className="shrink-0 font-medium text-emerald-700 tabular-nums dark:text-emerald-400">
                      {formatGain(e.gain)} XP
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
