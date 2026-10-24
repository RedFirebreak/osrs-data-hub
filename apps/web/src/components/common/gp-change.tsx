/**
 * A wealth gain or loss in gp, signed and toned: green for a gain, red for a loss, muted for none.
 * The exact amount is in the title.
 */
import { formatGpChange, formatNumber } from '@hub/core';
import { cn } from '@/lib/utils';

export const GAIN_TONE = 'text-emerald-700 dark:text-emerald-300';
export const LOSS_TONE = 'text-red-700 dark:text-red-300';

/** The tone class of a change: a gain, a loss, or muted for none. */
export function changeTone(value: number): string {
  if (Math.round(value) >= 1) return GAIN_TONE;
  if (Math.round(value) <= -1) return LOSS_TONE;
  return 'text-muted-foreground';
}

export function GpChange({
  value,
  suffix = ' gp',
  className,
}: {
  value: number;
  suffix?: string;
  className?: string;
}) {
  return (
    <span
      className={cn('tabular-nums', changeTone(value), className)}
      title={`${Math.round(value) >= 1 ? '+' : ''}${formatNumber(value)} gp`}
    >
      {formatGpChange(value)}
      {suffix}
    </span>
  );
}
