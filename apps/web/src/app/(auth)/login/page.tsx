/**
 * Login (handoff §12 "Login / not allowed"): the hub's name and one "Sign in with Discord" button,
 * with who the page is for, where the sign-in happens and that the hub never asks for a game login,
 * so a visitor who doesn't belong here (or who checks whether this is a phishing page) can tell.
 * A refused sign-in comes back as /login?error=<code> (lib/auth.ts, AUTH-6) and gets a clear
 * explanation (login-messages.ts). "Delete my data" (D-78) lands on /login?deleted=<date>, which
 * says when the data goes and that signing in cancels it (deleted-notice.ts; only a parsed date is
 * shown, never the parameter). Signed-in, active users go straight to Home; an inactive
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
  const config = getConfig();
  return {
    title: `Sign in · ${config.hubName}`,
    description:
      `Sign-in for members of ${config.discord.guildName}: XP, loot and live events from the ` +
      'HA Exporter RuneLite plugin. You sign in with Discord; the hub never asks for a RuneScape ' +
      'or Jagex login.',
  };
}

export default async function LoginPage(props: PageProps<'/login'>) {
  const current = await getViewer();
  if (current && current.viewer.status === 'active') redirect('/');

  const { error, deleted } = await props.searchParams;
  const config = getConfig();
  const guildName = config.discord.guildName;
  const problem = loginErrorMessage(error, guildName);
  const deletion = deletedNotice(deleted);
  // Where the button sends the browser: Discord, or the stand-in of local development (D-101).
  const signInHost = config.discord.authorizeUrl
    ? new URL(config.discord.authorizeUrl).host
    : 'discord.com';

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
        <p className="text-center text-sm text-balance">
          <strong className="font-medium">For members of {guildName} only.</strong> Sign in with the
          Discord account you use in its Discord server. If you&apos;re not in that server, you
          can&apos;t sign in here.
        </p>
        <SignInButton />
        <div className="flex flex-col gap-2 text-center text-xs text-balance text-muted-foreground">
          <p>
            You sign in at {signInHost}. The hub reads your Discord name, avatar and server roles —
            never your email or messages.
          </p>
          <p>
            The hub never asks for your RuneScape or Jagex login. Sharing game data is opt-in only:
            nothing is sent until you install the HA Exporter plugin in RuneLite and pair it with a
            code after signing in.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
