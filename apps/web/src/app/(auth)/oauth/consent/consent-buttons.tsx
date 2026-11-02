'use client';
/** Allow or Deny on the consent page (D-137): the hub answers where the browser goes next. */
import { LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { failureMessage, sendJson } from '@/lib/api-client';

export function ConsentButtons({ oauthQuery }: { oauthQuery: string }) {
  const [pending, setPending] = useState<'allow' | 'deny' | null>(null);

  async function answer(accept: boolean): Promise<void> {
    setPending(accept ? 'allow' : 'deny');
    const res = await sendJson('/api/app/oauth/consent', {
      method: 'POST',
      json: { oauthQuery, accept },
    });
    const url = (res.body as { url?: unknown } | null)?.url;
    if (res.ok && typeof url === 'string') {
      window.location.assign(url);
      return;
    }
    setPending(null);
    toast.error(
      failureMessage(res.status, res.body, {
        fallback: "Couldn't connect the assistant. Try again in a moment.",
        conflict: 'You have too many active API keys. Revoke one on the API keys page first.',
      }),
    );
  }

  return (
    <div className="flex gap-2">
      <Button
        variant="outline"
        className="flex-1"
        disabled={pending !== null}
        onClick={() => void answer(false)}
      >
        {pending === 'deny' && <LoaderCircleIcon aria-hidden className="animate-spin" />}
        Deny
      </Button>
      <Button className="flex-1" disabled={pending !== null} onClick={() => void answer(true)}>
        {pending === 'allow' && <LoaderCircleIcon aria-hidden className="animate-spin" />}
        Allow
      </Button>
    </div>
  );
}
