/**
 * Environment configuration shared by web and worker. All values come from env (one guild per
 * deployment; another clan self-hosts by changing env vars only, D-2). See .env.example.
 */
import { z } from 'zod';
import { parsePluginVersion } from './version';

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const int = (def: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return def;
      if (!/^\d+$/.test(v.trim())) {
        ctx.addIssue({ code: 'custom', message: 'must be a whole number' });
        return z.NEVER;
      }
      const n = Number(v.trim());
      if (n < min) {
        ctx.addIssue({ code: 'custom', message: `must be at least ${min}` });
        return z.NEVER;
      }
      return n;
    });

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

/** Where the hub's item, skill and equipment-slot icons come from by default (D-95). */
export const DEFAULT_OSRS_ICONS_URL = 'https://icons.scapekeeper.com';

/**
 * OSRS_ICONS_URL (D-95): unset → the default CDN; empty → icons off (null); otherwise an http(s) base
 * URL, trailing slashes removed. Read at runtime like every other variable: a NEXT_PUBLIC_* value
 * would be baked into the prebuilt image (NEXT-17).
 */
const iconsUrl = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return DEFAULT_OSRS_ICONS_URL;
    const trimmed = v.trim().replace(/\/+$/, '');
    if (trimmed === '') return null;
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'must be an absolute URL including https://, or empty to turn icons off',
      });
      return z.NEVER;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      ctx.addIssue({ code: 'custom', message: 'must start with https:// (or http://)' });
      return z.NEVER;
    }
    // Icon URLs are `${base}/items/…`: a query, fragment or credentials would end up in the middle.
    if (url.search || url.hash || url.username || url.password) {
      ctx.addIssue({
        code: 'custom',
        message: 'must be a plain base URL, without ?query, #fragment or user:password@',
      });
      return z.NEVER;
    }
    return trimmed;
  });

const logLevel = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  .default('info');

const EnvSchema = z.object({
  APP_URL: z
    .string()
    .default('http://localhost:3000')
    .transform((v, ctx) => {
      let url: URL;
      try {
        url = new URL(v.trim());
      } catch {
        ctx.addIssue({ code: 'custom', message: 'must be an absolute URL including https://' });
        return z.NEVER;
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        ctx.addIssue({
          code: 'custom',
          message: 'must start with https:// (or http:// for local use)',
        });
        return z.NEVER;
      }
      // Next's basePath is build-time only, so the hub is served at the origin root (D-26, NEXT-1).
      if (url.pathname !== '/' || url.search || url.hash) {
        ctx.addIssue({
          code: 'custom',
          message:
            'must be an origin without a path (e.g. https://hub.example.com); path prefixes are not supported',
        });
        return z.NEVER;
      }
      return url;
    }),
  HUB_NAME: z.string().default('osrs-data-hub'),
  MIN_PLUGIN_VERSION: z
    .string()
    .default('1.5')
    .refine((v) => parsePluginVersion(v) !== null, 'must be a version like 1.5'),
  DATABASE_URL: optionalString,
  AUTH_SECRET: optionalString,
  DISCORD_CLIENT_ID: optionalString,
  DISCORD_CLIENT_SECRET: optionalString,
  DISCORD_BOT_TOKEN: optionalString,
  DISCORD_GUILD_ID: optionalString,
  DISCORD_GUILD_NAME: optionalString,
  DISCORD_REQUIRED_ROLE_IDS: csv,
  DISCORD_ADMIN_ROLE_IDS: csv,
  ADMIN_DISCORD_USER_IDS: csv,
  OFFBOARD_GRACE_DAYS: int(30, 0),
  PAIRING_CODE_TTL_SECONDS: int(300, 30),
  XP_RAW_RETENTION_DAYS: int(365, 14),
  LOCATION_RETENTION_DAYS: int(30, 1),
  RAW_PAYLOAD_RETENTION_HOURS: int(72, 1),
  AUDIT_LOG_RETENTION_DAYS: int(730, 1),
  INGEST_MAX_BODY_KB: int(256, 16),
  TRUST_PROXY_HOPS: int(1, 0),
  METRICS_TOKEN: optionalString,
  WORKER_METRICS_PORT: int(9464, 0),
  LOG_LEVEL: logLevel,
  OSRS_ICONS_URL: iconsUrl,
});

/** Every environment variable the config reads (the admin Configuration page lists them all). */
export const CONFIG_ENV_NAMES: readonly string[] = Object.keys(EnvSchema.shape);

/**
 * Env → the config the code reads. A variable gets its field name here and nowhere else: HubConfig
 * is this function's return type, so a new variable is one line in EnvSchema and one line here.
 */
function toConfig(e: z.output<typeof EnvSchema>) {
  return {
    appUrl: e.APP_URL,
    /** APP_URL origin, e.g. "https://hub.example.com" (no trailing slash). */
    appOrigin: e.APP_URL.origin,
    hubName: hubNameFrom(e.HUB_NAME),
    minPluginVersion: e.MIN_PLUGIN_VERSION,
    databaseUrl: e.DATABASE_URL,
    authSecret: e.AUTH_SECRET,
    discord: {
      clientId: e.DISCORD_CLIENT_ID,
      clientSecret: e.DISCORD_CLIENT_SECRET,
      botToken: e.DISCORD_BOT_TOKEN,
      guildId: e.DISCORD_GUILD_ID,
      guildName: e.DISCORD_GUILD_NAME ?? 'the guild',
      requiredRoleIds: e.DISCORD_REQUIRED_ROLE_IDS,
      adminRoleIds: e.DISCORD_ADMIN_ROLE_IDS,
      adminUserIds: e.ADMIN_DISCORD_USER_IDS,
    },
    offboardGraceDays: e.OFFBOARD_GRACE_DAYS,
    pairingCodeTtlSeconds: e.PAIRING_CODE_TTL_SECONDS,
    xpRawRetentionDays: e.XP_RAW_RETENTION_DAYS,
    locationRetentionDays: e.LOCATION_RETENTION_DAYS,
    rawPayloadRetentionHours: e.RAW_PAYLOAD_RETENTION_HOURS,
    auditLogRetentionDays: e.AUDIT_LOG_RETENTION_DAYS,
    ingestMaxBodyBytes: e.INGEST_MAX_BODY_KB * 1024,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    metricsToken: e.METRICS_TOKEN,
    /** The worker's /metrics port (D-84); 0 = no endpoint. */
    workerMetricsPort: e.WORKER_METRICS_PORT,
    logLevel: e.LOG_LEVEL,
    /** Base URL of the OSRS icon CDN without a trailing slash; null = icons off (D-95). */
    osrsIconsUrl: e.OSRS_ICONS_URL,
  };
}

export type HubConfig = ReturnType<typeof toConfig>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * HUB_NAME as shown and sent to the plugin: at most 64 characters (code points, so an emoji is never
 * cut in half), trimmed after the cut too, so it never ends in a space an admin can't type back
 * (the decommission switch asks for the name). Empty → the default.
 */
export function hubNameFrom(raw: string): string {
  return [...raw.trim()].slice(0, 64).join('').trim() || 'osrs-data-hub';
}

/** Parses env into HubConfig; throws ConfigError listing every invalid variable. */
export function parseConfig(env: Record<string, string | undefined> = process.env): HubConfig {
  const r = EnvSchema.safeParse(env);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = r.data;
  // Discord never includes @everyone (id = guild id) in member.roles, so requiring it rejects everyone.
  if (e.DISCORD_GUILD_ID && e.DISCORD_REQUIRED_ROLE_IDS.includes(e.DISCORD_GUILD_ID)) {
    throw new ConfigError(
      'Invalid configuration:\n  DISCORD_REQUIRED_ROLE_IDS: must not contain the guild id (@everyone); leave it empty to allow every member',
    );
  }
  return toConfig(e);
}

/**
 * LOG_LEVEL as the logger reads it. The logger exists before the config is validated (it is what
 * reports a ConfigError), so it can't take `logLevel` from getConfig(); it applies the same rule to
 * the raw value. An invalid value gives the default here, so the logger still starts and
 * parseConfig's error, which names the variable, is the one the operator sees.
 */
export function logLevelFromEnv(raw: string | undefined): HubConfig['logLevel'] {
  const r = logLevel.safeParse(raw);
  return r.success ? r.data : logLevel.parse(undefined);
}

const g = globalThis as unknown as { __hubConfig?: HubConfig };

/** Process-wide config (parsed once from process.env). */
export function getConfig(): HubConfig {
  g.__hubConfig ??= parseConfig(process.env);
  return g.__hubConfig;
}

/** Test hook: replace (or reset with undefined) the cached config. */
export function setConfigForTests(config: HubConfig | undefined): void {
  g.__hubConfig = config;
}
