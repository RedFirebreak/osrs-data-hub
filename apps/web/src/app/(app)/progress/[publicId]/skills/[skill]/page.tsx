/**
 * One skill of a character: where it stands (level, the way to the next one) and how it grew, as
 * one line in the skill's own colour over a range in the address (1D … 1Y, and "All": the hub keeps
 * daily XP forever). Under it the pace (XP an hour while training, play time to the next level), the
 * level-ups of the range and the skill's goal. The other skills are one press away in the strip.
 *
 * `skill` is the skill's name in lower case ("firemaking"). The checks that answer 404 (account
 * visible, `stats` readable, the name a skill) run before anything streams (NEXT-14).
 */
import {
  KNOWN_SKILLS,
  MAX_REAL_LEVEL,
  OVERALL,
  formatGp,
  formatNumber,
  getConfig,
  type Viewer,
} from '@hub/core';
import { getDb } from '@hub/db';
import {
  getAccountMetrics,
  getUserSettings,
  getXpSeries,
  listFeed,
  type AccountMetrics,
  type SkillMetrics,
} from '@hub/server';
import { ChevronLeftIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { CardSkeleton } from '@/components/common/card-skeleton';
import { SectionCard } from '@/components/common/section-card';
import { SkillIcon } from '@/components/icons/osrs-icon';
import { formatEtaMs, formatMs } from '@/components/metrics/format';
import { GoalsPanel } from '@/components/metrics/goals-panel';
import { ProgressHeadline } from '@/components/progress/headline';
import { levelsGained } from '@/components/progress/levels';
import { ProgressChart } from '@/components/progress/progress-chart';
import { ProgressQueryProvider } from '@/components/progress/progress-nav';
import { RangeControl } from '@/components/progress/range-control';
import { SkillStrip } from '@/components/progress/skill-strip';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DATE_TIME_OPTIONS, formatInZone } from '@/lib/dates';
import {
  PROGRESS_RANGES,
  PROGRESS_RANGE_WORDS,
  parseProgressQuery,
  progressMetricsQuery,
  progressSearch,
  type ProgressQuery,
  type ProgressRange,
} from '@/lib/progress';
import { progressHref } from '@/lib/routes';
import { requireUser } from '@/lib/session';
import { skillTint } from '@/lib/skill-colors';
import { loadVisible } from '@/lib/visible-account';

/** A skill page offers every range, and all of the skill's history. */
const SKILL_RANGES: readonly ProgressRange[] = [...PROGRESS_RANGES, 'all'];
/** Level-ups listed. */
const MILESTONES_SHOWN = 8;

/** The skill a route segment names ("firemaking" → "Firemaking"), or null when it is none. */
function skillName(raw: string): string | null {
  let slug = raw;
  try {
    slug = decodeURIComponent(raw);
  } catch {
    return null;
  }
  slug = slug.trim().toLowerCase();
  return KNOWN_SKILLS.find((skill) => skill.toLowerCase() === slug) ?? null;
}

export async function generateMetadata({
  params,
}: PageProps<'/progress/[publicId]/skills/[skill]'>): Promise<Metadata> {
  const { publicId, skill } = await params;
  const visible = await loadVisible(publicId);
  const name = skillName(skill) ?? 'Skill';
  return { title: `${name} · ${visible?.account.name ?? 'Account'} · ${getConfig().hubName}` };
}

export default async function SkillPage({
  params,
  searchParams,
}: PageProps<'/progress/[publicId]/skills/[skill]'>) {
  const { publicId, skill: raw } = await params;
  // See NEXT-14: every 404 before the Suspense boundary.
  const visible = await loadVisible(publicId);
  const skill = skillName(raw);
  if (!visible || !skill || !visible.access.categories.has('stats')) notFound();
  // XP is the only measure of a skill; a `measure` in the address is ignored.
  const query: ProgressQuery = {
    ...parseProgressQuery(await searchParams, { all: true }),
    measure: 'xp',
  };
  return (
    <div className="flex flex-col gap-6">
      <Link
        href={progressHref(publicId, progressSearch({ ...query, range: summaryRange(query) }))}
        className="-mb-3 flex w-fit items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <ChevronLeftIcon aria-hidden className="size-4" />
        Progress of {visible.account.name}
      </Link>
      <ProgressQueryProvider query={query}>
        <Suspense fallback={<SkillSkeleton />}>
          <SkillContent publicId={publicId} skill={skill} query={query} />
        </Suspense>
      </ProgressQueryProvider>
    </div>
  );
}

/** The range the summary opens on from here: its own ranges, and a year for "All". */
function summaryRange(query: ProgressQuery): ProgressRange {
  return query.range === 'all' ? '1y' : query.range;
}

interface Line {
  points: [number, number][];
  from: string;
  to: string;
}

/**
 * All of a skill's XP since the hub first saw the character, as a running gain: the stored series
 * (change-only, so the line is carried on to now), measured from its first value.
 */
async function allTimeLine(
  viewer: Viewer,
  publicId: string,
  skill: string,
  row: SkillMetrics,
  firstSeen: string,
  now: Date,
): Promise<Line | null> {
  const series = await getXpSeries(getDb().db, viewer, publicId, {
    skills: [skill],
    from: new Date(firstSeen),
    to: now,
    resolution: 'auto',
  });
  const stored = series?.series[0]?.points ?? [];
  const first = stored[0];
  if (!first) return null;
  // A bucket can start a little before the character was first seen: the line starts there.
  const start = Math.min(Date.parse(firstSeen), Date.parse(first[0]));
  const base = first[1];
  const points = stored.map(([at, xp]): [number, number] => [Date.parse(at) - start, xp - base]);
  points.push([now.getTime() - start, Math.max(points.at(-1)?.[1] ?? 0, row.xp - base)]);
  return { points, from: new Date(start).toISOString(), to: now.toISOString() };
}

async function SkillContent({
  publicId,
  skill,
  query,
}: {
  publicId: string;
  skill: string;
  query: ProgressQuery;
}) {
  const { user, viewer } = await requireUser();
  const { db } = getDb();
  const { timezone } = await getUserSettings(db, user.id);
  const now = new Date();
  const m = await getAccountMetrics(db, viewer, publicId, progressMetricsQuery(query, now, skill), {
    now,
    timezone,
    fineSteps: true,
  });
  const row = m?.skills?.find((s) => s.skill === skill);
  // The character has no such skill yet (a skill newer than its last login).
  if (!m || !row) notFound();

  const all = query.range === 'all';
  const line: Line | null = all
    ? await allTimeLine(viewer, publicId, skill, row, m.account.firstSeen, now)
    : m.comparison && {
        points: m.comparison.current,
        from: m.range.from,
        to: m.range.to,
      };
  // The chart's own last value, so the headline and the line always agree.
  const gained = line?.points.at(-1)?.[1] ?? 0;
  const words = PROGRESS_RANGE_WORDS[query.range];
  const skills = m.options.skills.filter((s) => s !== OVERALL);

  return (
    <>
      <SkillStrip
        publicId={publicId}
        skills={skills}
        current={skill}
        search={progressSearch(query)}
      />
      <SkillHeader row={row} character={m.account.name} />
      <Card aria-labelledby="answer-heading" role="region">
        <CardContent className="flex flex-col gap-4">
          <h2 id="answer-heading" className="sr-only">
            {skill} XP {words}
          </h2>
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <div className="skill-tint flex min-w-0 flex-col gap-2" style={skillTint(skill)}>
              <ProgressHeadline value={gained} measure="xp" className="text-(--skill)" />
              <p className="text-sm text-muted-foreground">{words}</p>
            </div>
            <RangeControl ranges={SKILL_RANGES} />
          </div>
          {line ? (
            <ProgressChart
              points={line.points}
              from={line.from}
              to={line.to}
              measure="xp"
              skill={skill}
              name={`${skill} XP`}
              label={`${skill} XP adding up ${words}`}
              timezone={timezone}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              No XP history for {skill} yet. It builds up from the next session on.
            </p>
          )}
        </CardContent>
      </Card>
      <Facts row={row} gained={gained} all={all} />
      <div className="grid items-start gap-6 lg:grid-cols-3">
        {m.access.events && (
          <SectionCard
            id="milestones"
            title="Milestones"
            description={`Level-ups ${words}.`}
            className="lg:col-span-2"
          >
            <Suspense fallback={<Skeleton className="h-16 w-full" />}>
              <Milestones
                viewer={viewer}
                publicId={publicId}
                skill={skill}
                since={line?.from ?? m.range.from}
                timezone={timezone}
              />
            </Suspense>
          </SectionCard>
        )}
        <SectionCard
          id="goals"
          title="Goal"
          description={`A level or an amount of ${skill} XP to aim for.`}
        >
          <SkillGoals m={m} publicId={publicId} skill={skill} />
        </SectionCard>
      </div>
    </>
  );
}

function SkillHeader({ row, character }: { row: SkillMetrics; character: string }) {
  const level = Math.min(row.level, MAX_REAL_LEVEL);
  return (
    <header className="skill-tint flex flex-col gap-4" style={skillTint(row.skill)}>
      <div className="flex items-center gap-4">
        {/* The same plain tile as the strip's icons: a black sprite needs a lighter ground. */}
        <span className="grid size-16 shrink-0 place-items-center rounded-xl bg-muted dark:bg-neutral-600">
          <SkillIcon
            skill={row.skill}
            holdSpace
            className="size-11 object-contain [image-rendering:pixelated]"
          />
        </span>
        <div className="min-w-0">
          <h1 className="text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">
            {row.skill}
          </h1>
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>
              Level <span className="font-medium text-foreground tabular-nums">{level}</span>
              {row.level > MAX_REAL_LEVEL && (
                <span title={`Virtual level ${row.level}`}> ({row.level} virtual)</span>
              )}
            </span>
            <span className="tabular-nums">{formatNumber(row.xp)} XP</span>
            <span>{character}</span>
          </p>
        </div>
      </div>
      <div className="max-w-xl">
        <div
          role="img"
          aria-label={
            row.nextLevelXp === null
              ? 'At 200M XP'
              : `${Math.floor(row.progress * 100)}% of the way to level ${row.level + 1}`
          }
          className="h-2 overflow-hidden rounded-full bg-foreground/10"
        >
          <div
            className="h-full rounded-full bg-(--skill)"
            style={{ width: `${Math.round(row.progress * 100)}%` }}
          />
        </div>
        <p className="mt-1.5 flex flex-wrap justify-between gap-x-4 text-xs text-muted-foreground tabular-nums">
          {row.nextLevelXp === null ? (
            <span>200M XP: nothing left to gain.</span>
          ) : (
            <>
              <span>
                {Math.floor(row.progress * 100)}% of the way to {row.level + 1}
              </span>
              <span>{formatNumber(row.nextLevelXp - row.xp)} XP to go</span>
            </>
          )}
        </p>
      </div>
    </header>
  );
}

/**
 * The pace of the range. The rate and what follows from it come from the play sessions, so they are
 * left out for a viewer who may not read them; "All" says how the skill grew, not how long it took
 * (sessions reach back a year at most).
 */
function Facts({ row, gained, all }: { row: SkillMetrics; gained: number; all: boolean }) {
  const rate = row.xpPerHour;
  const facts: { label: string; value: string }[] = [
    { label: 'levels gained', value: formatNumber(levelsGained(row.xp, gained)) },
  ];
  if (rate !== null) {
    facts.push({ label: 'XP an hour while training', value: formatGp(rate) });
    if (row.nextLevelXp !== null) {
      facts.push({
        label: `of play to level ${row.level + 1} at this pace`,
        value: formatEtaMs(row.etaMs),
      });
    }
    if (!all && rate > 0) {
      facts.push({ label: 'spent training', value: formatMs((gained / rate) * 3_600_000) });
    }
  }
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {facts.map((fact) => (
        <div
          key={fact.label}
          // The value reads first; in the markup the term still comes before it.
          className="flex min-w-0 flex-col-reverse rounded-xl bg-card p-4 ring-1 ring-foreground/10"
        >
          <dt className="text-xs text-muted-foreground">{fact.label}</dt>
          <dd className="truncate text-xl font-semibold tabular-nums">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The skill's level-ups since `since`, newest first (the `events` category). */
async function Milestones({
  viewer,
  publicId,
  skill,
  since,
  timezone,
}: {
  viewer: Viewer;
  publicId: string;
  skill: string;
  since: string;
  timezone: string;
}) {
  const from = Date.parse(since);
  const levelUps = (
    await listFeed(getDb().db, viewer, {
      accountPublicId: publicId,
      types: ['level_up'],
      limit: 200,
    })
  ).filter((e) => e.skill === skill && e.level !== null && Date.parse(e.occurredAt) >= from);
  if (levelUps.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No level-up in {skill} in this range. A new level shows up here as it happens.
      </p>
    );
  }
  const more = levelUps.length - MILESTONES_SHOWN;
  return (
    <>
      <ol className="flex flex-col divide-y text-sm">
        {levelUps.slice(0, MILESTONES_SHOWN).map((e) => (
          <li key={e.id} className="flex items-center gap-3 py-2">
            <SkillIcon skill={skill} holdSpace />
            <span className="flex-1">
              Reached level <span className="font-medium tabular-nums">{e.level}</span>
            </span>
            <time dateTime={e.occurredAt} className="text-xs text-muted-foreground">
              {formatInZone(e.occurredAt, timezone, DATE_TIME_OPTIONS)}
            </time>
          </li>
        ))}
      </ol>
      {more > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          And {more} earlier {more === 1 ? 'level' : 'levels'} in this range.
        </p>
      )}
    </>
  );
}

/** The goals of this skill, and the form to set one (the owner). */
function SkillGoals({
  m,
  publicId,
  skill,
}: {
  m: AccountMetrics;
  publicId: string;
  skill: string;
}) {
  return (
    <GoalsPanel
      publicId={publicId}
      goals={m.goals.filter((goal) => goal.kind !== 'kc' && goal.target === skill)}
      canSet={m.canSetGoals}
      skills={[skill]}
      bosses={[]}
    />
  );
}

function SkillSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading the skill">
      <Skeleton className="h-10 w-full max-w-2xl" />
      <div className="flex items-center gap-4">
        <Skeleton className="size-12 rounded-lg" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>
      <div className="flex flex-col gap-4 rounded-xl p-4 ring-1 ring-foreground/10">
        <Skeleton className="h-12 w-72 max-w-full" />
        <Skeleton className="h-72 w-full rounded-lg" />
      </div>
      <CardSkeleton rows={3} />
    </div>
  );
}
