'use client';
/**
 * "Revoke" for one API key, behind a confirmation dialog (D-76): DELETE /api/app/api-keys/[id]. The
 * next request with the key gets 401. The dialog stays open (and says why) when the request fails.
 * After a revoke the key moves to "Revoked and expired keys", taking this button with it: the focus
 * goes to the heading of the section it was in (useFocusReturn), not to <body>.
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
import { apiKeyPath, revokeFailureMessage } from './api-key-model';

export interface RevokeApiKeyButtonProps {
  keyId: string;
  name: string;
}

export function RevokeApiKeyButton({ keyId, name }: RevokeApiKeyButtonProps) {
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
      const res = await fetch(apiKeyPath(keyId), { method: 'DELETE', credentials: 'same-origin' });
      if (res.ok) {
        focusReturn.set(headingOfSection(triggerRef.current), mainHeading);
        setOpen(false);
        toast.success(`${name} revoked`, {
          description: 'Apps using this key get 401 from now on.',
        });
        router.refresh();
        return;
      }
      const body: unknown = await res.json().catch(() => null);
      setError(revokeFailureMessage(res.status, body));
      if (res.status === 401 || res.status === 404) router.refresh();
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
            Every app using this key loses access right away: its requests are answered 401. This
            can&apos;t be undone; create a new key to give an app access again.
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
            Revoke key
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
