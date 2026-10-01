'use client';
/**
 * Error boundary for every page below the root layout. In production a server error reaches the
 * browser as a generic message plus a `digest` that matches the server log line, so the digest is
 * shown for reporting; the message itself is never shown (it could carry internals).
 */
import { RotateCwIcon, TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { StatusPage } from '@/components/common/status-page';
import { Button } from '@/components/ui/button';

export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <StatusPage
      standalone
      alert
      icon={TriangleAlertIcon}
      tone="destructive"
      title="Something went wrong"
      actions={
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => retry()}>
            <RotateCwIcon aria-hidden data-icon="inline-start" />
            Try again
          </Button>
          <Button asChild variant="outline">
            <Link href="/">Go to the dashboard</Link>
          </Button>
        </div>
      }
    >
      The hub couldn&apos;t load this page. This is usually temporary: try again in a moment. If it
      keeps happening, tell an admin
      {error.digest ? (
        <>
          {' '}
          and mention the code <code className="font-mono text-foreground">{error.digest}</code>
        </>
      ) : null}
      .
    </StatusPage>
  );
}
