/**
 * notFound() in the signed-in part of the hub (an admin page for a non-admin, say: deliberately the
 * same answer as "doesn't exist"). Rendered inside the signed-in layout, so the header and navigation
 * stay; unknown URLs and signed-out visitors get the root not-found page.
 */
import { CompassIcon } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function AppNotFound() {
  return (
    <div className="flex min-h-[50dvh] flex-col items-center justify-center gap-4 px-4 py-12 text-center">
      <span
        aria-hidden
        className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <CompassIcon className="size-6" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-muted-foreground">404</p>
        <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="max-w-md text-sm text-balance text-muted-foreground">
          This page doesn&apos;t exist, or it isn&apos;t shared with you.
        </p>
      </div>
      <Button asChild>
        <Link href="/">Go to the dashboard</Link>
      </Button>
    </div>
  );
}
