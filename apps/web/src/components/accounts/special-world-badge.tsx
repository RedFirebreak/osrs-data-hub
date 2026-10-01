/**
 * Marks data from a special world (Leagues, Deadman, Beta…, handoff §7.1.9). The hub stores events and
 * play sessions from those worlds, flagged, but no XP, gains, wealth, equipment or location (D-45).
 * Server- and client-safe.
 */
import { cn } from '@/lib/utils';
import { ExplainedBadge } from './explained-badge';

export const SPECIAL_WORLD_EXPLANATION =
  'From a special world (Leagues, Deadman or similar). XP, gains, wealth, gear and location from there are not tracked.';

export function SpecialWorldBadge({ className }: { className?: string }) {
  return (
    <ExplainedBadge
      explanation={SPECIAL_WORLD_EXPLANATION}
      className={cn('border-violet-500/30 text-violet-700 dark:text-violet-300', className)}
    >
      Special world
    </ExplainedBadge>
  );
}
