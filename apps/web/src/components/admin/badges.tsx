/**
 * Small badges of the admin tables: a user's status, the admin role, and the HTTP status of an
 * archived payload. Each carries its meaning as text (never colour alone). Server- and client-safe.
 */
import type { UserStatus } from '@hub/db';
import { ShieldIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  USER_STATUS_LABELS,
  httpStatusLabel,
  httpStatusTone,
  type StatusTone,
} from './admin-model';

const OK_TONE = 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
const WARN_TONE = 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300';
const ERROR_TONE = 'border-destructive/30 bg-destructive/10 text-destructive';
const MUTED_TONE = 'border-border bg-muted text-muted-foreground';

const USER_TONES: Readonly<Record<UserStatus, string>> = { active: OK_TONE, grace: WARN_TONE };

export function UserStatusBadge({ status, className }: { status: UserStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn(USER_TONES[status], className)}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {USER_STATUS_LABELS[status]}
    </Badge>
  );
}

export function AdminRoleBadge({ className }: { className?: string }) {
  return (
    <Badge variant="secondary" className={className}>
      <ShieldIcon aria-hidden data-icon="inline-start" />
      Admin
    </Badge>
  );
}

const STATUS_TONES: Readonly<Record<StatusTone, string>> = {
  ok: OK_TONE,
  client: WARN_TONE,
  server: ERROR_TONE,
  pending: MUTED_TONE,
};

/** An HTTP status key ('200', '503', 'pending') with its label: "503 Unavailable". */
export function HttpStatusBadge({
  statusKey,
  showLabel = true,
  className,
}: {
  statusKey: string;
  showLabel?: boolean;
  className?: string;
}) {
  const label = httpStatusLabel(statusKey);
  return (
    <Badge
      variant="outline"
      className={cn('font-mono tabular-nums', STATUS_TONES[httpStatusTone(statusKey)], className)}
      title={showLabel ? undefined : label}
    >
      {statusKey === 'pending' ? '—' : statusKey}
      {showLabel ? (
        <span className="font-sans">{label}</span>
      ) : (
        <span className="sr-only"> {label}</span>
      )}
    </Badge>
  );
}
