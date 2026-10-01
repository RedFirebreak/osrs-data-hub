'use client';
/**
 * "Revoke" for any user's device on the admin Devices page (handoff §12): DELETE
 * /api/app/admin/devices/[id] (reason 'admin'). The device's owner sees "Revoked by an admin" on
 * their Devices page; the plugin disables the connection at its next send (401, handoff §3.2).
 */
import { BanIcon } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmAction } from '@/components/common/confirm-action';
import { adminDevicePath, adminFailure } from './admin-model';

export interface AdminRevokeDeviceButtonProps {
  deviceId: string;
  /** The device's display name. */
  name: string;
  /** Its owner's display name. */
  owner: string;
}

export function AdminRevokeDeviceButton({ deviceId, name, owner }: AdminRevokeDeviceButtonProps) {
  return (
    <ConfirmAction
      variant="destructive"
      srSuffix={`${name} of ${owner}`}
      title={`Revoke ${name}?`}
      description={
        <>
          <p>
            The hub stops accepting data from this RuneLite connection of {owner} right away, and
            the HA Exporter plugin disables it the next time it sends data.
          </p>
          <p>
            {owner} can pair the computer again with a new code; their Devices page shows that an
            admin revoked this one.
          </p>
        </>
      }
      confirmLabel="Revoke device"
      request={{ path: adminDevicePath(deviceId), method: 'DELETE' }}
      failure={adminFailure("Couldn't revoke the device. Try again in a moment.")}
      onDone={() => toast.success(`${name} revoked`)}
    >
      <BanIcon aria-hidden data-icon="inline-start" />
      Revoke
    </ConfirmAction>
  );
}
