'use client';
/**
 * The player's status (D-143): run energy, special attack, poison or venom, the wilderness level and
 * the effects that are running (potions, an imbued heart, a teleblock), each counting down to its end
 * on the viewer's clock. In "Right now" (Red's pick): HP, prayer, run and special as the game's
 * minimap orbs, poison and the wilderness as badges, and the effects as icon cards with the time left,
 * the name and the end time in a tooltip. What has ended drops out here at once; the page's minute refresh
 * brings the rest. Client component: only the countdown and the tooltips need it.
 */
import { STATUS_EFFECT_ITEMS, formatEffectLeft, type StatusState } from '@hub/core';
import { SkullIcon, TimerIcon } from 'lucide-react';
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

/**
 * A round gauge like the game's minimap orbs: the value in the middle, the ring filled by its share
 * of the maximum (a boost over the maximum fills it).
 */
function Orb({
  label,
  value,
  max,
  tone,
  valueText,
}: {
  label: string;
  value: number;
  max: number;
  tone: string;
  valueText: string;
}) {
  const r = 20;
  const c = 2 * Math.PI * r;
  const share = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  return (
    <div className="flex flex-col items-center gap-1">
      <svg
        viewBox="0 0 48 48"
        className="size-14"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(value, max)}
        aria-valuetext={valueText}
      >
        <circle cx="24" cy="24" r={r} className="fill-none stroke-muted" strokeWidth="5" />
        <circle
          cx="24"
          cy="24"
          r={r}
          className={cn('fill-none transition-[stroke-dasharray]', tone)}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${c * share} ${c}`}
          transform="rotate(-90 24 24)"
        />
        <text
          x="24"
          y="28"
          textAnchor="middle"
          className="fill-foreground text-[12px] font-semibold tabular-nums"
        >
          {value}
        </text>
      </svg>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

type Meter = { current: number; max: number } | null;

/**
 * HP, prayer, run energy and special attack as four orbs, as on the game's minimap (Red's pick); the
 * HP orb turns green when poisoned and teal when venomed, as the game's does. Then poison and the
 * wilderness as badges.
 */
export function StatusOrbs({
  status,
  hp,
  prayer,
}: {
  status: StatusState;
  hp: Meter;
  prayer: Meter;
}) {
  const badges = status.poison.type !== 'none' || status.wildernessLevel !== null;
  const hpTone =
    status.poison.type === 'venom'
      ? 'stroke-teal-700 dark:stroke-teal-400'
      : status.poison.type === 'poison'
        ? 'stroke-green-600 dark:stroke-green-500'
        : 'stroke-red-600 dark:stroke-red-500';
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-4 gap-1">
        {hp && (
          <Orb
            label="Hitpoints"
            value={hp.current}
            max={hp.max}
            tone={hpTone}
            valueText={`${hp.current} of ${hp.max}`}
          />
        )}
        {prayer && (
          <Orb
            label="Prayer"
            value={prayer.current}
            max={prayer.max}
            tone="stroke-sky-600 dark:stroke-sky-500"
            valueText={`${prayer.current} of ${prayer.max}`}
          />
        )}
        <Orb
          label={status.running ? 'Run' : 'Walk'}
          value={status.runEnergy}
          max={100}
          tone="stroke-amber-500 dark:stroke-amber-400"
          valueText={`${status.runEnergy}%, ${status.running ? 'running' : 'walking'}`}
        />
        <Orb
          label="Special"
          value={status.specialAttack}
          max={100}
          tone="stroke-cyan-600 dark:stroke-cyan-500"
          valueText={`${status.specialAttack}%`}
        />
      </div>
      {badges && (
        <div className="flex flex-wrap justify-center gap-1.5">
          <PoisonBadge poison={status.poison} />
          <WildernessBadge level={status.wildernessLevel} />
        </div>
      )}
    </div>
  );
}

/**
 * A square card with a game icon and, when given, a line under it; the tooltip says the rest. Used
 * for the effects and the active prayers, so the two rows look alike (Red, 2026-11-05).
 */
export function IconCard({
  icon,
  caption,
  label,
  tooltip,
}: {
  icon: React.ReactNode;
  caption?: React.ReactNode;
  /** What a screen reader says for the card. */
  label: string;
  tooltip: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          tabIndex={0}
          aria-label={label}
          className="flex min-h-15 w-15 cursor-help flex-col items-center justify-center gap-1 rounded-lg border bg-muted/40 px-1 py-1.5 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {icon}
          {caption !== undefined && (
            <span className="text-xs font-semibold tabular-nums">{caption}</span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
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
      <span className="text-center text-sm text-muted-foreground">Effects</span>
      {running.length === 0 ? (
        <span className="text-center text-sm text-muted-foreground">None</span>
      ) : (
        <ul className="flex flex-wrap justify-center gap-2" aria-label="Effects">
          {running.map((e) => {
            const ends = new Date(e.endsAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            });
            const left = formatEffectLeft(e.endsAt, now);
            return (
              <li key={e.id}>
                <IconCard
                  icon={<EffectIcon id={e.id} className="h-8 w-9" />}
                  caption={left}
                  label={`${e.name}, ${left} left, ends ${ends}`}
                  tooltip={
                    <span className="flex flex-col gap-0.5">
                      <span className="font-semibold">{e.name}</span>
                      <span>
                        {left} left, ends {ends}
                      </span>
                      <span className="opacity-70">Exact {precisionLabel(e.precision)}</span>
                    </span>
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
