import { describe, expect, it } from 'vitest';
import { normalizeDiscordUsername } from './friends';

describe('normalizeDiscordUsername', () => {
  it('trims, drops a leading @ and lowercases', () => {
    expect(normalizeDiscordUsername('  @Mock.Stranger ')).toBe('mock.stranger');
    expect(normalizeDiscordUsername('zezima_99')).toBe('zezima_99');
  });

  it("refuses what Discord doesn't allow as a username", () => {
    for (const text of ['', 'a', 'x'.repeat(33), 'two words', 'old#1234', 'a..b', 'émile', '@']) {
      expect(normalizeDiscordUsername(text)).toBeNull();
    }
    expect(normalizeDiscordUsername('x'.repeat(32))).toBe('x'.repeat(32));
  });
});
