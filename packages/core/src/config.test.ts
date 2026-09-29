import { describe, expect, it } from 'vitest';
import { hubNameFrom, parseConfig } from './config';

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

describe('WORKER_METRICS_PORT (D-83)', () => {
  it('defaults to 9464, accepts 0 (no endpoint) and rejects anything but a whole number', () => {
    expect(parseConfig(ENV).workerMetricsPort).toBe(9464);
    expect(parseConfig({ ...ENV, WORKER_METRICS_PORT: '' }).workerMetricsPort).toBe(9464);
    expect(parseConfig({ ...ENV, WORKER_METRICS_PORT: '9500' }).workerMetricsPort).toBe(9500);
    expect(parseConfig({ ...ENV, WORKER_METRICS_PORT: '0' }).workerMetricsPort).toBe(0);
    expect(() => parseConfig({ ...ENV, WORKER_METRICS_PORT: 'x' })).toThrow('WORKER_METRICS_PORT');
  });
});
