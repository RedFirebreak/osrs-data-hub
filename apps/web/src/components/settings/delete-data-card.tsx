'use client';
/**
 * Settings → "Delete my data" (D-78): what happens, in plain words, and a destructive button that
 * opens a dialog where the user types the confirmation word ("delete", handed down by the page
 * from @hub/server) to enable the confirm button. The request is POST /api/app/me/delete; on
 * success the browser loads /login?deleted=<graceUntil> in full (the session is gone, so nothing of
 * the signed-in app may stay on screen); on failure the dialog stays open with the reason (inline
 * and as a toast).
 */
import { LoaderCircleIcon, Trash2Icon } from 'lucide-react';
import { useId, useRef, useState } from 'react';
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { sendJson } from '@/lib/api-client';
import {
  confirmsDeletion,
  deleteErrorMessage,
  deletedLoginPath,
  graceUntilFrom,
} from './data-rights-model';

export interface DeleteDataCardProps {
  /** Days until the hard delete (SELF_DELETE_UNDO_DAYS). */
  undoDays: number;
  /** "6 October 2026": today + undoDays in the user's time zone. */
  deleteOnLabel: string;
  /** The same moment as ISO, for <time dateTime>. */
  deleteOnIso: string;
  /** The word to type (SELF_DELETE_CONFIRMATION), as the server compares it. */
  confirmationWord: string;
}

export function DeleteDataCard({
  undoDays,
  deleteOnLabel,
  deleteOnIso,
  confirmationWord,
}: DeleteDataCardProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmed = confirmsDeletion(typed, confirmationWord);
  const deleteOn = <time dateTime={deleteOnIso}>{deleteOnLabel}</time>;

  async function submit(): Promise<void> {
    if (!confirmed || pending) return;
    setPending(true);
    setError(null);
    const res = await sendJson('/api/app/me/delete', { method: 'POST', json: { confirm: typed } });
    const graceUntil = res.ok ? graceUntilFrom(res.body) : null;
    if (graceUntil !== null) {
      // A full page load: the session is gone and no signed-in page may stay on screen. The dialog
      // stays pending until it arrives.
      window.location.assign(deletedLoginPath(graceUntil));
      return;
    }
    const message = deleteErrorMessage(res.status, res.body);
    setError(message);
    toast.error(message);
    setPending(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Delete my data</h2>
        </CardTitle>
        <CardDescription>
          Removes you and your data from the hub, with {undoDays} days to change your mind.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <ul className="ml-5 list-disc space-y-1.5">
          <li>Your devices and API keys stop working at once, and you are signed out.</li>
          <li>
            Accounts you own pass to the player who has played them with you the longest. Accounts
            nobody else plays are hidden.
          </li>
          <li>
            On {deleteOn} your user, devices and settings are deleted for good, together with the
            data of accounts no other member plays. Accounts that passed to someone else keep their
            history.
          </li>
          <li>
            Signing in again before then cancels it. Your devices then have to be paired again.
          </li>
        </ul>
        <p className="text-muted-foreground">Want a copy first? Download your data above.</p>
        <AlertDialog
          open={open}
          onOpenChange={(next) => {
            if (pending) return;
            setOpen(next);
            setTyped('');
            setError(null);
          }}
        >
          <AlertDialogTrigger asChild>
            <Button type="button" variant="destructive" className="w-fit">
              <Trash2Icon aria-hidden data-icon="inline-start" />
              Delete my data
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent
            onOpenAutoFocus={(e) => {
              // Straight to the confirmation field (the only way on is typing the word).
              e.preventDefault();
              inputRef.current?.focus();
            }}
          >
            <form
              className="contents"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <AlertDialogHeader>
                <AlertDialogTitle>Delete your data?</AlertDialogTitle>
                <AlertDialogDescription>
                  Your devices and API keys stop working and you are signed out right away.
                  Everything is deleted on {deleteOn} unless you sign in again before then.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-confirm`}>
                  Type <span className="font-mono font-semibold">{confirmationWord}</span> to
                  confirm
                </Label>
                <Input
                  ref={inputRef}
                  id={`${id}-confirm`}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={pending}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `${id}-error` : undefined}
                />
                {error && (
                  <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel type="button" disabled={pending}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  type="submit"
                  variant="destructive"
                  disabled={!confirmed || pending}
                  onClick={(e) => {
                    // The form's submit handler sends the request; the dialog stays open meanwhile.
                    e.preventDefault();
                    void submit();
                  }}
                >
                  {pending && <LoaderCircleIcon aria-hidden className="animate-spin" />}
                  {pending ? 'Deleting…' : 'Delete my data'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </form>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
