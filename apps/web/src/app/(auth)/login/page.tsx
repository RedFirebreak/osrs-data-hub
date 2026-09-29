/**
 * Login (handoff §12 "Login / not allowed"): the hub's name and one "Sign in with Discord" button.
 * A refused sign-in comes back as /login?error=<code> (lib/auth.ts, AUTH-6) and gets a clear
 * explanation (login-messages.ts). Signed-in, active users go straight to the dashboard; an inactive
 * viewer counts as signed out here, or requireUser and this page would redirect in a loop.
 */
import { getConfig } from '@hub/core';
import { TriangleAlertIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { HubMark } from '@/components/shell/hub-mark';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getViewer } from '@/lib/session';
import { loginErrorMessage } from './login-messages';
import { SignInButton } from './sign-in-button';

export function generateMetadata(): Metadata {
  return { title: `Sign in · ${getConfig().hubName}` };
}

export default async function LoginPage(props: PageProps<'/login'>) {
  const current = await getViewer();
  if (current && current.viewer.status === 'active') redirect('/');

  const { error } = await props.searchParams;
  const config = getConfig();
  const guildName = config.discord.guildName;
  const problem = loginErrorMessage(error, guildName);

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="justify-items-center text-center">
        <HubMark className="mb-2 size-10 rounded-xl [&_svg]:size-5" />
        <CardTitle className="text-xl">{config.hubName}</CardTitle>
        <CardDescription className="text-balance">
          XP, loot and live events of {guildName}, sent by the HA Exporter RuneLite plugin.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
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
