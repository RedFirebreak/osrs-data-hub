'use client';
/**
 * A button that runs one admin mutation behind a confirmation dialog (offboard, restore, revoke):
 * the dialog explains the consequences, stays open while the request runs and when it fails (with
 * the reason), and on success closes, calls `onDone` with the response body (for a toast) and
 * refreshes the server components so the table shows the new state. The refresh can take the button
 * away (Restore turns into Offboard, a revoked device leaves the Active filter), so after a success
 * the focus goes to the heading of the section the button was in (useFocusReturn), not to <body>.
 */
import { LoaderCircleIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
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
import { useApiRequest } from '@/lib/use-api-request';
import { adminFailure } from './admin-model';

export interface ConfirmActionProps {
  /** The trigger button's content (icon + visible text). */
  children: React.ReactNode;
  /** Appended to the trigger's accessible name, e.g. the user's name ("Offboard Alice"). */
  srSuffix?: string;
  variant?: 'destructive' | 'outline';
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  request: { path: string; method: 'POST' | 'PUT' | 'DELETE'; json?: unknown };
  /** Error text when the hub gives no better one. */
  failure: string;
  onDone?: (body: unknown) => void;
}

export function ConfirmAction({
  children,
  srSuffix,
  variant = 'outline',
  title,
  description,
  confirmLabel,
  request,
  failure,
  onDone,
}: ConfirmActionProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { pending, error, setError, send } = useApiRequest();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const focusReturn = useFocusReturn();

  async function confirm(): Promise<void> {
    const res = await send(request.path, request, adminFailure(failure));
    if (!res.ok) return;
    focusReturn.set(headingOfSection(triggerRef.current), mainHeading);
    setOpen(false);
    onDone?.(res.body);
    router.refresh();
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
        <Button ref={triggerRef} type="button" variant={variant} size="sm">
          {children}
          {srSuffix && <span className="sr-only"> {srSuffix}</span>}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent onCloseAutoFocus={focusReturn.onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">{description}</div>
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
            variant={variant === 'destructive' ? 'destructive' : 'default'}
            disabled={pending}
            onClick={(e) => {
              // Keep the dialog open until the request is done (it closes itself on success).
              e.preventDefault();
              void confirm();
            }}
          >
            {pending && <LoaderCircleIcon aria-hidden className="animate-spin" />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
