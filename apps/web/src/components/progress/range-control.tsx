'use client';
/**
 * The range of a Progress view: 1D, 7D, 30D … as one segmented control inside the chart's card,
 * next to what it changes. The marker slides to the pressed range at once (the query is optimistic,
 * progress-nav.tsx) while the chart follows; with reduced motion it just moves.
 *
 *   <RangeControl ranges={PROGRESS_RANGES} />
 */
import { PROGRESS_RANGE_LABELS, PROGRESS_RANGE_WORDS, type ProgressRange } from '@/lib/progress';
import { cn } from '@/lib/utils';
import { useProgressQuery } from './progress-nav';

export interface RangeControlProps {
  /** The ranges offered, shortest first. */
  ranges: readonly ProgressRange[];
  className?: string;
}

export function RangeControl({ ranges, className }: RangeControlProps) {
  const { query, set } = useProgressQuery();
  const index = Math.max(0, ranges.indexOf(query.range));
  return (
    <div
      role="group"
      aria-label="Range"
      className={cn('relative inline-grid rounded-full border bg-muted/60 p-0.5', className)}
      style={{ gridTemplateColumns: `repeat(${ranges.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-0.5 rounded-full bg-background shadow-sm ring-1 ring-foreground/10 transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
        style={{
          width: `calc((100% - 0.25rem) / ${ranges.length})`,
          transform: `translateX(${index * 100}%)`,
        }}
      />
      {ranges.map((range) => {
        const on = range === query.range;
        return (
          <button
            key={range}
            type="button"
            aria-pressed={on}
            title={`Show what happened ${PROGRESS_RANGE_WORDS[range]}`}
            onClick={() => {
              if (!on) set({ range });
            }}
            className={cn(
              'pressable relative z-10 h-7 min-w-11 rounded-full px-2.5 text-xs font-semibold tabular-nums focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              on ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {PROGRESS_RANGE_LABELS[range]}
          </button>
        );
      })}
    </div>
  );
}
