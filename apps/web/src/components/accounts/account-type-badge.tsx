/**
 * Badge for an account type (the IRONMAN varbit: Ironman, Ultimate, Hardcore, Group…), labelled by
 * @hub/core accountTypeLabel. Normal accounts get no badge unless `showNormal`; an unknown type gets
 * none unless `showUnknown`. Server- and client-safe.
 */
import { accountTypeLabel } from '@hub/core';
import { ShieldIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** Tints by varbit value (hardcore types red, group types blue). */
const TONES: Readonly<Record<number, string>> = {
  1: 'border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300',
  2: 'border-zinc-400/40 bg-zinc-400/10 text-zinc-700 dark:text-zinc-200',
  3: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
  4: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  5: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
  6: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
};

export interface AccountTypeBadgeProps {
  accountType: number | null | undefined;
  /** Also badge normal accounts ("Normal"). */
  showNormal?: boolean;
  /** Also badge an unknown/missing type ("Unknown"). */
  showUnknown?: boolean;
  /** Icon only (the label goes to the tooltip title and screen readers), for tight lists. */
  compact?: boolean;
  className?: string;
}

export function AccountTypeBadge({
  accountType,
  showNormal = false,
  showUnknown = false,
  compact = false,
  className,
}: AccountTypeBadgeProps) {
  const label = accountTypeLabel(accountType);
  if (label === 'Unknown' && !showUnknown) return null;
  if (accountType === 0 && !showNormal) return null;
  const tone =
    typeof accountType === 'number' && Object.hasOwn(TONES, accountType)
      ? TONES[accountType]
      : undefined;
  const ironman = tone !== undefined;
  if (compact) {
    if (!ironman) return null;
    return (
      <span
        title={label}
        className={cn('inline-flex items-center', tone, 'rounded-full border p-0.5', className)}
      >
        <ShieldIcon aria-hidden className="size-3" />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <Badge variant="outline" className={cn(tone, className)}>
      {ironman && <ShieldIcon aria-hidden data-icon="inline-start" />}
      {label}
    </Badge>
  );
}
