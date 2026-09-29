/**
 * Pure helpers for the Devices page (handoff §6.3): display names, status texts and the error text for
 * a failed rename or revoke (PATCH / DELETE /api/app/devices/[id]). No React, no browser APIs;
 * unit-tested in device-model.test.ts.
 *
 * Only `import type` from @hub/server: the page's client components import this module (NEXT-12).
 */
import type { DeviceStatus } from '@hub/server';
import { apiErrorMessage } from '@/components/onboarding/wizard-model';

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

/** What to tell the user when a device request failed with `status` and `body`. */
export function deviceFailureMessage(
  status: number,
  body: unknown,
  action: 'rename' | 'revoke',
): string {
  if (status === 401) return 'Your session has ended. Sign in again.';
  if (status === 404) return 'This device no longer exists. Reload the page.';
  const fallback =
    action === 'rename'
      ? "Couldn't rename the device. Try again in a moment."
      : "Couldn't revoke the device. Try again in a moment.";
  if (status === 400 || status === 403 || status === 503) return apiErrorMessage(body, fallback);
  return fallback;
}
