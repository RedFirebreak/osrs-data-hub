/**
 * Admin → Ingest health (handoff §12, §7.6): from getIngestHealth — payloads per minute over the last
 * hour (accepted vs. other statuses), totals by HTTP status for 1 h and 24 h, skipped sections and
 * events with the most-skipped section paths, the plugin versions of active devices, and the noisiest
 * devices by payloads in the last hour (with their user and label, linking to their raw payloads).
 *
 * The numbers come from raw_payloads, which only holds bodies that got past auth, the version gate,
 * the size cap and the rate limit. 401s, 413s and most 429s are never archived: the "Since the hub
 * started" card shows every response from the ingest counter (hub_ingest_payloads_total, the same
 * one /metrics serves; process-wide on globalThis, NEXT-3), which resets when the web process restarts.
 */
import { formatNumber, getConfig, meetsMinimumVersion } from '@hub/core';
import { getDb } from '@hub/db';
import { HEALTH_MINUTES, getIngestHealth, getMetrics, type IngestHealth } from '@hub/server';
import { ActivityIcon } from 'lucide-react';
import type { Metadata, Route } from 'next';
import Link from 'next/link';
import {
  countsByLabel,
  formatBytes,
  rawPayloadsHref,
  shortId,
  sortStatusKeys,
  sumCounts,
} from '@/components/admin/admin-model';
import { AdminEmptyState, AdminSectionHeader, StatTiles } from '@/components/admin/admin-section';
import { HttpStatusBadge } from '@/components/admin/badges';
import type { MinutePoint } from '@/components/admin/ingest-chart';
import { PayloadsChart } from '@/components/admin/payloads-chart';
import { deviceName } from '@/components/devices/device-model';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireAdmin } from '@/lib/session';

export function generateMetadata(): Metadata {
  return { title: `Ingest health · Admin · ${getConfig().hubName}` };
}

function percent(part: number, whole: number): string {
  if (whole === 0) return '—';
  return `${Math.round((part / whole) * 1000) / 10}%`;
}

export default async function AdminIngestPage() {
  await requireAdmin();
  const config = getConfig();
  const health = await getIngestHealth(getDb().db);
  const sinceStart = countsByLabel((await getMetrics().ingestPayloads.get()).values, 'status');
  const points: MinutePoint[] = health.perMinute.map((m) => ({
    minute: m.minute.toISOString(),
    total: m.total,
    byStatus: m.byStatus,
  }));
  const hourTotal = sumCounts(health.lastHour);
  const dayTotal = sumCounts(health.last24h);
  const hourAccepted = health.lastHour['200'] ?? 0;
  const dayFailed = dayTotal - (health.last24h['200'] ?? 0);

  return (
    <section aria-labelledby="admin-ingest" className="flex flex-col gap-4">
      <AdminSectionHeader
        id="admin-ingest"
        title="Ingest health"
        description={`What the plugin sent in the last hour and day, from the raw payload archive (kept ${config.rawPayloadRetentionHours} hours).`}
      />
      <StatTiles
        label="Ingest totals"
        stats={[
          { label: 'Payloads, last hour', value: formatNumber(hourTotal) },
          {
            label: 'Accepted, last hour',
            value: percent(hourAccepted, hourTotal),
            hint: `${formatNumber(hourAccepted)} with status 200`,
          },
          { label: 'Payloads, 24 h', value: formatNumber(dayTotal) },
          {
            label: 'Not accepted, 24 h',
            value: formatNumber(dayFailed),
            attention: dayFailed > 0,
            hint: dayTotal > 0 ? `${percent(dayFailed, dayTotal)} of payloads` : undefined,
          },
        ]}
      />

      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Payloads per minute</h3>
          </CardTitle>
          <CardDescription>
            The last {HEALTH_MINUTES} minutes; the newest minute is still running.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {points.every((p) => p.total === 0) ? (
            <AdminEmptyState icon={ActivityIcon} title="No payloads in the last hour">
              Payloads arrive while members play with the HA Exporter plugin paired.
            </AdminEmptyState>
          ) : (
            <PayloadsChart points={points} />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <StatusTotals health={health} />
        <SinceStart counts={sinceStart} maxBody={formatBytes(config.ingestMaxBodyBytes)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Skipped health={health} />
        <PluginVersions health={health} minVersion={config.minPluginVersion} />
      </div>

      <NoisyDevices health={health} />

      <p className="text-xs text-pretty text-muted-foreground">
        Everything except &ldquo;Since the hub started&rdquo; comes from the raw payload archive:
        requests refused before they are archived (unknown or revoked tokens, outdated plugins,
        bodies over {formatBytes(config.ingestMaxBodyBytes)}, rate-limited snapshots) aren&apos;t in
        those numbers. The Prometheus counters at /metrics have all of them.
      </p>
    </section>
  );
}

function StatusTotals({ health }: { health: IngestHealth }) {
  const keys = sortStatusKeys([...Object.keys(health.lastHour), ...Object.keys(health.last24h)]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>By status</h3>
        </CardTitle>
        <CardDescription>What the hub answered to archived payloads.</CardDescription>
      </CardHeader>
      <CardContent>
        {keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payloads in the last 24 hours.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Last hour</TableHead>
                <TableHead className="text-right">24 hours</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => (
                <TableRow key={key}>
                  <TableCell>
                    <Link
                      href={
                        rawPayloadsHref({
                          status: key === 'pending' ? 'pending' : Number(key),
                        }) as Route
                      }
                      className="rounded-4xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      title={`Raw payloads with status ${key}`}
                    >
                      <HttpStatusBadge statusKey={key} />
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(health.lastHour[key] ?? 0)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(health.last24h[key] ?? 0)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/** Every ingest response since the web process started, by status (the ingest counter). */
function SinceStart({ counts, maxBody }: { counts: Record<string, number>; maxBody: string }) {
  const keys = sortStatusKeys(Object.keys(counts));
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Since the hub started</h3>
        </CardTitle>
        <CardDescription>
          Every ingest response, including those never archived: unknown or revoked tokens (401),
          bodies over {maxBody} (413) and rate-limited snapshots (429). Starts again at zero when
          the hub restarts.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">No ingest requests since the hub started.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Responses</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => (
                <TableRow key={key}>
                  <TableCell>
                    <HttpStatusBadge statusKey={key} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(counts[key] ?? 0)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function Skipped({ health }: { health: IngestHealth }) {
  const { lastHour, last24h } = health.skipped;
  const rows: { label: string; hour: number; day: number }[] = [
    { label: 'Sections skipped', hour: lastHour.sections, day: last24h.sections },
    { label: 'Events skipped', hour: lastHour.events, day: last24h.events },
    { label: 'Payloads affected', hour: lastHour.payloads, day: last24h.payloads },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Skipped data</h3>
        </CardTitle>
        <CardDescription>
          Malformed sections and events are dropped; the rest of the payload is kept.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <span className="sr-only">What</span>
              </TableHead>
              <TableHead className="text-right">Last hour</TableHead>
              <TableHead className="text-right">24 hours</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.label}>
                <TableCell>{r.label}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(r.hour)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(r.day)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {health.topSkippedSections.length > 0 && (
          <div className="flex flex-col gap-2">
            <h4 className="text-xs font-medium text-muted-foreground">
              Most skipped sections, 24 hours
            </h4>
            <ul className="flex flex-col gap-1">
              {health.topSkippedSections.map((s) => (
                <li key={s.path} className="flex items-center justify-between gap-3 text-sm">
                  <code className="min-w-0 truncate font-mono text-xs">{s.path}</code>
                  <span className="shrink-0 tabular-nums">{formatNumber(s.count)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PluginVersions({ health, minVersion }: { health: IngestHealth; minVersion: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Plugin versions</h3>
        </CardTitle>
        <CardDescription>Active devices by the HA Exporter version they last sent.</CardDescription>
      </CardHeader>
      <CardContent>
        {health.pluginVersions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active devices.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead className="text-right">Devices</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {health.pluginVersions.map((v) => (
                <TableRow key={v.version ?? 'none'}>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {v.version === null ? (
                        <span className="text-muted-foreground">Not sent yet</span>
                      ) : (
                        <span className="font-mono text-xs">{v.version}</span>
                      )}
                      {v.version !== null && !meetsMinimumVersion(v.version, minVersion) && (
                        <Badge
                          variant="outline"
                          className="border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300"
                        >
                          Below {minVersion}
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(v.devices)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function NoisyDevices({ health }: { health: IngestHealth }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Noisy devices</h3>
        </CardTitle>
        <CardDescription>
          Most payloads in the last hour. Snapshot-only payloads above 5 per second get 429.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {health.noisyDevices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payloads in the last hour.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Device</TableHead>
                <TableHead className="text-right">Payloads</TableHead>
                <TableHead className="text-right">Not 200</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {health.noisyDevices.map((d) => (
                <TableRow key={d.deviceId}>
                  <TableCell>
                    <div className="flex flex-col">
                      <Link
                        href={rawPayloadsHref({ deviceId: d.deviceId }) as Route}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {d.user ? deviceName(d.label) : `Deleted device ${shortId(d.deviceId)}`}
                      </Link>
                      <span className="text-xs text-muted-foreground">
                        {d.user?.name ?? 'user deleted'}
                        {d.pluginVersion && ` · ${d.pluginVersion}`}
                        {d.revokedAt && ' · revoked'}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(d.payloads)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {d.errors > 0 ? (
                      <span className="font-medium text-amber-700 dark:text-amber-300">
                        {formatNumber(d.errors)}
                      </span>
                    ) : (
                      '0'
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
