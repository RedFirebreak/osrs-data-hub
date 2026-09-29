/**
 * Admin → Audit log (handoff §12): listAuditLog, newest first, AUDIT_PAGE_SIZE entries rendered here
 * and older ones loaded on demand ("Load more", GET /api/app/admin/audit-log). Entries are kept
 * AUDIT_LOG_RETENTION_DAYS; a deleted user's entries are anonymized.
 */
import { getConfig } from '@hub/core';
import { getDb } from '@hub/db';
import { listAuditLog } from '@hub/server';
import type { Metadata } from 'next';
import { AUDIT_PAGE_SIZE } from '@/components/admin/admin-model';
import { AdminSectionHeader } from '@/components/admin/admin-section';
import { AuditLogList, type AuditEntryJson } from '@/components/admin/audit-log-list';
import { adminMetadata, requireAdmin } from '@/lib/session';

export function generateMetadata(): Promise<Metadata> {
  return adminMetadata('Audit log');
}

export default async function AdminAuditPage() {
  await requireAdmin();
  const rows = await listAuditLog(getDb().db, { limit: AUDIT_PAGE_SIZE });
  const entries: AuditEntryJson[] = rows.map((r) => ({ ...r, at: r.at.toISOString() }));
  const last = rows.at(-1);
  return (
    <section aria-labelledby="admin-audit" className="flex flex-col gap-4">
      <AdminSectionHeader
        id="admin-audit"
        title="Audit log"
        description={`Pairings, revocations, offboardings, ownership and sharing changes, and admin actions. Kept ${getConfig().auditLogRetentionDays} days.`}
      />
      <AuditLogList
        initial={entries}
        nextBefore={rows.length >= AUDIT_PAGE_SIZE && last ? last.id : null}
        now={new Date().toISOString()}
      />
    </section>
  );
}
