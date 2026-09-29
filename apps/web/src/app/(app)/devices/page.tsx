/**
 * Devices (handoff §6.3, §12): the signed-in user's paired RuneLite connections from listDevices —
 * name (inline rename), plugin version with an "Outdated" marker, when paired and last seen, the
 * accounts each reported, status — with Revoke, and "Add device" into the pairing wizard. Revoked
 * devices are listed separately below. Without devices: a pointer to the wizard.
 */
import { getConfig } from '@hub/core';
import { getDb } from '@hub/db';
import { listDevices, type DeviceSummary } from '@hub/server';
import { MonitorSmartphoneIcon, PlusIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { DeviceCard } from '@/components/devices/device-card';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUser } from '@/lib/session';

export function generateMetadata(): Metadata {
  return { title: `Devices · ${getConfig().hubName}` };
}

export default async function DevicesPage() {
  const { user } = await requireUser();
  const devices = await listDevices(getDb().db, user.id);
  const now = new Date().toISOString();
  const connected = devices.filter((d) => d.status !== 'revoked');
  const revoked = devices.filter((d) => d.status === 'revoked');

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <PageHeader
        title="Devices"
        description="RuneLite connections that send data to the hub. Each PC you play on is paired once."
        actions={
          <Button asChild>
            <Link href="/onboarding">
              <PlusIcon aria-hidden data-icon="inline-start" />
              Add device
            </Link>
          </Button>
        }
      />

      {devices.length === 0 ? (
        <EmptyDevices />
      ) : (
        <>
          <DeviceSection
            title="Connected devices"
            devices={connected}
            now={now}
            empty="No connected devices. Add one to send data again."
          />
          {revoked.length > 0 && (
            <DeviceSection title="Revoked devices" devices={revoked} now={now} />
          )}
        </>
      )}
    </div>
  );
}

function DeviceSection({
  title,
  devices,
  now,
  empty,
}: {
  title: string;
  devices: DeviceSummary[];
  now: string;
  empty?: string;
}) {
  const headingId = title.toLowerCase().replace(/\s+/g, '-');
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold">
        {title} <span className="font-normal text-muted-foreground">({devices.length})</span>
      </h2>
      {devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {devices.map((device) => (
            <li key={device.id}>
              <DeviceCard device={device} now={now} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EmptyDevices() {
  return (
    <Card className="items-center px-4 py-10 text-center">
      <span
        aria-hidden
        className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <MonitorSmartphoneIcon className="size-6" />
      </span>
      <CardHeader className="w-full justify-items-center">
        <CardTitle className="text-lg">
          <h2>No devices yet</h2>
        </CardTitle>
        <CardDescription className="max-w-prose text-balance">
          Pair the HA Exporter RuneLite plugin with a 5-digit code and your accounts start showing
          up on the dashboard. It takes about two minutes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild size="lg">
          <Link href="/onboarding">
            <PlusIcon aria-hidden data-icon="inline-start" />
            Add your first device
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
