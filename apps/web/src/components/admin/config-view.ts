/**
 * The admin Configuration page's model (handoff §12, §16): the running configuration (getConfig())
 * as sections of environment variables, with every secret reduced to "set" / "not set" and the
 * DATABASE_URL password removed. Pure; unit-tested in config-view.test.ts, which checks that no
 * secret value survives.
 *
 * Built from an allowlist: each variable is named here explicitly, so a secret added to HubConfig
 * later stays off the page until someone lists it (and decides how to show it).
 */
import type { HubConfig } from '@hub/core';

export type ConfigValue =
  /** Shown as is. */
  | { kind: 'text'; text: string }
  /** Comma-separated ids; empty = nothing configured. */
  | { kind: 'list'; items: string[] }
  /** A secret: only whether it is set. */
  | { kind: 'secret'; set: boolean }
  /** A value shown with its secret part removed (DATABASE_URL). */
  | { kind: 'redacted'; text: string }
  | { kind: 'unset' };

export interface ConfigEntry {
  /** The environment variable. */
  name: string;
  /** What it does, in a few words. */
  description: string;
  value: ConfigValue;
}

export interface ConfigSection {
  title: string;
  entries: ConfigEntry[];
}

/** Placeholder for a removed password. */
export const REDACTED = '•••';

/** Query parameters of a connection string whose values are secret (libpq `password`, `sslpassword`). */
const SECRET_PARAM = /pass|secret|token/i;

/**
 * A Postgres connection string without its secrets: the password (and any password-like query
 * parameter) replaced by •••, everything else as configured. A string that isn't a parseable URL is
 * not shown at all (it could be anything, the password included); undefined → unset.
 */
export function redactDatabaseUrl(url: string | undefined): ConfigValue {
  if (url === undefined || url.trim() === '') return { kind: 'unset' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'secret', set: true };
  }
  // Credentials the parser didn't take for userinfo (no "//", or an unencoded / ? # in the
  // password) end up in the path, query or fragment: show nothing then.
  if (`${parsed.pathname}${parsed.search}${parsed.hash}`.includes('@')) {
    return { kind: 'secret', set: true };
  }
  const auth = parsed.username
    ? `${parsed.username}${parsed.password ? `:${REDACTED}` : ''}@`
    : parsed.password
      ? `:${REDACTED}@`
      : '';
  const params = [...parsed.searchParams].map(
    ([key, value]) =>
      `${encodeURIComponent(key)}=${SECRET_PARAM.test(key) ? REDACTED : encodeURIComponent(value)}`,
  );
  const query = params.length > 0 ? `?${params.join('&')}` : '';
  return {
    kind: 'redacted',
    text: `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname}${query}`,
  };
}

const text = (value: string | number): ConfigValue => ({ kind: 'text', text: String(value) });
const optional = (value: string | undefined): ConfigValue =>
  value === undefined ? { kind: 'unset' } : text(value);
const secret = (value: string | undefined): ConfigValue => ({
  kind: 'secret',
  set: value !== undefined && value !== '',
});
const list = (items: readonly string[]): ConfigValue => ({ kind: 'list', items: [...items] });

/** The configuration page's sections, secrets redacted (see the file comment). */
export function configSections(config: HubConfig): ConfigSection[] {
  const d = config.discord;
  return [
    {
      title: 'Hub',
      entries: [
        { name: 'APP_URL', description: 'Public origin of the hub', value: text(config.appOrigin) },
        { name: 'HUB_NAME', description: 'Name the plugin shows', value: text(config.hubName) },
        {
          name: 'MIN_PLUGIN_VERSION',
          description: 'Oldest HA Exporter version accepted',
          value: text(config.minPluginVersion),
        },
        {
          name: 'TRUST_PROXY_HOPS',
          description: 'Reverse proxies in front of the hub',
          value: text(config.trustProxyHops),
        },
        { name: 'LOG_LEVEL', description: 'Log verbosity', value: text(config.logLevel) },
      ],
    },
    {
      title: 'Discord',
      entries: [
        {
          name: 'DISCORD_CLIENT_ID',
          description: 'OAuth application',
          value: optional(d.clientId),
        },
        {
          name: 'DISCORD_CLIENT_SECRET',
          description: 'OAuth application secret',
          value: secret(d.clientSecret),
        },
        {
          name: 'DISCORD_BOT_TOKEN',
          description: 'Bot for membership re-verification',
          value: secret(d.botToken),
        },
        { name: 'DISCORD_GUILD_ID', description: 'The guild', value: optional(d.guildId) },
        {
          name: 'DISCORD_GUILD_NAME',
          description: 'Guild name in messages',
          value: text(d.guildName),
        },
        {
          name: 'DISCORD_REQUIRED_ROLE_IDS',
          description: 'Roles that give access (any of them)',
          value: list(d.requiredRoleIds),
        },
        {
          name: 'DISCORD_ADMIN_ROLE_IDS',
          description: 'Roles that make a member an admin',
          value: list(d.adminRoleIds),
        },
        {
          name: 'ADMIN_DISCORD_USER_IDS',
          description: 'Users who are always admins',
          value: list(d.adminUserIds),
        },
      ],
    },
    {
      title: 'Secrets and storage',
      entries: [
        {
          name: 'AUTH_SECRET',
          description: 'Signs session cookies',
          value: secret(config.authSecret),
        },
        {
          name: 'DATABASE_URL',
          description: 'Postgres connection',
          value: redactDatabaseUrl(config.databaseUrl),
        },
        {
          name: 'METRICS_TOKEN',
          description: 'Protects /metrics (off while unset)',
          value: secret(config.metricsToken),
        },
      ],
    },
    {
      title: 'Limits and retention',
      entries: [
        {
          name: 'OFFBOARD_GRACE_DAYS',
          description: 'Grace period before an offboarded user is deleted',
          value: text(`${config.offboardGraceDays} days`),
        },
        {
          name: 'PAIRING_CODE_TTL_SECONDS',
          description: 'How long a pairing code is valid',
          value: text(`${config.pairingCodeTtlSeconds} s`),
        },
        {
          name: 'XP_RAW_RETENTION_DAYS',
          description: '5-minute XP samples',
          value: text(`${config.xpRawRetentionDays} days`),
        },
        {
          name: 'LOCATION_RETENTION_DAYS',
          description: 'Location history',
          value: text(`${config.locationRetentionDays} days`),
        },
        {
          name: 'RAW_PAYLOAD_RETENTION_HOURS',
          description: 'Archived raw payloads',
          value: text(`${config.rawPayloadRetentionHours} hours`),
        },
        {
          name: 'AUDIT_LOG_RETENTION_DAYS',
          description: 'Audit log',
          value: text(`${config.auditLogRetentionDays} days`),
        },
        {
          name: 'INGEST_MAX_BODY_KB',
          description: 'Largest payload accepted',
          value: text(`${Math.round(config.ingestMaxBodyBytes / 1024)} KB`),
        },
      ],
    },
  ];
}
