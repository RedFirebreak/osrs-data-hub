import { describe, expect, it } from 'vitest';
import { decommissionConfirmMatches } from './admin-rules';

describe('decommissionConfirmMatches', () => {
  it('needs the hub name exactly, ignoring surrounding spaces on both sides', () => {
    expect(decommissionConfirmMatches('Test Hub', 'Test Hub')).toBe(true);
    expect(decommissionConfirmMatches('  Test Hub ', 'Test Hub')).toBe(true);
    // HUB_NAME cut to 64 characters can end on a space.
    expect(decommissionConfirmMatches('A'.repeat(63), `${'A'.repeat(63)} `)).toBe(true);
    expect(decommissionConfirmMatches('test hub', 'Test Hub')).toBe(false);
    expect(decommissionConfirmMatches('Test  Hub', 'Test Hub')).toBe(false);
    expect(decommissionConfirmMatches(undefined, 'Test Hub')).toBe(false);
    expect(decommissionConfirmMatches('', ' ')).toBe(false);
  });
});
