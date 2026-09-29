/**
 * API keys (handoff §12/§13, D-69, D-76): the signed-in user's keys for the public API — active ones
 * with Revoke, then revoked and expired ones — and "Create key". Explains what keys are for, that
 * access follows the owners' sharing settings on every request, and links to the API reference.
 * Without keys: an empty state with the same call to action.
 */
import { CATEGORIES, getConfig } from '@hub/core';
import { getDb } from '@hub/db';
import {
  API_KEY_NAME_MAX,
  MAX_ACTIVE_KEYS,
  getUserSettings,
  listApiKeys,
  loadVisibleAccounts,
  type ApiKeyInfo,
} from '@hub/server';
import { BookOpenIcon, KeyRoundIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ApiKeyCard } from '@/components/api-keys/api-key-card';
import {
  CreateApiKeyDialog,
  type PickableAccount,
} from '@/components/api-keys/create-api-key-dialog';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUser } from '@/lib/session';

export function generateMetadata(): Metadata {
  return { title: `API keys · ${getConfig().hubName}` };
}

export default async function ApiKeysPage() {
  const { user, viewer } = await requireUser();
  const { db } = getDb();
  const keys = await listApiKeys(db, user.id);
  // The accounts a 'list' key may name: what the user can see right now, without the admin override
  // (a restricted load never applies it, exactly as createApiKey checks, D-70).
  const visible = await loadVisibleAccounts(db, viewer, {
    categories: new Set(CATEGORIES),
    accountIds: null,
  });
  const accounts: PickableAccount[] = visible
    .map((e) => ({ publicId: e.account.publicId, name: e.account.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  const { timezone } = await getUserSettings(db, user.id);
  const now = new Date().toISOString();
  const active = keys.filter((k) => k.status === 'active');
  const inactive = keys.filter((k) => k.status !== 'active');
  const atLimit = active.length >= MAX_ACTIVE_KEYS;
  const dialog = {
    accounts,
    nameMax: API_KEY_NAME_MAX,
    atLimit,
    apiBase: `${getConfig().appOrigin}/api/v1`,
    listHeadingId: headingIdOf(ACTIVE_KEYS_TITLE),
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <PageHeader
        title="API keys"
        description="Let your own apps read hub data: each app gets a key of its own."
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/docs/api">
                <BookOpenIcon aria-hidden data-icon="inline-start" />
                API reference
              </Link>
            </Button>
            {keys.length > 0 && <CreateApiKeyDialog {...dialog} />}
          </>
        }
      />

      <Card>
        <CardContent className="flex flex-col gap-2 text-sm text-pretty">
          <p>
            A key lets an app such as a <strong>Home Assistant</strong> integration, a{' '}
            <strong>Discord bot</strong> or a <strong>live map</strong> read the hub&apos;s public
            API. It reads only the categories you choose, and never more than you can see yourself:
            the owners&apos; sharing settings are checked on every request, so when someone stops
            sharing with you, your keys stop seeing it at once.
          </p>
          <p className="text-muted-foreground">
            Treat a key like a password. Every endpoint, with examples, is in the{' '}
            <Link href="/docs/api" className="font-medium underline underline-offset-4">
              API reference
            </Link>
            .
          </p>
        </CardContent>
      </Card>

      {keys.length === 0 ? (
        <EmptyKeys dialog={<CreateApiKeyDialog {...dialog} size="lg" />} />
      ) : (
        <>
          <KeySection
            title={ACTIVE_KEYS_TITLE}
            count={`${active.length} of ${MAX_ACTIVE_KEYS}`}
            keys={active}
            now={now}
            timezone={timezone}
            empty="No active keys. Create one to give an app access."
            note={
              atLimit
                ? `You have ${MAX_ACTIVE_KEYS} active keys, the most allowed. Revoke one to create another.`
                : undefined
            }
          />
          {inactive.length > 0 && (
            <KeySection
              title="Revoked and expired keys"
              count={String(inactive.length)}
              keys={inactive}
              now={now}
              timezone={timezone}
            />
          )}
        </>
      )}
    </div>
  );
}

const ACTIVE_KEYS_TITLE = 'Active keys';

/** A section heading's id, from its title ("Active keys" → "active-keys"). */
function headingIdOf(title: string): string {
  return title.toLowerCase().replace(/\s+/g, '-');
}

function KeySection({
  title,
  count,
  keys,
  now,
  timezone,
  empty,
  note,
}: {
  title: string;
  count: string;
  keys: ApiKeyInfo[];
  now: string;
  timezone: string;
  empty?: string;
  note?: string;
}) {
  const headingId = headingIdOf(title);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold">
        {title} <span className="font-normal text-muted-foreground">({count})</span>
      </h2>
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
      {keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {keys.map((key) => (
            <li key={key.id}>
              <ApiKeyCard apiKey={key} now={now} timezone={timezone} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EmptyKeys({ dialog }: { dialog: React.ReactNode }) {
  return (
    <Card className="items-center px-4 py-10 text-center">
      <span
        aria-hidden
        className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <KeyRoundIcon className="size-6" />
      </span>
      <CardHeader className="w-full justify-items-center">
        <CardTitle className="text-lg">
          <h2>No API keys yet</h2>
        </CardTitle>
        <CardDescription className="max-w-prose text-balance">
          Create a key, choose what it may read, and paste it into your app. You see the key once,
          right after creating it.
        </CardDescription>
      </CardHeader>
      <CardContent>{dialog}</CardContent>
    </Card>
  );
}
