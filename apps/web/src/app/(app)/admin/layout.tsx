/**
 * The admin area (handoff §12 Admin): heading and section tabs above each admin page. requireAdmin
 * answers 404 to everyone else (admin pages don't admit they exist); every page calls it too, since
 * a layout isn't re-rendered on client navigation.
 */
import { AdminNav } from '@/components/admin/admin-nav';
import { PageHeader } from '@/components/shell/page-header';
import { requireAdmin } from '@/lib/session';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <PageHeader
          title="Admin"
          description="Members, devices, ingest health and the hub's configuration."
        />
        <AdminNav />
      </div>
      {children}
    </div>
  );
}
