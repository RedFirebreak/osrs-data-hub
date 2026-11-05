'use client';
/**
 * The player's status (D-143): run energy, special attack, poison or venom, the wilderness level and
 * the effects that are running (potions, an imbued heart, a teleblock), each counting down to its end
 * on the viewer's clock. In "Right now" (Red's pick): run and special as full-width bars under HP and
 * prayer, poison and the wilderness as badges, and the effects as icon cards with the time left, the
 * name and the end time in a tooltip. What has ended drops out here at once; the page's minute refresh
 * brings the rest. Client component: only the countdown and the tooltips need it.
 */
import { STATUS_EFFECT_ITEMS, formatEffectLeft, type StatusState } from '@hub/core';
import { FootprintsIcon, SkullIcon, SwordsIcon, TimerIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ItemIcon } from '@/components/icons/osrs-icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** The viewer's clock, a tick a second while an effect counts down. */
function useNow(initial: number, ticking: boolean): number {
  const [now, setNow] = useState(initial);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** An effect's picture: its 4-dose potion, or a timer for the spells (no item). */
function EffectIcon({ id, className }: { id: string; className?: string }) {
  const item = STATUS_EFFECT_ITEMS[id];
  const fallback = (
    <TimerIcon aria-hidden className={cn('size-5 text-muted-foreground', className)} />
  );
  return item === undefined ? (
    fallback
  ) : (
    <ItemIcon itemId={item} className={cn('h-6 w-7', className)} fallback={fallback} />
  );
}

/** "Venom, next hit 8" as a small red or green badge; nothing without poison. */
export function PoisonBadge({ poison }: { poison: StatusState['poison'] }) {
  if (poison.type === 'none') return null;
  const venom = poison.type === 'venom';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        venom
          ? 'bg-teal-900/10 text-teal-800 dark:bg-teal-400/15 dark:text-teal-300'
          : 'bg-green-700/10 text-green-800 dark:bg-green-400/15 dark:text-green-300',
      )}
    >
      {venom ? 'Venomed' : 'Poisoned'}
      {poison.damage !== null && <span className="tabular-nums opacity-80">· {poison.damage}</span>}
    </span>
  );
}

/** "Wilderness 23" as a small badge; nothing outside it. */
export function WildernessBadge({ level }: { level: number | null }) {
  if (level === null) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-700/10 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-400/15 dark:text-red-300">
      <SkullIcon aria-hidden className="size-3.5" />
      Wilderness level {level}
    </span>
  );
}

/** A bar like HP and prayer's: label with icon, the percent, and the bar under it. */
function PercentMeter({
  label,
  icon,
  value,
  note,
  tone,
}: {
  label: string;
  icon: React.ReactNode;
  value: number;
  note?: string;
  tone: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="flex items-center gap-1.5 font-medium">
          {icon}
          {label}
        </span>
        <span className="tabular-nums">
          {note && <span className="mr-1.5 text-xs text-muted-foreground">{note}</span>}
          <span className="font-semibold">{value}</span>
          <span className="text-muted-foreground"> %</span>
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={`${value}%${note ? `, ${note}` : ''}`}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

/** Under HP and prayer: run energy and special attack, then poison and the wilderness as badges. */
export function StatusMeters({ status }: { status: StatusState }) {
  const badges = status.poison.type !== 'none' || status.wildernessLevel !== null;
  return (
    <>
      <PercentMeter
        label="Run energy"
        icon={<FootprintsIcon aria-hidden className="size-4 text-amber-600 dark:text-amber-400" />}
        value={status.runEnergy}
        note={status.running ? undefined : 'walking'}
        tone="bg-amber-500 dark:bg-amber-400"
      />
      <PercentMeter
        label="Special attack"
        icon={<SwordsIcon aria-hidden className="size-4 text-cyan-700 dark:text-cyan-400" />}
        value={status.specialAttack}
        tone="bg-cyan-600 dark:bg-cyan-500"
      />
      {badges && (
        <div className="flex flex-wrap gap-1.5">
          <PoisonBadge poison={status.poison} />
          <WildernessBadge level={status.wildernessLevel} />
        </div>
      )}
    </>
  );
}

/** How coarse an end time is, as words: "to the tick", "to within 6 s". */
function precisionLabel(ms: number): string {
  return ms <= 600 ? 'to the tick' : `to within ${Math.round(ms / 1000)} seconds`;
}

/**
 * The running effects as icon cards: the picture with the time left under it, like RuneLite's buff
 * boxes. Hover (or focus) shows the name, the clock time it ends and how exact that is. "None" when
 * nothing runs.
 */
export function StatusEffects({ status, renderedAt }: { status: StatusState; renderedAt: number }) {
  const now = useNow(renderedAt, status.effects.length > 0);
  const running = status.effects.filter((e) => e.endsAt > now);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm text-muted-foreground">Effects</span>
      {running.length === 0 ? (
        <span className="text-sm text-muted-foreground">None</span>
      ) : (
        <ul className="flex flex-wrap gap-2" aria-label="Effects">
          {running.map((e) => {
            const ends = new Date(e.endsAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            });
            const left = formatEffectLeft(e.endsAt, now);
            return (
              <li key={e.id}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      tabIndex={0}
                      className="flex w-15 cursor-help flex-col items-center gap-1 rounded-lg border bg-muted/40 px-1 py-1.5 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      <EffectIcon id={e.id} className="h-8 w-9" />
                      <span className="text-xs font-semibold tabular-nums">{left}</span>
                      <span className="sr-only">
                        {e.name}, {left} left, ends {ends}
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <span className="flex flex-col gap-0.5">
                      <span className="font-semibold">{e.name}</span>
                      <span>
                        {left} left, ends {ends}
                      </span>
                      <span className="opacity-70">Exact {precisionLabel(e.precision)}</span>
                    </span>
                  </TooltipContent>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
