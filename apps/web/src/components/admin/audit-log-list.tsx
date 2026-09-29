'use client';
/**
 * The admin audit log (handoff §12): the first page is rendered by the server; "Load more" fetches
 * older entries from GET /api/app/admin/audit-log?before=<last id> and appends them. Each entry shows
 * when, who (a user, or the system/worker label), the action, its target and its details (meta).
 */
import type { AuditLogRow } from '@hub/server';
import { LoaderCircleIcon, ScrollTextIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { RelativeTime } from '@/components/events/relative-time';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  adminFailureMessage,
  auditActionLabel,
  auditLogApiPath,
  auditMetaEntries,
} from './admin-model';
import { AdminEmptyState } from './admin-section';
import { DateTime } from './date-time';

/** An audit entry as JSON (the route's and the page's serialization): `at` is ISO. */
export type AuditEntryJson = Omit<AuditLogRow, 'at'> & { at: string };

export interface AuditLogListProps {
  initial: AuditEntryJson[];
  /** The id to load older entries before, or null when the first page is all there is. */
  nextBefore: number | null;
  /** The server's render time, for relative times during hydration. */
  now: string;
}

function isEntryList(value: unknown): value is AuditEntryJson[] {
  return (
    Array.isArray(value) &&
    value.every(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as { id?: unknown }).id === 'number' &&
        typeof (e as { at?: unknown }).at === 'string' &&
        typeof (e as { action?: unknown }).action === 'string',
    )
  );
}

function actorText(entry: AuditEntryJson): { text: string; system: boolean } {
  if (entry.actorName) return { text: entry.actorName, system: false };
  if (entry.actorUserId) return { text: 'Deleted user', system: true };
  return { text: entry.actorLabel ?? 'system', system: true };
}

export function AuditLogList({ initial, nextBefore, now }: AuditLogListProps) {
  const router = useRouter();
  const [entries, setEntries] = useState(initial);
  const [before, setBefore] = useState(nextBefore);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadMore(): Promise<void> {
    if (before === null) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(auditLogApiPath(before), { credentials: 'same-origin' });
      const body: unknown = await res.json().catch(() => null);
      const page = body as { entries?: unknown; nextBefore?: unknown } | null;
      if (res.ok && page && isEntryList(page.entries)) {
        const known = new Set(entries.map((e) => e.id));
        setEntries([...entries, ...page.entries.filter((e) => !known.has(e.id))]);
        setBefore(typeof page.nextBefore === 'number' ? page.nextBefore : null);
        return;
      }
      setError(adminFailureMessage(res.status, body, "Couldn't load older entries. Try again."));
      if (res.status === 401) router.refresh();
    } catch {
      setError("Couldn't reach the hub. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  if (entries.length === 0) {
    return (
      <AdminEmptyState icon={ScrollTextIcon} title="The audit log is empty">
        Pairings, revocations, offboardings, sharing changes and admin actions are recorded here.
      </AdminEmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl ring-1 ring-foreground/10">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">When</TableHead>
              <TableHead>Action</TableHead>
              <TableHead className="hidden md:table-cell">Target</TableHead>
              <TableHead className="hidden pr-4 lg:table-cell">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => {
              const actor = actorText(entry);
              const meta = auditMetaEntries(entry.meta);
              return (
                <TableRow key={entry.id} className="align-top">
                  <TableCell className="pl-4 align-top">
                    <div className="flex flex-col">
                      <RelativeTime date={entry.at} now={now} className="font-medium" />
                      <DateTime
                        date={entry.at}
                        withTime
                        className="text-xs text-muted-foreground"
                      />
                    </div>
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <div className="flex flex-col">
                      <span className="font-medium">{auditActionLabel(entry.action)}</span>
                      <span className="text-xs text-muted-foreground">
                        by <span className={actor.system ? 'italic' : undefined}>{actor.text}</span>
                      </span>
                      <code className="font-mono text-xs text-muted-foreground">
                        {entry.action}
                      </code>
                      {entry.targetType && (
                        <span className="text-xs break-all text-muted-foreground md:hidden">
                          {entry.targetType} {entry.targetId}
                        </span>
                      )}
                      {meta.length > 0 && (
                        <details className="mt-1 text-xs lg:hidden">
                          <summary className="cursor-pointer text-muted-foreground">
                            Details
                          </summary>
                          <MetaList meta={meta} />
                        </details>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden align-top md:table-cell">
                    {entry.targetType ? (
                      <div className="flex flex-col">
                        <span className="text-xs text-muted-foreground">{entry.targetType}</span>
                        <code
                          className="max-w-48 truncate font-mono text-xs"
                          title={entry.targetId ?? undefined}
                        >
                          {entry.targetId ?? '—'}
                        </code>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden pr-4 align-top whitespace-normal lg:table-cell">
                    {meta.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <MetaList meta={meta} />
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {before !== null ? (
        <Button
          type="button"
          variant="outline"
          className="self-center"
          disabled={pending}
          onClick={() => void loadMore()}
        >
          {pending && <LoaderCircleIcon aria-hidden className="animate-spin" />}
          Load more
        </Button>
      ) : (
        <p className="text-center text-xs text-muted-foreground">
          That&apos;s the oldest entry kept.
        </p>
      )}
    </div>
  );
}

function MetaList({ meta }: { meta: [string, string][] }) {
  return (
    <dl className="grid max-w-md grid-cols-[auto_1fr] gap-x-2 text-xs">
      {meta.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="font-mono break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
