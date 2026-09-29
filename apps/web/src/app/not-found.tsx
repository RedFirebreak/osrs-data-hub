/**
 * 404 for unknown URLs and for notFound() anywhere below the root (e.g. an account the viewer may not
 * see, or an admin page for a non-admin — both deliberately indistinguishable from "doesn't exist").
 */
import { CompassIcon } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main
      id="main"
      className="flex min-h-[60dvh] flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center"
    >
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
          This page doesn&apos;t exist, or it isn&apos;t shared with you. If someone sent you a link
          to an account, its owner may have made it private.
        </p>
      </div>
      <Button asChild>
        <Link href="/">Go to the dashboard</Link>
      </Button>
    </main>
  );
}
