'use client';
/**
 * "View" for one archived payload in the raw payload viewer (handoff §12): opens a dialog that
 * fetches the body from GET /api/app/admin/raw-payloads/[id]?receivedAt=… and shows it
 * pretty-printed (prettyPayload, which also decodes Gson's '-style escapes, PLUGIN-7), or as
 * stored when it isn't valid JSON. Bodies can hold coordinates and inventories: the dialog says so,
 * the view is audited by the server, and nothing here logs or caches the body beyond the open dialog.
 */
import { FileJsonIcon, LoaderCircleIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { CopyButton } from '@/components/common/copy-button';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { failureMessage, refreshesPage, sendJson, type FailureOptions } from '@/lib/api-client';
import { adminFailure, prettyPayload, rawPayloadApiPath } from './admin-model';

export interface RawPayloadDialogProps {
  id: string;
  /** received_at, ISO (half of the primary key). */
  receivedAt: string;
  /** What the dialog's title names, e.g. the device and time. */
  title: string;
}

const LOAD_FAILURE: FailureOptions = {
  ...adminFailure("Couldn't load the payload. Try again."),
  notFound: 'This payload is no longer archived: raw payloads are deleted after a few days.',
};

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; text: string; json: boolean }
  | { kind: 'error'; message: string };

export function RawPayloadDialog({ id, receivedAt, title }: RawPayloadDialogProps) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'idle' });
  // Bumped by every load and close: a response that arrives after either is dropped.
  const generation = useRef(0);

  async function load(): Promise<void> {
    const mine = ++generation.current;
    setState({ kind: 'loading' });
    const res = await sendJson(rawPayloadApiPath(id, receivedAt));
    if (mine !== generation.current) return;
    const text = (res.body as { payload?: { body?: unknown } } | null)?.payload?.body;
    if (res.ok && typeof text === 'string') {
      setState({ kind: 'loaded', ...prettyPayload(text) });
      return;
    }
    setState({ kind: 'error', message: failureMessage(res.status, res.body, LOAD_FAILURE) });
    if (refreshesPage(res.status, LOAD_FAILURE)) router.refresh();
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        // Forget the body when the dialog closes; fetch it again (and audit the view) on reopen.
        if (open) {
          void load();
        } else {
          generation.current += 1;
          setState({ kind: 'idle' });
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <FileJsonIcon aria-hidden data-icon="inline-start" />
          View<span className="sr-only"> payload {title}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Raw payload</DialogTitle>
          <DialogDescription>
            {title}. It can contain locations and inventories the player shares with nobody; viewing
            it is recorded in the audit log.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {state.kind === 'loading' || state.kind === 'idle' ? (
            <div role="status" aria-label="Loading the payload" className="flex flex-col gap-2">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
                Loading…
              </span>
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-4" style={{ width: `${90 - i * 12}%` }} />
              ))}
            </div>
          ) : state.kind === 'error' ? (
            <div className="flex flex-col items-start gap-2">
              <p role="alert" className="text-sm text-destructive">
                {state.message}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {state.json ? 'Pretty-printed JSON' : 'Not valid JSON: shown exactly as received'}
                </span>
                <CopyButton value={state.text} what="payload" />
              </div>
              {/* Focusable, so the keyboard can scroll a long or wide body (not every browser
                  makes scroll containers focusable by itself). */}
              <pre
                tabIndex={0}
                role="region"
                aria-label="Payload body"
                className="min-h-0 flex-1 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {state.text}
              </pre>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
