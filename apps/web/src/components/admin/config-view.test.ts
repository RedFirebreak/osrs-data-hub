import { CONFIG_ENV_NAMES, parseConfig } from '@hub/core';
import { describe, expect, it } from 'vitest';
import { REDACTED, configSections, redactDatabaseUrl, type ConfigValue } from './config-view';

const SECRETS = {
  AUTH_SECRET: 'auth-secret-VALUE-0123456789abcdefghijklmnopq',
  DISCORD_CLIENT_SECRET: 'discord-client-secret-VALUE',
  DISCORD_BOT_TOKEN: 'discord-bot-token-VALUE.abc.def',
  METRICS_TOKEN: 'metrics-token-VALUE',
};
const DB_PASSWORD = 'db-password-VALUE';

function config(env: Record<string, string> = {}) {
  return parseConfig({
    APP_URL: 'https://hub.example.com',
    HUB_NAME: 'Test Hub',
    DATABASE_URL: `postgres://hub:${DB_PASSWORD}@db:5432/hub?sslmode=require&sslpassword=${DB_PASSWORD}`,
    DISCORD_CLIENT_ID: '123456789012345678',
    DISCORD_GUILD_ID: '100000000000000001',
    DISCORD_ADMIN_ROLE_IDS: '200000000000000001,200000000000000002',
    ...SECRETS,
    ...env,
  });
}

function valueOf(name: string, sections = configSections(config())): ConfigValue | undefined {
  return sections.flatMap((s) => s.entries).find((e) => e.name === name)?.value;
}

describe('configSections', () => {
  it('contains no secret value anywhere in its output', () => {
    const out = JSON.stringify(configSections(config()));
    for (const secret of [...Object.values(SECRETS), DB_PASSWORD]) {
      expect(out).not.toContain(secret);
      // Nor a recognisable part of one.
      expect(out).not.toContain(secret.slice(0, 12));
    }
    expect(out).not.toContain('VALUE');
  });

  it('shows secrets only as set / not set', () => {
    for (const name of Object.keys(SECRETS)) {
      expect(valueOf(name)).toEqual({ kind: 'secret', set: true });
    }
    const bare = configSections(
      parseConfig({ APP_URL: 'https://hub.example.com', HUB_NAME: 'Test Hub' }),
    );
    for (const name of Object.keys(SECRETS)) {
      expect(valueOf(name, bare)).toEqual({ kind: 'secret', set: false });
    }
    expect(valueOf('DATABASE_URL', bare)).toEqual({ kind: 'unset' });
  });

  it('shows the database URL without its password, and ordinary settings as they are', () => {
    expect(valueOf('DATABASE_URL')).toEqual({
      kind: 'redacted',
      text: `postgres://hub:${REDACTED}@db:5432/hub?sslmode=require&sslpassword=${REDACTED}`,
    });
    expect(valueOf('APP_URL')).toEqual({ kind: 'text', text: 'https://hub.example.com' });
    expect(valueOf('HUB_NAME')).toEqual({ kind: 'text', text: 'Test Hub' });
    expect(valueOf('OSRS_ICONS_URL')).toEqual({
      kind: 'text',
      text: 'https://icons.scapekeeper.com',
    });
    expect(valueOf('OSRS_ICONS_URL', configSections(config({ OSRS_ICONS_URL: '' })))).toEqual({
      kind: 'text',
      text: 'off (text only)',
    });
    expect(valueOf('DISCORD_CLIENT_ID')).toEqual({ kind: 'text', text: '123456789012345678' });
    expect(valueOf('DISCORD_ADMIN_ROLE_IDS')).toEqual({
      kind: 'list',
      items: ['200000000000000001', '200000000000000002'],
    });
    expect(valueOf('DISCORD_REQUIRED_ROLE_IDS')).toEqual({ kind: 'list', items: [] });
    expect(valueOf('OFFBOARD_GRACE_DAYS')).toEqual({ kind: 'text', text: '30 days' });
    expect(valueOf('INGEST_MAX_BODY_KB')).toEqual({ kind: 'text', text: '256 KB' });
    expect(valueOf('WORKER_METRICS_PORT')).toEqual({ kind: 'text', text: '9464' });
    expect(
      valueOf('WORKER_METRICS_PORT', configSections(config({ WORKER_METRICS_PORT: '0' }))),
    ).toEqual({ kind: 'text', text: 'off (no endpoint)' });
  });

  // The page is an allowlist, so a new variable stays off it until someone lists it here and
  // decides how to show it. This is the reminder to do that.
  it('lists every variable the configuration reads, once', () => {
    const listed = configSections(config()).flatMap((s) => s.entries.map((e) => e.name));
    expect([...listed].sort()).toEqual([...CONFIG_ENV_NAMES].sort());
  });
});

describe('redactDatabaseUrl', () => {
  it('removes the password and keeps the rest', () => {
    expect(redactDatabaseUrl('postgresql://u:p%40ss@db.internal/hub')).toEqual({
      kind: 'redacted',
      text: `postgresql://u:${REDACTED}@db.internal/hub`,
    });
    expect(redactDatabaseUrl('postgres://hub@db/hub')).toEqual({
      kind: 'redacted',
      text: 'postgres://hub@db/hub',
    });
    expect(redactDatabaseUrl('postgres:///hub?host=/var/run/postgresql')).toEqual({
      kind: 'redacted',
      text: 'postgres:///hub?host=%2Fvar%2Frun%2Fpostgresql',
    });
  });

  it('hides a URL whose credentials the parser would put elsewhere, or that does not parse', () => {
    for (const url of [
      'postgres:hub:secretpw@db/hub',
      'postgres://hub:12/secretpw@db/hub',
      'postgres://hub:12?secretpw@db/hub',
      'postgres://hub:12#secretpw@db/hub',
      'not a url secretpw',
    ]) {
      const value = redactDatabaseUrl(url);
      expect(value).toEqual({ kind: 'secret', set: true });
      expect(JSON.stringify(value)).not.toContain('secretpw');
    }
    expect(redactDatabaseUrl(undefined)).toEqual({ kind: 'unset' });
    expect(redactDatabaseUrl('  ')).toEqual({ kind: 'unset' });
  });
});
