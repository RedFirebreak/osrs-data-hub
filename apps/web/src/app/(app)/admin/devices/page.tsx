/**
 * Admin → Devices (handoff §12): every user's paired RuneLite connections from listAllDevices, with
 * filters for outdated and revoked devices (`?show=`), and Revoke (reason 'admin'). Noisy devices
 * (payloads per hour) are on the ingest health page, which links back to a device's raw payloads.
 */
import { getDb } from '@hub/db';
import { listAllDevices, type AdminDeviceRow } from '@hub/server';
import { MonitorSmartphoneIcon } from 'lucide-react';
import type { Metadata, Route } from 'next';
import Link from 'next/link';
import {
  DEVICE_FILTERS,
  adminRevokedText,
  parseDeviceFilter,
  rawPayloadsHref,
  shortId,
  type DeviceFilter,
} from '@/components/admin/admin-model';
import { AdminEmptyState, AdminSectionHeader } from '@/components/admin/admin-section';
import { DateTime } from '@/components/admin/date-time';
import { AdminRevokeDeviceButton } from '@/components/admin/revoke-device-button';
import { AccountLink } from '@/components/accounts/account-link';
import { deviceName } from '@/components/devices/device-model';
import { DeviceStatusBadge, OutdatedBadge } from '@/components/devices/device-status-badge';
import { RelativeTime } from '@/components/events/relative-time';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { adminMetadata, requireAdmin } from '@/lib/session';
import { cn } from '@/lib/utils';

/** Reported accounts listed per device before "+N more". */
const ACCOUNTS_SHOWN = 3;

export function generateMetadata(): Promise<Metadata> {
  return adminMetadata('Devices');
}

export default async function AdminDevicesPage({ searchParams }: PageProps<'/admin/devices'>) {
  await requireAdmin();
  const filter = parseDeviceFilter((await searchParams).show);
  const all = await listAllDevices(getDb().db);
  const now = new Date().toISOString();
  const counts: Record<DeviceFilter, number> = {
    all: all.length,
    active: 0,
    outdated: 0,
    revoked: 0,
  };
  for (const d of all) counts[d.status] += 1;
  const shown = filter === 'all' ? all : all.filter((d) => d.status === filter);

  return (
    <section aria-labelledby="admin-devices" className="flex flex-col gap-4">
      <AdminSectionHeader
        id="admin-devices"
        title="Devices"
        description="Every paired RuneLite connection. Revoking one makes the plugin disable it at its next send; its owner can pair again."
      />
      <nav aria-label="Filter devices">
        <ul className="flex flex-wrap gap-2">
          {DEVICE_FILTERS.map((f) => {
            const active = f.value === filter;
            const href = (
              f.value === 'all' ? '/admin/devices' : `/admin/devices?show=${f.value}`
            ) as Route;
            return (
              <li key={f.value}>
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                    active
                      ? 'border-foreground bg-foreground text-background'
                      : 'bg-background text-muted-foreground hover:text-foreground',
                  )}
                >
                  {f.label}
                  {/* Dimmed only on the dark active pill: muted text dimmed further fails AA. */}
                  <span className={cn('tabular-nums', active && 'opacity-70')}>
                    {counts[f.value]}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {shown.length === 0 ? (
        <AdminEmptyState
          icon={MonitorSmartphoneIcon}
          title={all.length === 0 ? 'No devices paired yet' : `No ${filter} devices`}
        >
          {all.length === 0
            ? 'Devices appear here when members pair the HA Exporter plugin in the onboarding wizard.'
            : 'Nothing matches this filter right now.'}
        </AdminEmptyState>
      ) : (
        <div className="rounded-xl ring-1 ring-foreground/10">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Device</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Plugin</TableHead>
                <TableHead className="hidden md:table-cell">Last seen</TableHead>
                <TableHead className="hidden lg:table-cell">Accounts</TableHead>
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((d) => (
                <DeviceRow key={d.id} device={d} now={now} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function DeviceRow({ device, now }: { device: AdminDeviceRow; now: string }) {
  const name = deviceName(device.label);
  const extra = device.accounts.length - ACCOUNTS_SHOWN;
  return (
    <TableRow>
      <TableCell className="pl-4">
        <div className="flex flex-col">
          <span className="font-medium">{name}</span>
          <span className="text-xs text-muted-foreground">
            {device.user.name} ·{' '}
            <Link
              href={rawPayloadsHref({ deviceId: device.id }) as Route}
              className="font-mono underline-offset-4 hover:underline"
              title="Raw payloads of this device"
            >
              {shortId(device.id)}
            </Link>
          </span>
          <span className="text-xs text-muted-foreground">
            Paired <DateTime date={device.createdAt.toISOString()} />
          </span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <DeviceStatusBadge status={device.status} />
          {device.revokedAt && (
            <span className="text-xs whitespace-normal text-muted-foreground">
              {adminRevokedText(device.revokedReason)},{' '}
              <RelativeTime date={device.revokedAt.toISOString()} now={now} />
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-xs">{device.pluginVersion ?? '—'}</span>
          {device.status === 'outdated' && <OutdatedBadge />}
        </div>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        {device.lastSeenAt ? (
          <RelativeTime date={device.lastSeenAt.toISOString()} now={now} />
        ) : (
          <span className="text-muted-foreground">Never</span>
        )}
      </TableCell>
      <TableCell className="hidden max-w-64 whitespace-normal lg:table-cell">
        {device.accounts.length === 0 ? (
          <span className="text-muted-foreground">None yet</span>
        ) : (
          <span className="text-sm">
            {device.accounts.slice(0, ACCOUNTS_SHOWN).map((a, i) => (
              <span key={a.publicId}>
                {i > 0 && ', '}
                <AccountLink publicId={a.publicId} name={a.name} />
              </span>
            ))}
            {extra > 0 && <span className="text-muted-foreground"> +{extra} more</span>}
          </span>
        )}
      </TableCell>
      <TableCell className="pr-4 text-right">
        {device.status !== 'revoked' && (
          <AdminRevokeDeviceButton deviceId={device.id} name={name} owner={device.user.name} />
        )}
      </TableCell>
    </TableRow>
  );
}
