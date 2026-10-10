/**
 * "This week" on the character page: the last 7 days in one glance (XP gained with the shape of the
 * week, levels, time played, loot, the most trained skills) and the way into Progress, where the
 * rest of the history lives. Read from the Progress read model (getAccountMetrics), so each number
 * follows its own sharing category and is left out without it. Renders nothing when the viewer may
 * read none of it. Async server component: the page streams it behind a skeleton.
 */
import { DEFAULT_METRICS_QUERY, formatGp, formatNumber, type Viewer } from '@hub/core';
import { getDb } from '@hub/db';
import { getAccountMetrics } from '@hub/server';
import Link from 'next/link';
import { Sparkline } from '@/components/charts/sparkline';
import { SectionCard } from '@/components/common/section-card';
import { Stat } from '@/components/common/stat';
import { formatMs } from '@/components/metrics/format';
import { totalLevelsGained } from '@/components/progress/levels';
import { TrainedSkills, mostTrained } from '@/components/progress/trained-skills';
import { progressHref } from '@/lib/routes';

/** Skills listed under the numbers. */
const WEEK_SKILLS = 4;

export interface WeekSummaryProps {
  publicId: string;
  viewer: Viewer;
  now: Date;
  timezone: string;
}

export async function WeekSummary({ publicId, viewer, now, timezone }: WeekSummaryProps) {
  const m = await getAccountMetrics(
    getDb().db,
    viewer,
    publicId,
    { ...DEFAULT_METRICS_QUERY, range: '7d' },
    { now, timezone },
  );
  if (!m || !(m.access.stats || m.access.events || m.access.sessions)) return null;
  const { totals } = m;
  const skills = m.skills ?? [];
  const trained = mostTrained(skills, WEEK_SKILLS);
  return (
    <SectionCard
      id="week"
      title="This week"
      action={
        <Link
          href={progressHref(publicId)}
          className="text-sm font-medium underline-offset-4 hover:underline focus-visible:underline"
        >
          See progress
        </Link>
      }
    >
      <div className="flex flex-col gap-4">
        {totals.xp !== null && (
          <div>
            <p
              className="text-3xl leading-tight font-semibold tracking-tight tabular-nums"
              title={`${formatNumber(totals.xp)} XP`}
            >
              +{formatGp(totals.xp)} XP
            </p>
            {totals.xp > 0 && m.comparison ? (
              <Sparkline points={m.comparison.current} className="mt-2 h-10" />
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                No XP in the last 7 days. It shows up here after the next session.
              </p>
            )}
          </div>
        )}
        <dl className="grid grid-cols-3 gap-3">
          {m.skills && <Stat label="Levels" value={formatNumber(totalLevelsGained(skills))} />}
          {totals.sessions && <Stat label="Played" value={formatMs(totals.sessions.onlineMs)} />}
          {totals.gp !== null && <Stat label="Loot" value={`${formatGp(totals.gp)} gp`} truncate />}
        </dl>
        {trained.length > 0 && (
          <TrainedSkills publicId={publicId} skills={trained} period="in the last 7 days" />
        )}
      </div>
    </SectionCard>
  );
}
