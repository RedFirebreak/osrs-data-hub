/**
 * Admin → Decommission (handoff §3.2, §7.7, §12, D-19, D-56): the danger zone. While the switch is
 * on, ingest and pairing answer 410 Gone and every HA Exporter plugin that receives it disables its
 * connection for good; the switch sits behind a typed confirmation (DecommissionSwitch). The state
 * is read with isDecommissioned (cached 10 s per process; the switch clears the cache).
 */
import { getConfig } from '@hub/core';
import { getDb } from '@hub/db';
import { isDecommissioned } from '@hub/server';
import { OctagonAlertIcon, PowerOffIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { AdminSectionHeader } from '@/components/admin/admin-section';
import { DecommissionSwitch } from '@/components/admin/decommission-switch';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireAdmin } from '@/lib/session';

export function generateMetadata(): Metadata {
  return { title: `Decommission · Admin · ${getConfig().hubName}` };
}

export default async function AdminDecommissionPage() {
  await requireAdmin();
  const { hubName } = getConfig();
  const decommissioned = await isDecommissioned(getDb().db);

  return (
    <section aria-labelledby="admin-decommission" className="flex flex-col gap-4">
      <AdminSectionHeader
        id="admin-decommission"
        title="Decommission"
        description="For shutting the hub down for good, so plugins stop sending instead of retrying forever."
      />
      {decommissioned && (
        <Alert variant="destructive">
          <PowerOffIcon aria-hidden />
          <AlertTitle>{hubName} is decommissioned</AlertTitle>
          <AlertDescription>
            Ingest and pairing answer 410 Gone. Every plugin that sends data disables its
            connection.
          </AlertDescription>
        </Alert>
      )}
      <Card className="ring-destructive/40">
        <CardHeader>
          <CardTitle>
            <h3 className="flex items-center gap-2 text-destructive">
              <OctagonAlertIcon aria-hidden className="size-4" />
              Danger zone
            </h3>
          </CardTitle>
          <CardDescription>Read this before you touch the switch.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-pretty">
            <li>
              Every payload the HA Exporter plugin sends is answered with <strong>410 Gone</strong>,
              and so is every pairing attempt.
            </li>
            <li>
              A plugin that receives 410 <strong>disables its connection permanently</strong>. It
              doesn&apos;t retry, and it doesn&apos;t come back when the switch is turned off: every
              player would have to turn their connection on again in the plugin.
            </li>
            <li>
              Members can still sign in and see the data that is already stored; nothing is deleted.
            </li>
          </ul>
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <DecommissionSwitch decommissioned={decommissioned} hubName={hubName} />
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
