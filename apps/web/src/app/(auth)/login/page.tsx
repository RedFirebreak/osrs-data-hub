/**
 * Login (handoff §12 "Login / not allowed"): the hub's name and one "Sign in with Discord" button.
 * A refused sign-in comes back as /login?error=<code> (lib/auth.ts, AUTH-6) and gets a clear
 * explanation (login-messages.ts). "Delete my data" (D-78) lands on /login?deleted=<date>, which
 * says when the data goes and that signing in cancels it (deleted-notice.ts; only a parsed date is
 * shown, never the parameter). Signed-in, active users go straight to the dashboard; an inactive
 * viewer counts as signed out here, or requireUser and this page would redirect in a loop.
 */
import { getConfig } from '@hub/core';
import { CalendarClockIcon, TriangleAlertIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { HubMark } from '@/components/shell/hub-mark';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getViewer } from '@/lib/session';
import { deletedNotice } from './deleted-notice';
import { loginErrorMessage } from './login-messages';
import { SignInButton } from './sign-in-button';

export function generateMetadata(): Metadata {
  return { title: `Sign in · ${getConfig().hubName}` };
}

export default async function LoginPage(props: PageProps<'/login'>) {
  const current = await getViewer();
  if (current && current.viewer.status === 'active') redirect('/');

  const { error, deleted } = await props.searchParams;
  const config = getConfig();
  const guildName = config.discord.guildName;
  const problem = loginErrorMessage(error, guildName);
  const deletion = deletedNotice(deleted);

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="justify-items-center text-center">
        <HubMark className="mb-2 size-10 rounded-xl [&_svg]:size-5" />
        {/* CardTitle is a div: the page's one heading is the h1 inside it. */}
        <CardTitle className="text-xl">
          <h1>{config.hubName}</h1>
        </CardTitle>
        <CardDescription className="text-balance">
          XP, loot and live events of {guildName}, sent by the HA Exporter RuneLite plugin.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {deletion && (
          <Alert role="status">
            <CalendarClockIcon aria-hidden />
            <AlertTitle>Deletion scheduled</AlertTitle>
            <AlertDescription>
              {deletion.when ? (
                <p>
                  Your data will be deleted on{' '}
                  <time dateTime={deletion.when.dateTime}>{deletion.when.label}</time>. Sign in
                  again before then to cancel.
                </p>
              ) : (
                <p>
                  Your data is scheduled for deletion. Sign in again before it happens to cancel.
                </p>
              )}
            </AlertDescription>
          </Alert>
        )}
        {problem && (
          <Alert variant="destructive">
            <TriangleAlertIcon aria-hidden />
            <AlertTitle>{problem.title}</AlertTitle>
            <AlertDescription>{problem.message}</AlertDescription>
          </Alert>
        )}
        <SignInButton />
        <p className="text-center text-xs text-balance text-muted-foreground">
          Only members of {guildName} can sign in. The hub reads your Discord name, avatar and
          server roles — never your email or messages.
        </p>
      </CardContent>
    </Card>
  );
}
