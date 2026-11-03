/**
 * The deep dive's "Slayer tasks" (D-141): finished slayer tasks, newest first, with their totals,
 * from the slayer_task_complete events. Server component; the times are in the viewer's zone.
 */
import { formatNumber, slayerStreakLabel } from '@hub/core';
import { SkillIcon } from '@/components/icons/osrs-icon';
import { MOMENT_OPTIONS } from '@/components/charts/options';
import { formatInZone } from '@/lib/dates';
import { slayerTaskTotals, type DoneSlayerTask } from './slayer-tasks';

export function SlayerTaskList({
  tasks,
  timezone,
}: {
  tasks: readonly DoneSlayerTask[];
  timezone: string;
}) {
  const totals = slayerTaskTotals(tasks);
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-6">
      <ul className="grid grid-cols-3 gap-2 lg:grid-cols-1" aria-label="Slayer totals">
        <Tile label="Tasks" value={formatNumber(totals.tasks)} />
        <Tile label="Kills" value={formatNumber(totals.kills)} />
        <Tile label="Points earned" value={formatNumber(totals.points)} />
      </ul>
      <ul className="flex flex-col divide-y text-sm lg:-mt-2">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-center gap-3 py-2">
            <SkillIcon skill="Slayer" holdSpace />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">
                {t.amount !== null && (
                  <span className="tabular-nums">{formatNumber(t.amount)} </span>
                )}
                {t.task ?? 'A task'}
                {t.location !== null && (
                  <span className="font-normal text-muted-foreground"> in {t.location}</span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatInZone(t.at, timezone, MOMENT_OPTIONS)}
                {t.streak !== null &&
                  ` · ${slayerStreakLabel(t.streakType ?? 'normal')} ${formatNumber(t.streak)}`}
              </p>
            </div>
            {t.points !== null && t.points > 0 && (
              <span className="shrink-0 tabular-nums">+{formatNumber(t.points)} pts</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A number with its label, as the slayer card's tiles. */
export function Tile({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex flex-col gap-0.5 rounded-lg border bg-muted/50 px-2.5 py-2">
      <span className="text-lg leading-tight font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </li>
  );
}
