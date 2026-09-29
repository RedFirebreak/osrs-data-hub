'use client';
/** "Sign in with Discord": starts Better Auth's Discord flow; the browser leaves for Discord. */
import { LoaderCircleIcon, LogInIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { signInWithDiscord } from '@/lib/auth-client';

/** Re-enable the button if the browser hasn't left the page after this long (sign-in didn't start). */
const STUCK_AFTER_MS = 8_000;

export function SignInButton() {
  const [pending, setPending] = useState(false);

  async function start(): Promise<void> {
    setPending(true);
    try {
      await signInWithDiscord('/');
      // Normally the browser is on its way to Discord now; if not, let the user try again.
      setTimeout(() => setPending(false), STUCK_AFTER_MS);
    } catch {
      setPending(false);
      toast.error("Couldn't start the sign-in. Check your connection and try again.");
    }
  }

  return (
    <Button
      size="lg"
      className="h-11 w-full text-base"
      disabled={pending}
      onClick={() => void start()}
    >
      {pending ? (
        <LoaderCircleIcon aria-hidden className="animate-spin" />
      ) : (
        <LogInIcon aria-hidden />
      )}
      {pending ? 'Opening Discord…' : 'Sign in with Discord'}
    </Button>
  );
}
