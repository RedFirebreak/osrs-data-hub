/**
 * "Not shared" badge for a section the plugin never sent (handoff §10, D-4): the player's HA Exporter
 * settings decide what is sent, and the hub shows the gap instead of an empty section. Use it for
 * `Section` values with `{ visible: true, shared: false }`; sections the viewer may not see
 * (`visible: false`) are hidden instead, not badged.
 *
 * The explanation is in a tooltip (keyboard-focusable) and in screen-reader text. Server- and
 * client-safe (the tooltip parts are client components).
 */
import { EyeOffIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface NotSharedBadgeProps {
  /** What isn't sent, for the explanation, e.g. "inventory" → "…don't send inventory". */
  what?: string;
  className?: string;
}

export function notSharedExplanation(what?: string): string {
  return `The player's HA Exporter plugin settings don't send ${what ?? 'this'} to the hub.`;
}

export function NotSharedBadge({ what, className }: NotSharedBadgeProps) {
  const explanation = notSharedExplanation(what);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          tabIndex={0}
          className={cn('cursor-help text-muted-foreground', className)}
        >
          <EyeOffIcon aria-hidden data-icon="inline-start" />
          Not shared
          <span className="sr-only">: {explanation}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{explanation}</TooltipContent>
    </Tooltip>
  );
}
