/**
 * 404 for unknown URLs and for notFound() anywhere below the root (e.g. an account the viewer may not
 * see, or an admin page for a non-admin — both deliberately indistinguishable from "doesn't exist").
 */
import { CompassIcon } from 'lucide-react';
import Link from 'next/link';
import { StatusPage } from '@/components/common/status-page';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <StatusPage
      standalone
      icon={CompassIcon}
      eyebrow="404"
      title="Page not found"
      actions={
        <Button asChild>
          <Link href="/">Go to the dashboard</Link>
        </Button>
      }
    >
      This page doesn&apos;t exist, or it isn&apos;t shared with you. If someone sent you a link to
      an account, its owner may have made it private.
    </StatusPage>
  );
}
