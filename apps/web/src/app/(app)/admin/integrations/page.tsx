/**
 * Admin → Integrations (D-87): the hub's service keys, the integration keys of the public API used
 * by the guild's own services (the live map). Active keys with Revoke, then revoked and expired
 * ones, and "Create integration key". Explains that a service key belongs to nobody, reads what the
 * guild audience sees (D-88) and survives every offboarding.
 */
import { getConfig } from '@hub/core';
import { getDb } from '@hub/db';
import {
  API_KEY_NAME_MAX,
  MAX_KEY_RATE_LIMIT,
  SERVICE_KEY_RATE_LIMIT,
  getUserSettings,
  listServiceKeys,
  type ServiceKeyInfo,
} from '@hub/server';
import { BookOpenIcon, PlugZapIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminEmptyState, AdminSectionHeader } from '@/components/admin/admin-section';
import { CreateServiceKeyDialog } from '@/components/admin/service-keys/create-service-key-dialog';
import { RevokeServiceKeyButton } from '@/components/admin/service-keys/revoke-service-key-button';
import { ApiKeyCard } from '@/components/api-keys/api-key-card';
import { Button } from '@/components/ui/button';
import { adminMetadata, requireAdmin } from '@/lib/session';

export function generateMetadata(): Promise<Metadata> {
  return adminMetadata('Integrations');
}

const ACTIVE_HEADING_ID = 'admin-integrations-active';

export default async function AdminIntegrationsPage() {
  const { user } = await requireAdmin();
  const { db } = getDb();
  const keys = await listServiceKeys(db);
  const { timezone } = await getUserSettings(db, user.id);
  const now = new Date().toISOString();
  const active = keys.filter((k) => k.status === 'active');
  const inactive = keys.filter((k) => k.status !== 'active');
  const dialog = {
    nameMax: API_KEY_NAME_MAX,
    rateLimitDefault: SERVICE_KEY_RATE_LIMIT,
    rateLimitMax: MAX_KEY_RATE_LIMIT,
    apiBase: `${getConfig().appOrigin}/api/v1`,
    listHeadingId: ACTIVE_HEADING_ID,
  };

  return (
    <section aria-labelledby="admin-integrations" className="flex flex-col gap-4">
      <AdminSectionHeader
        id="admin-integrations"
        title="Integrations"
        description="Integration keys for the guild's own services, such as its live map. A key belongs to nobody: it reads exactly what every guild member can see, the accounts and categories shared with the guild, and offboarding anyone never revokes it."
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/docs/api">
                <BookOpenIcon aria-hidden data-icon="inline-start" />
                API reference
              </Link>
            </Button>
            {keys.length > 0 && <CreateServiceKeyDialog {...dialog} />}
          </>
        }
      />
      {keys.length === 0 ? (
        <AdminEmptyState icon={PlugZapIcon} title="No integration keys yet">
          <p>
            Create one for a service that needs the hub&apos;s API without depending on a
            member&apos;s account. Its default rate limit is {SERVICE_KEY_RATE_LIMIT} requests per
            minute.
          </p>
          <div className="mt-4">
            <CreateServiceKeyDialog {...dialog} size="lg" />
          </div>
        </AdminEmptyState>
      ) : (
        <>
          <KeySection
            headingId={ACTIVE_HEADING_ID}
            title="Active keys"
            keys={active}
            now={now}
            timezone={timezone}
            empty="No active integration keys. Create one to give a service access."
          />
          {inactive.length > 0 && (
            <KeySection
              headingId="admin-integrations-inactive"
              title="Revoked and expired keys"
              keys={inactive}
              now={now}
              timezone={timezone}
            />
          )}
        </>
      )}
    </section>
  );
}

function KeySection({
  headingId,
  title,
  keys,
  now,
  timezone,
  empty,
}: {
  headingId: string;
  title: string;
  keys: ServiceKeyInfo[];
  now: string;
  timezone: string;
  empty?: string;
}) {
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="text-base font-semibold">
        {title} <span className="font-normal text-muted-foreground">({keys.length})</span>
      </h3>
      {keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {keys.map((key) => (
            <li key={key.id}>
              <ApiKeyCard
                apiKey={key}
                now={now}
                timezone={timezone}
                actions={<RevokeServiceKeyButton keyId={key.id} name={key.name} />}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
