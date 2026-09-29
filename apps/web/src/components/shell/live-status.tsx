'use client';
/**
 * Small header indicator of the live connection (LiveProvider): "Live" when the stream is open,
 * "Reconnecting…" while the polling fallback covers for it. Explained in a tooltip.
 */
import { useLiveStatus } from '@/components/live/live-provider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const TEXT = {
  open: { label: 'Live', help: 'Connected: toasts and online status update instantly.' },
  connecting: { label: 'Connecting…', help: 'Opening the live connection to the hub.' },
  polling: {
    label: 'Reconnecting…',
    help: 'The live connection dropped. New events are still checked every 10 seconds while it reconnects.',
  },
} as const;

export function LiveStatusIndicator({ className }: { className?: string }) {
  const { state } = useLiveStatus();
  if (state === 'offline') return null;
  const { label, help } = TEXT[state];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            'inline-flex h-7 cursor-default items-center gap-1.5 rounded-full px-2 text-xs text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
            className,
          )}
        >
          <span
            aria-hidden
            className={cn(
              'size-2 rounded-full',
              state === 'open' && 'bg-emerald-500',
              state === 'connecting' && 'bg-muted-foreground/50',
              state === 'polling' && 'animate-pulse bg-amber-500',
            )}
          />
          <span className="sr-only sm:not-sr-only" role="status">
            {label}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{help}</TooltipContent>
    </Tooltip>
  );
}
