'use client';
/**
 * What a Progress view counts: XP, loot, boss kills or play time, as pills above the chart. A
 * measure the viewer may not read is offered disabled, saying why, rather than left out: the row
 * keeps its shape on every character.
 */
import type { MetricsMeasure } from '@hub/core';
import { PROGRESS_MEASURES, PROGRESS_MEASURE_LABELS } from '@/lib/progress';
import { cn } from '@/lib/utils';
import { useProgressQuery } from './progress-nav';

export interface MeasurePillsProps {
  /** The measures the viewer may read. */
  available: Readonly<Record<MetricsMeasure, boolean>>;
  className?: string;
}

export function MeasurePills({ available, className }: MeasurePillsProps) {
  const { query, set } = useProgressQuery();
  return (
    <div
      role="group"
      aria-label="What to count"
      className={cn('flex flex-wrap gap-1.5', className)}
    >
      {PROGRESS_MEASURES.map((measure) => {
        const on = measure === query.measure;
        const allowed = available[measure];
        return (
          <button
            key={measure}
            type="button"
            aria-pressed={on}
            disabled={!allowed}
            title={allowed ? undefined : "The owner of this character doesn't share this with you"}
            onClick={() => {
              if (!on) set({ measure });
            }}
            className={cn(
              'pressable h-7 rounded-full border px-3 text-xs font-medium focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
              on
                ? 'border-foreground bg-foreground text-background'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {PROGRESS_MEASURE_LABELS[measure]}
          </button>
        );
      })}
    </div>
  );
}
