'use client';
/**
 * The raw payload viewer's filters (device, status). Changing one navigates to the filtered URL
 * (rawPayloadsHref), which also drops the page cursor; the list itself is rendered on the server.
 */
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  RAW_PAYLOAD_STATUS_OPTIONS,
  httpStatusLabel,
  rawPayloadsHref,
  shortId,
  type RawPayloadQuery,
} from './admin-model';

const ALL = 'all';

export interface RawPayloadFiltersProps {
  devices: { id: string; label: string }[];
  deviceId: string | null;
  /** The status filter as in the URL ('503', 'pending'), or null. */
  status: string | null;
}

export function RawPayloadFilters({ devices, deviceId, status }: RawPayloadFiltersProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function go(next: { deviceId: string | null; status: string | null }): void {
    const query: RawPayloadQuery = {};
    if (next.deviceId) query.deviceId = next.deviceId;
    if (next.status === 'pending') query.status = 'pending';
    else if (next.status) query.status = Number(next.status);
    startTransition(() => router.push(rawPayloadsHref(query) as Route));
  }

  const statusOptions =
    status && !RAW_PAYLOAD_STATUS_OPTIONS.includes(status)
      ? [...RAW_PAYLOAD_STATUS_OPTIONS, status]
      : RAW_PAYLOAD_STATUS_OPTIONS;
  const knownDevice = deviceId === null || devices.some((d) => d.id === deviceId);

  return (
    <div className="flex flex-wrap items-end gap-3" aria-busy={pending || undefined}>
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor="raw-device">Device</Label>
        <Select
          value={deviceId ?? ALL}
          onValueChange={(v) => go({ deviceId: v === ALL ? null : v, status })}
        >
          <SelectTrigger id="raw-device" className="w-64 max-w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All devices</SelectItem>
            {!knownDevice && deviceId && (
              <SelectItem value={deviceId}>Device {shortId(deviceId)}</SelectItem>
            )}
            {devices.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="raw-status">Status</Label>
        <Select
          value={status ?? ALL}
          onValueChange={(v) => go({ deviceId, status: v === ALL ? null : v })}
        >
          <SelectTrigger id="raw-status" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {statusOptions.map((s) => (
              <SelectItem key={s} value={s}>
                {s === 'pending' ? httpStatusLabel(s) : `${s} ${httpStatusLabel(s)}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
