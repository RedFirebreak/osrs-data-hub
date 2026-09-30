/**
 * One key on the API keys page (D-76) and on Admin → Integrations (service keys, D-87): name and
 * status, the key as `ohub_<prefix>_…` (the secret is never shown again after creation), the
 * categories it reads, its account scope (listed accounts the owner can no longer see are named "An
 * account you can no longer see"; a service key reads the guild audience), its rate limit, who
 * created it (service keys), when it was created and last used, when it expires, and Revoke for an
 * active key (`actions` replaces the user's Revoke button on the admin page).
 *
 * A server component; Revoke and the relative times are client components. `now` is the page's render
 * time, so relative times hydrate without a mismatch; `timezone` is the viewer's (Settings).
 */
import { CATEGORY_LABELS } from '@hub/core';
import type { ApiKeyInfo, ApiKeyStatus } from '@hub/server';
import { AccountLink } from '@/components/accounts/account-link';
import { formatInZone } from '@/components/account/dates';
import { RelativeTime } from '@/components/events/relative-time';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  HIDDEN_ACCOUNT_LABEL,
  KEY_STATUS_LABELS,
  expiryText,
  maskedKey,
  scopeText,
} from './api-key-model';
import { RevokeApiKeyButton } from './revoke-api-key-button';

const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
};

const STATUS_TONES: Readonly<Record<ApiKeyStatus, string>> = {
  active: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  expired: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
  revoked: 'border-border bg-muted text-muted-foreground',
};

export function ApiKeyStatusBadge({ status }: { status: ApiKeyStatus }) {
  return (
    <Badge variant="outline" className={STATUS_TONES[status]}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {KEY_STATUS_LABELS[status]}
    </Badge>
  );
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

export interface ApiKeyCardProps {
  apiKey: ApiKeyInfo & { createdBy?: { id: string; name: string } | null };
  /** The page's render time (ISO). */
  now: string;
  /** The viewer's time zone for absolute dates. */
  timezone: string;
  /** The footer's action for an active key; default: the user's own Revoke button. */
  actions?: React.ReactNode;
}

export function ApiKeyCard({ apiKey, now, timezone, actions }: ApiKeyCardProps) {
  const active = apiKey.status === 'active';
  const expiresOn = apiKey.expiresAt
    ? formatInZone(apiKey.expiresAt, timezone, DATE_OPTIONS)
    : null;
  return (
    <Card
      data-testid="api-key-card"
      data-key-id={apiKey.id}
      className={cn(!active && 'bg-muted/30')}
    >
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-base font-semibold">{apiKey.name}</h3>
        <ApiKeyStatusBadge status={apiKey.status} />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
          <Field label="Key" className="col-span-2 sm:col-span-1">
            <code className="font-mono text-xs break-all">{maskedKey(apiKey.prefix)}</code>
          </Field>
          <Field label="Created">
            <RelativeTime date={apiKey.createdAt} now={now} />
          </Field>
          <Field label="Last used">
            {apiKey.lastUsedAt ? (
              <RelativeTime date={apiKey.lastUsedAt} now={now} />
            ) : (
              <span className="text-muted-foreground">Never</span>
            )}
          </Field>
          <Field label="Expires">
            {apiKey.expiresAt ? (
              <time dateTime={apiKey.expiresAt} title={expiresOn ?? undefined}>
                {expiryText(apiKey.expiresAt, now)}
              </time>
            ) : (
              <span className="text-muted-foreground">Never</span>
            )}
          </Field>
          <Field label="Rate limit">
            <span className="tabular-nums">{apiKey.rateLimitPerMinute}</span>
            <span className="text-muted-foreground"> / min</span>
          </Field>
          {apiKey.createdBy !== undefined && (
            <Field label="Created by" className="col-span-2 sm:col-span-3">
              {apiKey.createdBy ? (
                apiKey.createdBy.name
              ) : (
                <span className="text-muted-foreground">A deleted user</span>
              )}
            </Field>
          )}
          <Field label="Reads" className="col-span-2 sm:col-span-4">
            <ul className="flex flex-wrap gap-1.5" aria-label="Categories">
              {apiKey.categories.map((c) => (
                <li key={c}>
                  <Badge variant="secondary" title={CATEGORY_LABELS[c].covers}>
                    {CATEGORY_LABELS[c].label}
                  </Badge>
                </li>
              ))}
            </ul>
          </Field>
          <Field label="Accounts" className="col-span-2 sm:col-span-4">
            <p>{scopeText(apiKey)}</p>
            {apiKey.accountScope === 'list' && (apiKey.accounts?.length ?? 0) > 0 && (
              <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {apiKey.accounts?.map((account) => (
                  <li key={account.publicId}>
                    {account.visible && account.name !== null ? (
                      <AccountLink publicId={account.publicId} name={account.name} />
                    ) : (
                      <span className="text-muted-foreground italic">{HIDDEN_ACCOUNT_LABEL}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Field>
        </dl>
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-end gap-2">
        {active ? (
          (actions ?? <RevokeApiKeyButton keyId={apiKey.id} name={apiKey.name} />)
        ) : apiKey.status === 'revoked' && apiKey.revokedAt ? (
          <p className="mr-auto text-sm text-muted-foreground">
            Revoked <RelativeTime date={apiKey.revokedAt} now={now} />. Apps using it get 401.
          </p>
        ) : (
          <p className="mr-auto text-sm text-muted-foreground">
            Expired{expiresOn ? ` on ${expiresOn}` : ''}. Apps using it get 401.
          </p>
        )}
      </CardFooter>
    </Card>
  );
}
