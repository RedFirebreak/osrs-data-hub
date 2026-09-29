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
