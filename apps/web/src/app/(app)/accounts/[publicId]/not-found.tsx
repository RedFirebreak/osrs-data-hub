/**
 * An account that doesn't exist or isn't visible to the viewer (the two are deliberately the same
 * answer, handoff §10). Rendered inside the signed-in layout's <main>.
 */
import { UserRoundXIcon } from 'lucide-react';
import Link from 'next/link';
import { StatusPage } from '@/components/common/status-page';
import { Button } from '@/components/ui/button';

export default function AccountNotFound() {
  return (
    <StatusPage
      icon={UserRoundXIcon}
      title="Account not found"
      actions={
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link href="/guild">Browse the guild</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/">Your dashboard</Link>
          </Button>
        </div>
      }
    >
      This account doesn&apos;t exist, or its owner doesn&apos;t share it with you. Accounts appear
      on the hub once a guild member&apos;s RuneLite reports them.
    </StatusPage>
  );
}
