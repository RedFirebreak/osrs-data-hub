'use client';
/**
 * Goals on the Metrics tab (D-109): a target level or XP in a skill, or a kill count, each with its
 * progress and an ETA at the pace of the range being looked at. The owner adds and removes them
 * (POST/DELETE /api/app/accounts/[publicId]/goals); everyone else who may see the category a goal is
 * about sees it, read-only.
 */
import { MAX_VIRTUAL_LEVEL, formatGp, formatNumber } from '@hub/core';
import type { GoalKind, GoalView } from '@hub/server';
import { TrashIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { NativeSelect } from '@/components/common/native-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useApiRequest } from '@/lib/use-api-request';
import { formatEtaDays } from './format';

const KIND_LABELS: Readonly<Record<GoalKind, string>> = {
  level: 'Level',
  xp: 'XP',
  kc: 'Kill count',
};

export interface GoalsPanelProps {
  publicId: string;
  goals: readonly GoalView[];
  canSet: boolean;
  /** Skills a level or XP goal may name; empty without `stats`. */
  skills: readonly string[];
  /** Bosses a kill-count goal may name; empty without `hiscores`. */
  bosses: readonly string[];
}

/** "Level 99 Attack", "50M Fishing XP", "500 Zulrah kills". */
export function goalTitle(goal: Pick<GoalView, 'kind' | 'target' | 'value'>): string {
  switch (goal.kind) {
    case 'level':
      return `Level ${goal.value} ${goal.target}`;
    case 'xp':
      return `${formatGp(goal.value)} ${goal.target} XP`;
    case 'kc':
      return `${formatNumber(goal.value)} ${goal.target} kills`;
  }
}

/** Where the goal stands: "Level 87 · 1.2M XP to go", "412 of 500 kills". */
export function goalStatus(goal: GoalView): string {
  if (goal.current === null) {
    return goal.kind === 'kc' ? 'Not on the hiscores yet' : 'Not known yet';
  }
  if (goal.remaining === 0) return 'Reached';
  switch (goal.kind) {
    case 'level':
      return `Level ${goal.current} · ${formatGp(goal.remaining)} XP to go`;
    case 'xp':
      return `${formatGp(goal.current)} XP · ${formatGp(goal.remaining)} to go`;
    case 'kc':
      return `${formatNumber(goal.current)} of ${formatNumber(goal.value)} kills`;
  }
}

/** "ETA 12 days at 85K XP a day", "No pace in this range". */
export function goalEta(goal: GoalView): string {
  if (goal.remaining === 0) return '';
  if (goal.etaDays === null || goal.perDay === null || goal.perDay <= 0) {
    return 'No progress in this range to set a pace';
  }
  const pace =
    goal.kind === 'kc' ? `${formatNumber(goal.perDay)} kills` : `${formatGp(goal.perDay)} XP`;
  return `ETA ${formatEtaDays(goal.etaDays)} at ${pace} a day`;
}

export function GoalsPanel({ publicId, goals, canSet, skills, bosses }: GoalsPanelProps) {
  const router = useRouter();
  const request = useApiRequest();
  const id = useId();
  const kinds = (['level', 'xp', 'kc'] as const).filter((k) =>
    k === 'kc' ? bosses.length > 0 : skills.length > 0,
  );
  const [kind, setKind] = useState<GoalKind>(kinds[0] ?? 'level');
  const targets = kind === 'kc' ? bosses : skills;
  const [target, setTarget] = useState(targets[0] ?? '');
  const [value, setValue] = useState('');

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(value.replace(/[,\s_]/g, ''));
    if (!Number.isInteger(n) || n < 1) {
      request.setError('Enter a whole number above 0.');
      return;
    }
    const result = await request.send(
      `/api/app/accounts/${publicId}/goals`,
      { method: 'POST', json: { kind, target, value: n } },
      "Couldn't save the goal.",
    );
    if (result.ok) {
      setValue('');
      router.refresh();
    }
  }

  async function remove(goalId: string) {
    const result = await request.send(
      `/api/app/accounts/${publicId}/goals/${goalId}`,
      { method: 'DELETE' },
      "Couldn't remove the goal.",
    );
    if (result.ok) router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {goals.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {canSet
            ? 'No goals yet. Set a level, XP or kill count to aim for and see when you get there at your pace.'
            : 'No goals set for this account.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {goals.map((goal) => (
            <li key={goal.id} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="font-medium">{goalTitle(goal)}</span>
                {canSet && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove the goal ${goalTitle(goal)}`}
                    disabled={request.pending}
                    onClick={() => void remove(goal.id)}
                  >
                    <TrashIcon />
                  </Button>
                )}
              </div>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-muted"
                role="img"
                aria-label={`${Math.floor((goal.progress ?? 0) * 100)}% of the goal`}
              >
                <div
                  className="h-full rounded-full bg-foreground"
                  style={{ width: `${(goal.progress ?? 0) * 100}%` }}
                />
              </div>
              <div className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground tabular-nums">
                <span>{goalStatus(goal)}</span>
                <span>{goalEta(goal)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {canSet && kinds.length > 0 && (
        <form onSubmit={(e) => void add(e)} className="flex flex-wrap items-end gap-2 text-sm">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-kind`} className="text-xs text-muted-foreground">
              Goal
            </label>
            <NativeSelect
              id={`${id}-kind`}
              value={kind}
              onChange={(e) => {
                const next = e.target.value as GoalKind;
                setKind(next);
                setTarget((next === 'kc' ? bosses : skills)[0] ?? '');
              }}
              className="h-8 w-auto"
            >
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-target`} className="text-xs text-muted-foreground">
              {kind === 'kc' ? 'Boss' : 'Skill'}
            </label>
            <NativeSelect
              id={`${id}-target`}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="h-8 w-auto max-w-48"
            >
              {targets.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-value`} className="text-xs text-muted-foreground">
              {kind === 'level' ? `Level (2–${MAX_VIRTUAL_LEVEL})` : kind === 'xp' ? 'XP' : 'Kills'}
            </label>
            <Input
              id={`${id}-value`}
              inputMode="numeric"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={kind === 'level' ? '99' : kind === 'xp' ? '13,034,431' : '500'}
              className="w-32"
              required
            />
          </div>
          <Button type="submit" disabled={request.pending || !target}>
            Set goal
          </Button>
        </form>
      )}
      {request.error && (
        <p role="alert" className="text-sm text-destructive">
          {request.error}
        </p>
      )}
    </div>
  );
}
