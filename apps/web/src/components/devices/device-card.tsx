/**
 * One device on the Devices page (handoff §6.3): name with inline rename, status badge, plugin version
 * (with "Outdated" and how to fix it), when it was paired and last seen, the accounts it reported
 * (links to their pages), and Revoke — or, for a revoked device, who revoked it and when.
 *
 * A server component; the interactive parts (rename, revoke, relative times) are client components.
 * `now` is the page's render time, so relative times hydrate without a mismatch.
 */
import type { DeviceSummary } from '@hub/server';
import { AccountLink } from '@/components/accounts/account-link';
import { RelativeTime } from '@/components/events/relative-time';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { DeviceLabelEditor } from './device-label-editor';
import { deviceName, revokedByText } from './device-model';
import { DeviceStatusBadge, OutdatedBadge } from './device-status-badge';
import { RevokeDeviceButton } from './revoke-device-button';

export interface DeviceCardProps {
  device: DeviceSummary;
  /** The page's render time (ISO). */
  now: string;
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

export function DeviceCard({ device, now }: DeviceCardProps) {
  const revoked = device.status === 'revoked';
  const name = deviceName(device.label);
  return (
    <Card
      data-testid="device-card"
      data-device-id={device.id}
      className={cn(revoked && 'bg-muted/30')}
    >
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <DeviceLabelEditor deviceId={device.id} label={device.label} className="min-w-0" />
        <DeviceStatusBadge status={device.status} />
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
          <Field label="Plugin version">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono tabular-nums">{device.pluginVersion ?? '—'}</span>
              {device.status === 'outdated' && <OutdatedBadge />}
            </span>
          </Field>
          <Field label="Paired">
            <RelativeTime date={device.createdAt.toISOString()} now={now} />
          </Field>
          <Field label="Last seen">
            {device.lastSeenAt ? (
              <RelativeTime date={device.lastSeenAt.toISOString()} now={now} />
            ) : (
              <span className="text-muted-foreground">Never</span>
            )}
          </Field>
          <Field label="Accounts reported" className="col-span-2 sm:col-span-3">
            {device.accounts.length > 0 ? (
              <ul className="flex flex-wrap gap-x-3 gap-y-1">
                {device.accounts.map((account) => (
                  <li key={account.publicId}>
                    <AccountLink publicId={account.publicId} name={account.name} />
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted-foreground">
                {revoked ? 'None' : 'None yet: log in to OSRS with the plugin enabled.'}
              </span>
            )}
          </Field>
        </dl>
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-end gap-2">
        {revoked ? (
          <p className="mr-auto text-sm text-muted-foreground">
            {revokedByText(device.revokedReason)}
            {device.revokedAt && (
              <>
                {' '}
                <RelativeTime date={device.revokedAt.toISOString()} now={now} />
              </>
            )}
            . The plugin disables this connection on its next send.
          </p>
        ) : (
          <RevokeDeviceButton deviceId={device.id} name={name} />
        )}
      </CardFooter>
    </Card>
  );
}
