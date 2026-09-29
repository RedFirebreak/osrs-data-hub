/**
 * Admin → Raw payloads (handoff §12): the archived ingest bodies from listRawPayloads, newest first,
 * filtered by device and status (`?device=&status=`), RAW_PAYLOAD_PAGE_SIZE per page with an "Older"
 * link (keyset cursor `?before=&beforeId=`). The list shows outcome and size only; a body is fetched
 * on demand in a dialog (RawPayloadDialog), and every such view is audited. Payloads are kept
 * RAW_PAYLOAD_RETENTION_HOURS.
 */
import { getConfig } from '@hub/core';
import { getDb } from '@hub/db';
import { listAllDevices, listRawPayloads, type RawPayloadRow } from '@hub/server';
import { ArrowLeftIcon, ArrowRightIcon, FileJsonIcon } from 'lucide-react';
import type { Metadata, Route } from 'next';
import Link from 'next/link';
import {
  RAW_PAYLOAD_PAGE_SIZE,
  describeIngestMeta,
  formatBytes,
  parseRawPayloadQuery,
  rawPayloadsHref,
  shortId,
} from '@/components/admin/admin-model';
import { AdminEmptyState, AdminSectionHeader } from '@/components/admin/admin-section';
import { HttpStatusBadge } from '@/components/admin/badges';
import { DateTime } from '@/components/admin/date-time';
import { RawPayloadDialog } from '@/components/admin/raw-payload-dialog';
import { RawPayloadFilters } from '@/components/admin/raw-payload-filters';
import { deviceName } from '@/components/devices/device-model';
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
import { requireAdmin } from '@/lib/session';

export function generateMetadata(): Metadata {
  return { title: `Raw payloads · Admin · ${getConfig().hubName}` };
}

export default async function AdminPayloadsPage({ searchParams }: PageProps<'/admin/payloads'>) {
  await requireAdmin();
  const query = parseRawPayloadQuery(await searchParams);
  const { db } = getDb();
  // Sequential: one pooled connection per page render is plenty for an admin page.
  const rows = await listRawPayloads(db, {
    deviceId: query.deviceId,
    status: query.status,
    before: query.before,
    limit: RAW_PAYLOAD_PAGE_SIZE,
  });
  const devices = await listAllDevices(db);
  const names = new Map(devices.map((d) => [d.id, `${deviceName(d.label)} · ${d.user.name}`]));
  const now = new Date().toISOString();
  const last = rows.at(-1);
  const filtered = query.deviceId !== undefined || query.status !== undefined;
  const olderHref =
    rows.length >= RAW_PAYLOAD_PAGE_SIZE && last
      ? rawPayloadsHref({ ...query, before: { receivedAt: last.receivedAt, id: last.id } })
      : null;
  const newestHref = query.before ? rawPayloadsHref({ ...query, before: undefined }) : null;

  return (
    <section aria-labelledby="admin-payloads" className="flex flex-col gap-4">
      <AdminSectionHeader
        id="admin-payloads"
        title="Raw payloads"
        description={`Plugin payloads exactly as received, kept ${getConfig().rawPayloadRetentionHours} hours. Open one only to debug ingest: it can hold private data, and every view is audited.`}
      />
      <RawPayloadFilters
        devices={devices.map((d) => ({ id: d.id, label: names.get(d.id) ?? d.id }))}
        deviceId={query.deviceId ?? null}
        status={query.status === undefined ? null : String(query.status)}
      />
      {rows.length === 0 ? (
        <AdminEmptyState
          icon={FileJsonIcon}
          title={query.before ? 'Nothing older' : 'No payloads found'}
        >
          {query.before
            ? 'These are all the archived payloads that match.'
            : filtered
              ? 'Nothing archived matches these filters. Payloads older than the retention are deleted.'
              : 'Payloads appear here as soon as a paired plugin sends data.'}
        </AdminEmptyState>
      ) : (
        <div className="rounded-xl ring-1 ring-foreground/10">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Received</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Device</TableHead>
                <TableHead className="hidden lg:table-cell">Outcome</TableHead>
                <TableHead className="hidden text-right md:table-cell">Size</TableHead>
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">Payload</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <PayloadRow
                  key={row.id}
                  row={row}
                  deviceLabel={row.deviceId ? (names.get(row.deviceId) ?? null) : null}
                  now={now}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {(olderHref || newestHref) && (
        <nav aria-label="Pages" className="flex flex-wrap justify-between gap-2">
          {newestHref ? (
            <Button asChild variant="outline" size="sm">
              <Link href={newestHref as Route}>
                <ArrowLeftIcon aria-hidden data-icon="inline-start" />
                Newest
              </Link>
            </Button>
          ) : (
            <span />
          )}
          {olderHref && (
            <Button asChild variant="outline" size="sm">
              <Link href={olderHref as Route}>
                Older
                <ArrowRightIcon aria-hidden data-icon="inline-end" />
              </Link>
            </Button>
          )}
        </nav>
      )}
    </section>
  );
}

function PayloadRow({
  row,
  deviceLabel,
  now,
}: {
  row: RawPayloadRow;
  deviceLabel: string | null;
  now: string;
}) {
  const statusKey = row.status === null ? 'pending' : String(row.status);
  const outcome = describeIngestMeta(row.meta);
  const device = row.deviceId
    ? (deviceLabel ?? `Deleted device ${shortId(row.deviceId)}`)
    : 'No device';
  const receivedAt = row.receivedAt.toISOString();
  return (
    <TableRow>
      <TableCell className="pl-4">
        <div className="flex flex-col">
          <RelativeTime date={receivedAt} now={now} className="font-medium" />
          <DateTime date={receivedAt} withTime className="text-xs text-muted-foreground" />
          <span className="text-xs text-muted-foreground sm:hidden">{device}</span>
        </div>
      </TableCell>
      <TableCell>
        <HttpStatusBadge statusKey={statusKey} />
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <div className="flex flex-col">
          {row.deviceId ? (
            <Link
              href={rawPayloadsHref({ deviceId: row.deviceId }) as Route}
              className="underline-offset-4 hover:underline"
              title="Only this device's payloads"
            >
              {device}
            </Link>
          ) : (
            <span className="text-muted-foreground">{device}</span>
          )}
          <span className="font-mono text-xs text-muted-foreground">
            {row.pluginVersion ?? 'no version'}
          </span>
        </div>
      </TableCell>
      <TableCell className="hidden max-w-72 text-xs whitespace-normal text-muted-foreground lg:table-cell">
        {outcome.length > 0 ? outcome.join(' · ') : '—'}
      </TableCell>
      <TableCell className="hidden text-right tabular-nums md:table-cell">
        {formatBytes(row.size)}
      </TableCell>
      <TableCell className="pr-4 text-right">
        <RawPayloadDialog
          id={row.id}
          receivedAt={receivedAt}
          title={`${device}, ${receivedAt.slice(0, 19).replace('T', ' ')} UTC`}
        />
      </TableCell>
    </TableRow>
  );
}
