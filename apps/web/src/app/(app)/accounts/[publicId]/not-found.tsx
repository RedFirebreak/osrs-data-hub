/**
 * An account that doesn't exist or isn't visible to the viewer (the two are deliberately the same
 * answer, handoff §10). Rendered inside the signed-in layout's <main>.
 */
import { UserRoundXIcon } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function AccountNotFound() {
  return (
    <div className="flex min-h-[50dvh] flex-col items-center justify-center gap-4 px-4 py-12 text-center">
      <span
        aria-hidden
        className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <UserRoundXIcon className="size-6" />
      </span>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Account not found</h1>
        <p className="max-w-md text-sm text-balance text-muted-foreground">
          This account doesn&apos;t exist, or its owner doesn&apos;t share it with you. Accounts
          appear on the hub once a guild member&apos;s RuneLite reports them.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild>
          <Link href="/guild">Browse the guild</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/">Your dashboard</Link>
        </Button>
      </div>
    </div>
  );
}
