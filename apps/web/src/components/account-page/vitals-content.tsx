/**
 * HP, prayer, the prayers that are on and the spellbook (the `activity` category). Boosted values
 * above the maximum (brews, boosts) draw a full bar and say how far over they are. Server component.
 */
import { prayerLabel } from '@hub/core';
import type { Vitals } from '@hub/server';
import { HeartIcon, SparklesIcon } from 'lucide-react';
import { PrayerIcon } from '@/components/icons/osrs-icon';
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

/**
 * The prayers that are on (D-119), as the prayer book's lit icons with their names; "None" when no
 * prayer is on, which is also what an offline player has (logging out turns them all off).
 */
function ActivePrayers({ prayers }: { prayers: readonly string[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm text-muted-foreground">Active prayers</span>
      {prayers.length === 0 ? (
        <span className="text-sm text-muted-foreground">None</span>
      ) : (
        <ul className="flex flex-wrap gap-1.5" aria-label="Active prayers">
          {prayers.map((prayer) => (
            <li
              key={prayer}
              className="flex items-center gap-1.5 rounded-full border bg-muted/40 py-0.5 pr-2.5 pl-1 text-sm"
            >
              <PrayerIcon prayer={prayer} className="size-5" holdSpace />
              <span className="font-medium">{prayerLabel(prayer)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function VitalsContent({ vitals }: { vitals: Vitals }) {
  if (!vitals.hp && !vitals.prayer && !vitals.spellbook && !vitals.activePrayers) {
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
      {vitals.activePrayers && <ActivePrayers prayers={vitals.activePrayers} />}
      {vitals.spellbook && (
        <p className="text-sm">
          <span className="text-muted-foreground">Spellbook: </span>
          <span className="font-medium">{spellbookLabel(vitals.spellbook)}</span>
        </p>
      )}
    </div>
  );
}
