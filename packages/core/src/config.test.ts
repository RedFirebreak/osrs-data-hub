import { describe, expect, it } from 'vitest';
import { hubNameFrom, logLevelFromEnv, parseConfig } from './config';

const ENV = { APP_URL: 'https://hub.example.com' };

describe('HUB_NAME', () => {
  it('is trimmed, and trimmed again after the 64-character cut (no trailing space)', () => {
    const name = `${'a'.repeat(63)} tail`;
    expect(hubNameFrom(name)).toBe('a'.repeat(63));
    expect(parseConfig({ ...ENV, HUB_NAME: `  ${name}` }).hubName).toBe('a'.repeat(63));
    expect(hubNameFrom('  Clan Hub  ')).toBe('Clan Hub');
  });

  it('cuts by code point, never inside an emoji', () => {
    const name = `${'a'.repeat(63)}🐉🐉`;
    expect(hubNameFrom(name)).toBe(`${'a'.repeat(63)}🐉`);
  });

  it('falls back to the default when empty or blank', () => {
    expect(hubNameFrom('')).toBe('osrs-data-hub');
    expect(hubNameFrom('   ')).toBe('osrs-data-hub');
    expect(parseConfig(ENV).hubName).toBe('osrs-data-hub');
  });
});

describe('WORKER_METRICS_PORT (D-84)', () => {
  it('defaults to 9464, accepts 0 (no endpoint) and rejects anything but a whole number', () => {
    expect(parseConfig(ENV).workerMetricsPort).toBe(9464);
    expect(parseConfig({ ...ENV, WORKER_METRICS_PORT: '' }).workerMetricsPort).toBe(9464);
    expect(parseConfig({ ...ENV, WORKER_METRICS_PORT: '9500' }).workerMetricsPort).toBe(9500);
    expect(parseConfig({ ...ENV, WORKER_METRICS_PORT: '0' }).workerMetricsPort).toBe(0);
    expect(() => parseConfig({ ...ENV, WORKER_METRICS_PORT: 'x' })).toThrow('WORKER_METRICS_PORT');
  });
});

describe('LOG_LEVEL', () => {
  it('is read by the logger with the config rule, and an invalid value is left to parseConfig', () => {
    expect(logLevelFromEnv(undefined)).toBe('info');
    expect(logLevelFromEnv('debug')).toBe('debug');
    expect(logLevelFromEnv('silent')).toBe('silent');
    expect(parseConfig({ ...ENV, LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
    // The logger starts at the default instead of throwing inside pino; the config names the variable.
    expect(logLevelFromEnv('verbose')).toBe('info');
    expect(() => parseConfig({ ...ENV, LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL');
  });
});

describe('DISCORD_AUTHORIZE_URL (D-101)', () => {
  it("is unset by default and when empty, so sign-in goes to Discord's own page", () => {
    expect(parseConfig(ENV).discord.authorizeUrl).toBeUndefined();
    expect(
      parseConfig({ ...ENV, DISCORD_AUTHORIZE_URL: ' ' }).discord.authorizeUrl,
    ).toBeUndefined();
  });

  it('takes the page of a stand-in for Discord', () => {
    expect(
      parseConfig({ ...ENV, DISCORD_AUTHORIZE_URL: ' http://localhost:7071/api/oauth2/authorize ' })
        .discord.authorizeUrl,
    ).toBe('http://localhost:7071/api/oauth2/authorize');
  });

  it('rejects what is not an http(s) URL, and a query the OAuth parameters would replace', () => {
    for (const value of [
      'localhost:7071/authorize',
      'ftp://localhost/authorize',
      'http://localhost:7071/authorize?as=alice',
      'http://localhost:7071/authorize#x',
      'http://user:pass@localhost:7071/authorize',
    ]) {
      expect(() => parseConfig({ ...ENV, DISCORD_AUTHORIZE_URL: value }), value).toThrow(
        'DISCORD_AUTHORIZE_URL',
      );
    }
  });
});

describe('OSRS_ICONS_URL (D-95)', () => {
  it('defaults to the icon CDN, turns icons off when empty, and strips trailing slashes', () => {
    expect(parseConfig(ENV).osrsIconsUrl).toBe('https://icons.scapekeeper.com');
    expect(parseConfig({ ...ENV, OSRS_ICONS_URL: '' }).osrsIconsUrl).toBeNull();
    expect(parseConfig({ ...ENV, OSRS_ICONS_URL: '  ' }).osrsIconsUrl).toBeNull();
    expect(parseConfig({ ...ENV, OSRS_ICONS_URL: ' http://localhost:8765// ' }).osrsIconsUrl).toBe(
      'http://localhost:8765',
    );
    expect(
      parseConfig({ ...ENV, OSRS_ICONS_URL: 'https://mirror.example/osrs-icons/' }).osrsIconsUrl,
    ).toBe('https://mirror.example/osrs-icons');
  });

  it('rejects a value that is not an http(s) URL', () => {
    expect(() => parseConfig({ ...ENV, OSRS_ICONS_URL: 'icons.example.com' })).toThrow(
      'OSRS_ICONS_URL',
    );
    expect(() => parseConfig({ ...ENV, OSRS_ICONS_URL: 'ftp://icons.example.com' })).toThrow(
      'OSRS_ICONS_URL',
    );
  });

  it('rejects a query, fragment or credentials, which icon paths would be appended after', () => {
    for (const value of [
      'https://mirror.example/?v=2',
      'https://mirror.example/#icons',
      'https://user:pass@mirror.example',
    ]) {
      expect(() => parseConfig({ ...ENV, OSRS_ICONS_URL: value }), value).toThrow('OSRS_ICONS_URL');
    }
  });
});
