import { describe, expect, it } from 'vitest';
import { isUuid } from './uuid';

describe('isUuid', () => {
  it('accepts canonical uuids only', () => {
    expect(isUuid('01900000-0000-7000-8000-000000000000')).toBe(true);
    expect(isUuid('01900000-0000-7000-8000-00000000000')).toBe(false);
    expect(isUuid("1' or 1=1")).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});
