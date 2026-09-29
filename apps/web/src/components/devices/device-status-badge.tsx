/**
 * Badges of the Devices page: the device's status (active / outdated / revoked) and the "Outdated"
 * marker next to its plugin version, whose tooltip (keyboard-focusable) says how to fix it: restarting
 * RuneLite updates Plugin Hub plugins. Server- and client-safe (the tooltip parts are client
 * components).
 */
import type { DeviceStatus } from '@hub/server';
import { CircleAlertIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { DEVICE_STATUS_LABELS, OUTDATED_HELP } from './device-model';

const STATUS_TONES: Readonly<Record<DeviceStatus, string>> = {
  active: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  outdated: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
  revoked: 'border-border bg-muted text-muted-foreground',
};

export function DeviceStatusBadge({
  status,
  className,
}: {
  status: DeviceStatus;
  className?: string;
}) {
  return (
    <Badge variant="outline" className={cn(STATUS_TONES[status], className)}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {DEVICE_STATUS_LABELS[status]}
    </Badge>
  );
}

export function OutdatedBadge({ className }: { className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          tabIndex={0}
          className={cn('cursor-help', STATUS_TONES.outdated, className)}
        >
          <CircleAlertIcon aria-hidden data-icon="inline-start" />
          Outdated
          <span className="sr-only">: {OUTDATED_HELP}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{OUTDATED_HELP}</TooltipContent>
    </Tooltip>
  );
}
