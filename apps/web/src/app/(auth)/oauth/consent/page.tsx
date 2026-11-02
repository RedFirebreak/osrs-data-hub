/**
 * The consent page of an MCP client's sign-in (D-137): Claude.ai, or another assistant that connects
 * by signing in, asks to read the hub as the member. The page says who asks, where the browser goes
 * afterwards, and exactly what the key it would get reads (the AI assistant categories, every account
 * the member can see), and that the key shows on the API keys page, where it can be edited or
 * revoked. Better Auth's OAuth provider sends the browser here with the request signed; a request
 * that isn't signed by this hub, or has expired, gets an explanation instead of buttons.
 */
import { AI_ASSISTANT_CATEGORIES, CATEGORY_LABELS, getConfig } from '@hub/core';
import { getDb } from '@hub/db';
import { OAUTH_KEY_FALLBACK_NAME } from '@hub/server';
import { PlugIcon, TriangleAlertIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { HubMark } from '@/components/shell/hub-mark';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { oauthQueryOf, readConsentRequest } from '@/lib/mcp/consent';
import { requireUser } from '@/lib/session';
import { ConsentButtons } from './consent-buttons';

export function generateMetadata(): Metadata {
  return { title: `Connect an assistant · ${getConfig().hubName}` };
}

export default async function ConsentPage(props: PageProps<'/oauth/consent'>) {
  await requireUser();
  const config = getConfig();
  const request = await readConsentRequest(getDb().db, oauthQueryOf(await props.searchParams));

  if (!request) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            <h1>This link has expired</h1>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <TriangleAlertIcon aria-hidden />
            <AlertTitle>Nothing was connected</AlertTitle>
            <AlertDescription>
              Start connecting again from your assistant. A connection request is only valid for a
              few minutes, and only when it came from this hub.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const name = request.client.name?.trim() || OAUTH_KEY_FALLBACK_NAME;
  return (
    <Card className="w-full max-w-md">
      <CardHeader className="justify-items-center text-center">
        <div className="mb-2 flex items-center gap-2 text-muted-foreground">
          <HubMark className="size-10 rounded-xl [&_svg]:size-5" />
          <PlugIcon aria-hidden className="size-4" />
        </div>
        <CardTitle className="text-xl">
          <h1>Connect {name}?</h1>
        </CardTitle>
        <CardDescription className="text-balance">
          {name} wants to read {config.hubName} as you, to answer your questions about the guild. It
          can&apos;t change anything.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <div>
          <p className="font-medium">It will read</p>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {AI_ASSISTANT_CATEGORIES.map((c) => (
              <li key={c}>
                <span className="text-foreground">{CATEGORY_LABELS[c].label}</span>:{' '}
                {CATEGORY_LABELS[c].covers}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-muted-foreground">
            On every account you can see, and only what the owners share with you.
          </p>
        </div>
        <p className="text-muted-foreground">
          This adds a key named &ldquo;{name}&rdquo; to your API keys page. Change what it reads
          there, or revoke it to disconnect {name}.
        </p>
        <ConsentButtons oauthQuery={request.oauthQuery} />
        {request.redirectHost && (
          <p className="text-center text-xs text-muted-foreground">
            Afterwards you go back to <span className="font-medium">{request.redirectHost}</span>.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
