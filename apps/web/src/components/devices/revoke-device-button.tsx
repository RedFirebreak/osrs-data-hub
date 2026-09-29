'use client';
/**
 * "Revoke" for one device, behind a confirmation dialog (handoff §6.3): DELETE /api/app/devices/[id].
 * The token stops working at once; the plugin disables the connection when its next send is answered
 * 401 (handoff §3.2). The dialog stays open (and says why) when the request fails. After a revoke the
 * card moves to "Revoked devices", taking this button with it: the focus goes to the heading of the
 * section it was in (useFocusReturn), not to <body>.
 */
import { BanIcon, LoaderCircleIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { headingOfSection, mainHeading, useFocusReturn } from '@/lib/focus';
import { deviceApiPath, deviceFailureMessage } from './device-model';

export interface RevokeDeviceButtonProps {
  deviceId: string;
  /** The device's display name. */
  name: string;
}

export function RevokeDeviceButton({ deviceId, name }: RevokeDeviceButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const focusReturn = useFocusReturn();

  async function revoke(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(deviceApiPath(deviceId), {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (res.ok) {
        focusReturn.set(headingOfSection(triggerRef.current), mainHeading);
        setOpen(false);
        toast.success(`${name} revoked`, {
          description: 'The plugin disables this connection the next time it sends data.',
        });
        router.refresh();
        return;
      }
      const body: unknown = await res.json().catch(() => null);
      setError(deviceFailureMessage(res.status, body, 'revoke'));
      if (res.status === 401) router.refresh();
    } catch {
      setError("Couldn't reach the hub. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        setError(null);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button ref={triggerRef} type="button" variant="destructive" size="sm">
          <BanIcon aria-hidden data-icon="inline-start" />
          Revoke<span className="sr-only"> {name}</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent onCloseAutoFocus={focusReturn.onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The hub stops accepting data from this RuneLite connection right away, and the HA
            Exporter plugin disables the connection the next time it sends data. To send data from
            this computer again, pair it with a new code.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(e) => {
              // Keep the dialog open until the request is done (it closes itself on success).
              e.preventDefault();
              void revoke();
            }}
          >
            {pending && <LoaderCircleIcon aria-hidden className="animate-spin" />}
            Revoke device
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
