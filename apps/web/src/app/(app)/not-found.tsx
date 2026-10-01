/**
 * notFound() in the signed-in part of the hub (an admin page for a non-admin, say: deliberately the
 * same answer as "doesn't exist"). Rendered inside the signed-in layout, so the header and navigation
 * stay; unknown URLs and signed-out visitors get the root not-found page.
 */
import { CompassIcon } from 'lucide-react';
import Link from 'next/link';
import { StatusPage } from '@/components/shell/status-page';
import { Button } from '@/components/ui/button';

export default function AppNotFound() {
  return (
    <StatusPage
      icon={CompassIcon}
      eyebrow="404"
      title="Page not found"
      actions={
        <Button asChild>
          <Link href="/">Go to the dashboard</Link>
        </Button>
      }
    >
      This page doesn&apos;t exist, or it isn&apos;t shared with you.
    </StatusPage>
  );
}
