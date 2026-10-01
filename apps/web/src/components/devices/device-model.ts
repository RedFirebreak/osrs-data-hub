/**
 * Pure helpers for the Devices page (handoff §6.3): display names, status texts and how a failed
 * rename or revoke (PATCH / DELETE /api/app/devices/[id]) is told. No React, no browser APIs;
 * unit-tested in device-model.test.ts.
 *
 * Only `import type` from @hub/server: the page's client components import this module (NEXT-12).
 */
import type { DeviceStatus } from '@hub/server';
import type { FailureOptions } from '@/lib/api-client';

/** Shown for a device without a label. */
export const UNNAMED_DEVICE = 'Unnamed device';

/** The device's label, or "Unnamed device". */
export function deviceName(label: string | null | undefined): string {
  const trimmed = label?.trim();
  return trimmed ? trimmed : UNNAMED_DEVICE;
}

/** Status badge text. */
export const DEVICE_STATUS_LABELS: Readonly<Record<DeviceStatus, string>> = {
  active: 'Active',
  outdated: 'Outdated',
  revoked: 'Revoked',
};

/** Tooltip of the "Outdated" badge. */
export const OUTDATED_HELP = 'Update HA Exporter: restart RuneLite';

/** "Revoked by you" / "Revoked by an admin" / "Revoked when you left the guild". */
export function revokedByText(reason: string | null): string {
  switch (reason) {
    case 'user':
      return 'Revoked by you';
    case 'admin':
      return 'Revoked by an admin';
    case 'offboarding':
      return 'Revoked when your access ended';
    default:
      return 'Revoked';
  }
}

/** The API path of one device. */
export function deviceApiPath(deviceId: string): string {
  return `/api/app/devices/${encodeURIComponent(deviceId)}`;
}

/** How a failed device request is told (failureMessage, lib/api-client.ts). */
export function deviceFailure(action: 'rename' | 'revoke'): FailureOptions {
  return {
    fallback:
      action === 'rename'
        ? "Couldn't rename the device. Try again in a moment."
        : "Couldn't revoke the device. Try again in a moment.",
    notFound: 'This device no longer exists. Reload the page.',
  };
}
