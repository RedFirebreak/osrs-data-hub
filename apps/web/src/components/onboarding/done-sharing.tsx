'use client';
/**
 * Who can see the account that was just paired, on the wizard's last step (D-96): the same
 * per-category controls as the account page's sharing panel (CategoryAudiences, useSharing), so an
 * owner sees what the guild gets from the start and can change it right there. The settings are
 * read once from GET /api/app/accounts/[publicId]/sharing; every change saves at once.
 */
import type { SharingSettings } from '@hub/server';
import { LoaderCircleIcon } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { accountHref } from '@/components/accounts/account-link';
import { CategoryAudiences } from '@/components/sharing/category-audiences';
import { useSharing } from '@/components/sharing/use-sharing';
import { headingOfSection } from '@/lib/focus';

export interface DoneSharingAccount {
  publicId: string;
  name: string;
}

type Loaded =
  { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; settings: SharingSettings };

/** The account page's sharing section. */
export function sharingHref(account: DoneSharingAccount): Route {
  return `${accountHref(account.publicId)}#sharing` as Route;
}

export function DoneSharing({ account }: { account: DoneSharingAccount }) {
  const id = useId();
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `/api/app/accounts/${encodeURIComponent(account.publicId)}/sharing`,
          {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        const body = (await res.json().catch(() => null)) as { sharing?: SharingSettings } | null;
        setLoaded(
          res.ok && body?.sharing ? { kind: 'ready', settings: body.sharing } : { kind: 'failed' },
        );
      } catch {
        if (!controller.signal.aborted) setLoaded({ kind: 'failed' });
      }
    })();
    return () => controller.abort();
  }, [account.publicId]);

  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-1">
      <h3 id={`${id}-heading`} className="font-semibold">
        Who can see {account.name}
      </h3>
      <p className="text-pretty text-muted-foreground">
        A new account shares everything with the guild. Change any of it here; it saves right away.
      </p>
      {loaded.kind === 'loading' && (
        <p className="flex items-center gap-2 py-3 text-muted-foreground" role="status">
          <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
          Loading the sharing settings…
        </p>
      )}
      {loaded.kind === 'failed' && (
        <p className="py-3 text-pretty" role="alert">
          The sharing settings couldn&apos;t be loaded here.{' '}
          <Link href={sharingHref(account)} className="font-medium underline underline-offset-4">
            Sharing settings for {account.name}
          </Link>
        </p>
      )}
      {loaded.kind === 'ready' && (
        <DoneSharingControls account={account} initial={loaded.settings} />
      )}
    </section>
  );
}

/** The controls once the settings are there, and the link to the rest (players, ownership). */
export function DoneSharingControls({
  account,
  initial,
}: {
  account: DoneSharingAccount;
  initial: SharingSettings;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const sharing = useSharing(account.publicId, initial, {
    // A control that went away with its change: the "Who can see …" heading above.
    focusFallback: () => headingOfSection(rootRef.current),
  });
  return (
    <div ref={rootRef} className="flex flex-col">
      <CategoryAudiences idPrefix={id} sharing={sharing} />
      <p className="text-xs text-muted-foreground">
        <Link href={sharingHref(account)} className="font-medium underline underline-offset-4">
          More sharing options for {account.name}
        </Link>
        : its players, and handing it to someone else.
      </p>
    </div>
  );
}
