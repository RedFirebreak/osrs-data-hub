'use client';
/**
 * "Revoke" for one device, behind a confirmation dialog (handoff §6.3, ConfirmAction): DELETE
 * /api/app/devices/[id]. The token stops working at once; the plugin disables the connection when
 * its next send is answered 401 (handoff §3.2). The dialog stays open (and says why) when the
 * request fails. After a revoke the card moves to "Revoked devices", taking this button with it: the
 * focus goes to the heading of the section it was in, not to <body>. A device that was already
 * revoked elsewhere (404) leaves the connected list as well (deviceFailure).
 */
import { BanIcon } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmAction } from '@/components/common/confirm-action';
import { deviceApiPath, deviceFailure } from './device-model';

export interface RevokeDeviceButtonProps {
  deviceId: string;
  /** The device's display name. */
  name: string;
}

export function RevokeDeviceButton({ deviceId, name }: RevokeDeviceButtonProps) {
  return (
    <ConfirmAction
      variant="destructive"
      srSuffix={name}
      title={`Revoke ${name}?`}
      description="The hub stops accepting data from this RuneLite connection right away, and the HA Exporter plugin disables the connection the next time it sends data. To send data from this computer again, pair it with a new code."
      confirmLabel="Revoke device"
      request={{ path: deviceApiPath(deviceId), method: 'DELETE' }}
      failure={deviceFailure('revoke')}
      onDone={() =>
        toast.success(`${name} revoked`, {
          description: 'The plugin disables this connection the next time it sends data.',
        })
      }
    >
      <BanIcon aria-hidden data-icon="inline-start" />
      Revoke
    </ConfirmAction>
  );
}
