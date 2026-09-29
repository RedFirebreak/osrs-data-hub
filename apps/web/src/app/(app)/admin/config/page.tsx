/**
 * Admin → Configuration (handoff §12, §16): the running configuration, read-only, from
 * configSections(getConfig()): secrets (AUTH_SECRET, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN,
 * METRICS_TOKEN) only as "set" / "not set", DATABASE_URL without its password. Changing a value
 * means changing the environment and restarting the containers.
 */
import { getConfig } from '@hub/core';
import { CircleCheckIcon, CircleDashedIcon, LockIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { AdminSectionHeader } from '@/components/admin/admin-section';
import { configSections, type ConfigValue } from '@/components/admin/config-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireAdmin } from '@/lib/session';

export function generateMetadata(): Metadata {
  return { title: `Configuration · Admin · ${getConfig().hubName}` };
}

export default async function AdminConfigPage() {
  await requireAdmin();
  const sections = configSections(getConfig());
  return (
    <section aria-labelledby="admin-config" className="flex flex-col gap-4">
      <AdminSectionHeader
        id="admin-config"
        title="Configuration"
        description="The environment the hub runs with. It is read-only here: change the variables in the deployment and restart web and worker. Secrets are never shown."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {sections.map((section) => (
          <Card key={section.title}>
            <CardHeader>
              <CardTitle>
                <h3>{section.title}</h3>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="flex flex-col divide-y">
                {section.entries.map((entry) => (
                  <div
                    key={entry.name}
                    className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                  >
                    <dt className="min-w-0">
                      <code className="font-mono text-xs font-medium break-all">{entry.name}</code>
                      <p className="text-xs text-muted-foreground">{entry.description}</p>
                    </dt>
                    <dd className="min-w-0 text-sm sm:max-w-[60%] sm:text-right">
                      <Value value={entry.value} />
                    </dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

function Value({ value }: { value: ConfigValue }) {
  switch (value.kind) {
    case 'text':
      return <span className="font-mono text-xs break-all">{value.text}</span>;
    case 'redacted':
      return (
        <span className="inline-flex items-start gap-1.5 font-mono text-xs break-all">
          <LockIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
          <span>
            {value.text}
            <span className="sr-only"> (password hidden)</span>
          </span>
        </span>
      );
    case 'list':
      return value.items.length === 0 ? (
        <span className="text-xs text-muted-foreground">None</span>
      ) : (
        <span className="font-mono text-xs break-all">{value.items.join(', ')}</span>
      );
    case 'secret':
      return value.set ? (
        <span className="inline-flex items-center gap-1.5 text-xs">
          <CircleCheckIcon
            aria-hidden
            className="size-3.5 text-emerald-600 dark:text-emerald-400"
          />
          Set <span className="text-muted-foreground">(hidden)</span>
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <CircleDashedIcon aria-hidden className="size-3.5" />
          Not set
        </span>
      );
    case 'unset':
      return <span className="text-xs text-muted-foreground">Not set</span>;
  }
}
