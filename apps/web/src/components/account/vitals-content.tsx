/**
 * HP, prayer and spellbook (the `activity` category). Boosted values above the maximum (brews,
 * boosts) draw a full bar and say how far over they are. Server component.
 */
import type { Vitals } from '@hub/server';
import { HeartIcon, SparklesIcon } from 'lucide-react';
import { meterFill, spellbookLabel } from './items';

function Meter({
  label,
  icon,
  current,
  max,
  tone,
}: {
  label: string;
  icon: React.ReactNode;
  current: number;
  max: number;
  tone: string;
}) {
  const { percent, boost } = meterFill(current, max);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="flex items-center gap-1.5 font-medium">
          {icon}
          {label}
        </span>
        <span className="tabular-nums">
          <span className="font-semibold">{current}</span>
          <span className="text-muted-foreground"> / {max}</span>
          {boost > 0 && (
            <span className="ml-1.5 text-xs text-emerald-700 dark:text-emerald-400">
              +{boost} boosted
            </span>
          )}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(current, max)}
        aria-valuetext={`${current} of ${max}${boost > 0 ? `, boosted by ${boost}` : ''}`}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function VitalsContent({ vitals }: { vitals: Vitals }) {
  if (!vitals.hp && !vitals.prayer && !vitals.spellbook) {
    return <p className="text-sm text-muted-foreground">No vitals received yet.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      {vitals.hp && (
        <Meter
          label="Hitpoints"
          icon={<HeartIcon aria-hidden className="size-4 text-red-600 dark:text-red-400" />}
          current={vitals.hp.current}
          max={vitals.hp.max}
          tone="bg-red-600 dark:bg-red-500"
        />
      )}
      {vitals.prayer && (
        <Meter
          label="Prayer"
          icon={<SparklesIcon aria-hidden className="size-4 text-sky-600 dark:text-sky-400" />}
          current={vitals.prayer.current}
          max={vitals.prayer.max}
          tone="bg-sky-600 dark:bg-sky-500"
        />
      )}
      {vitals.spellbook && (
        <p className="text-sm">
          <span className="text-muted-foreground">Spellbook: </span>
          <span className="font-medium">{spellbookLabel(vitals.spellbook)}</span>
        </p>
      )}
    </div>
  );
}
