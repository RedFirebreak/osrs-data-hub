/**
 * One labelled number in a <dl> of stats (a card's "Total level", a section's "Days played"): the
 * label small and muted above, the value strong below. Server- and client-safe.
 *
 *   <dl className="grid grid-cols-3 gap-4">
 *     <Stat label="Sessions" value="12" />
 *     <Stat label="XP today" value="—" muted truncate />
 *   </dl>
 */
import { cn } from '@/lib/utils';

export interface StatProps {
  label: string;
  value: string;
  /** Nothing to show off (zero, unknown): the value in normal weight and muted. */
  muted?: boolean;
  /** Cut a value that doesn't fit its column with an ellipsis instead of letting it wrap. */
  truncate?: boolean;
}

export function Stat({ label, value, muted = false, truncate = false }: StatProps) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          truncate && 'truncate',
          'text-base font-semibold tabular-nums',
          muted && 'font-normal text-muted-foreground',
        )}
      >
        {value}
      </dd>
    </div>
  );
}
