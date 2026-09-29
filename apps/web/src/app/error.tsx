'use client';
/**
 * Error boundary for every page below the root layout. In production a server error reaches the
 * browser as a generic message plus a `digest` that matches the server log line, so the digest is
 * shown for reporting; the message itself is never shown (it could carry internals).
 */
import { RotateCwIcon, TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main
      id="main"
      role="alert"
      className="flex min-h-[60dvh] flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center"
    >
      <span
        aria-hidden
        className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive"
      >
        <TriangleAlertIcon className="size-6" />
      </span>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="max-w-md text-sm text-balance text-muted-foreground">
          The hub couldn&apos;t load this page. This is usually temporary: try again in a moment. If
          it keeps happening, tell an admin
          {error.digest ? (
            <>
              {' '}
              and mention the code <code className="font-mono text-foreground">{error.digest}</code>
            </>
          ) : null}
          .
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={() => retry()}>
          <RotateCwIcon aria-hidden data-icon="inline-start" />
          Try again
        </Button>
        <Button asChild variant="outline">
          <Link href="/">Go to the dashboard</Link>
        </Button>
      </div>
    </main>
  );
}
