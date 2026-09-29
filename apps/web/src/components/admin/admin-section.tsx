/**
 * Building blocks of the admin pages: the page's own heading (an h2 under the layout's "Admin" h1)
 * with an optional description and actions, a row of small stat tiles, and the empty state of a
 * table. Server- and client-safe.
 */
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function AdminSectionHeader({
  id,
  title,
  description,
  actions,
  className,
}: {
  /** The heading's id, for a section's aria-labelledby. */
  id?: string;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-6',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 id={id} className="text-lg font-semibold text-balance">
          {title}
        </h2>
        {description && (
          <p className="mt-1 max-w-prose text-sm text-pretty text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export interface Stat {
  label: string;
  value: string;
  /** A short line under the value. */
  hint?: string;
  /** Draws attention (e.g. failures above zero). */
  attention?: boolean;
}

/** Stat tiles: 2 per row on phones, up to 4 on wider screens. */
export function StatTiles({ stats, label }: { stats: Stat[]; label: string }) {
  return (
    <dl aria-label={label} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {stats.map((s) => (
        <div
          key={s.label}
          className="flex flex-col gap-1 rounded-xl bg-card p-3 ring-1 ring-foreground/10"
        >
          <dt className="text-xs text-muted-foreground">{s.label}</dt>
          <dd
            className={cn(
              'text-xl font-semibold tabular-nums',
              s.attention && 'text-amber-700 dark:text-amber-300',
            )}
          >
            {s.value}
          </dd>
          {s.hint && <dd className="text-xs text-muted-foreground">{s.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** What a table shows when there's nothing to list, and what to do about it. */
export function AdminEmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-10 text-center">
      <span
        aria-hidden
        className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <Icon className="size-5" />
      </span>
      <p className="font-medium">{title}</p>
      {children && (
        <div className="max-w-prose text-sm text-balance text-muted-foreground">{children}</div>
      )}
    </div>
  );
}
