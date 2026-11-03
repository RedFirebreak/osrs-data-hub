/**
 * "Slayer" on the character page and Home (D-141): the task the player is on and how far it is, as
 * the card's headline, then three tiles: slayer points, the task streak (as the plugin last sent them,
 * `activity`) and the tasks finished in the last 7 days (from the slayer_task_complete events,
 * `events`; a dash without it). The finished tasks themselves are listed in the deep dive. Renders
 * nothing until the plugin has sent slayer data once. Async server component; the page streams it
 * behind a skeleton.
 */
import {
  DAY_MS,
  formatNumber,
  mainSlayerStreak,
  slayerKillsDone,
  slayerProgress,
  slayerStreakLabel,
  type SlayerState,
  type SlayerTask,
  type Viewer,
} from '@hub/core';
import { getDb } from '@hub/db';
import { listFeed } from '@hub/server';
import type { Route } from 'next';
import Link from 'next/link';
import { SkillIcon } from '@/components/icons/osrs-icon';
import { SectionCard } from '@/components/common/section-card';
import { skillTint } from '@/lib/skill-colors';
import { deepDiveHref } from '@/lib/routes';
import { Tile } from './slayer-task-list';
import { slayerTasksSince } from './slayer-tasks';

/** Days counted in "Done in 7 days". */
const SLAYER_WEEK_DAYS = 7;
/** Completed tasks read: enough for a busy week. */
const SLAYER_EVENTS = 100;

export interface SlayerCardProps {
  publicId: string;
  viewer: Viewer;
  slayer: SlayerState;
  /** When the plugin last sent it (ISO). */
  updatedAt: string;
  /** The viewer may read the account's events: the week's finished tasks, and the deep dive's list. */
  withEvents: boolean;
  now: Date;
}

export async function SlayerCard({
  publicId,
  viewer,
  slayer,
  updatedAt,
  withEvents,
  now,
}: SlayerCardProps) {
  /** Tasks finished in the last 7 days; null without `events`. */
  let week: number | null = null;
  if (withEvents) {
    const events = await listFeed(getDb().db, viewer, {
      accountPublicId: publicId,
      types: ['slayer_task_complete'],
      limit: SLAYER_EVENTS,
    });
    week = slayerTasksSince(events, new Date(now.getTime() - SLAYER_WEEK_DAYS * DAY_MS)).length;
  }
  const streak = mainSlayerStreak(slayer);
  const otherStreaks = (['normal', 'wilderness', 'mortimer'] as const)
    .filter((s) => s !== streak?.streak && (slayer.streaks[s] ?? 0) > 0)
    .map((s) => `${capitalize(slayerStreakLabel(s))} ${formatNumber(slayer.streaks[s] ?? 0)}`);

  return (
    <SectionCard
      id="slayer"
      title="Slayer"
      updatedAt={updatedAt}
      now={now.toISOString()}
      action={
        withEvents ? (
          <Link
            href={`${deepDiveHref(publicId)}#slayer` as Route}
            className="text-sm font-medium underline-offset-4 hover:underline focus-visible:underline"
          >
            Deep dive
          </Link>
        ) : undefined
      }
    >
      <div className="skill-tint flex flex-col gap-4" style={skillTint('Slayer')}>
        <TaskBlock task={slayer.task} />
        <ul className="grid grid-cols-3 gap-2" aria-label="Slayer numbers">
          <Tile label="Points" value={formatNumber(slayer.points)} />
          <Tile
            label={streak === null ? 'Streak' : capitalize(slayerStreakLabel(streak.streak))}
            value={streak === null ? '–' : formatNumber(streak.value)}
          />
          <Tile label="Done in 7 days" value={week === null ? '–' : formatNumber(week)} />
        </ul>
        {otherStreaks.length > 0 && (
          <p className="text-sm text-muted-foreground">{otherStreaks.join(' · ')}</p>
        )}
      </div>
    </SectionCard>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ProgressBar({ task }: { task: SlayerTask }) {
  const done = slayerKillsDone(task);
  return (
    <div
      role="meter"
      aria-label="Task progress"
      aria-valuemin={0}
      aria-valuemax={task.amount}
      aria-valuenow={done}
      aria-valuetext={`${done} of ${task.amount} killed, ${task.remaining} left`}
      className="h-2 overflow-hidden rounded-full bg-foreground/10"
    >
      <div
        className="h-full rounded-full bg-(--skill)"
        style={{ width: `${Math.round(slayerProgress(task) * 100)}%` }}
      />
    </div>
  );
}

/** The task as the card's headline, with its bar and the kills. */
function TaskBlock({ task }: { task: SlayerTask | null }) {
  if (task === null) {
    return (
      <div className="flex items-center gap-3">
        <SkillIcon skill="Slayer" className="size-7" holdSpace />
        <p className="text-sm text-muted-foreground">No slayer task right now.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-3">
        <SkillIcon skill="Slayer" className="mt-0.5 size-7" holdSpace />
        <div className="min-w-0">
          <p className="text-xl leading-tight font-semibold tracking-tight">
            {task.name ?? 'Unknown task'}
          </p>
          {task.location !== null && (
            <p className="text-sm text-muted-foreground">in {task.location}</p>
          )}
        </div>
      </div>
      <ProgressBar task={task} />
      <p className="flex justify-between gap-2 text-sm tabular-nums">
        <span>
          <span className="font-semibold">{formatNumber(task.remaining)}</span>
          <span className="text-muted-foreground"> left</span>
        </span>
        <span className="text-muted-foreground">
          {formatNumber(slayerKillsDone(task))} of {formatNumber(task.amount)} killed
        </span>
      </p>
    </div>
  );
}
