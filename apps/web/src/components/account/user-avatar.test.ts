import { describe, expect, it } from 'vitest';
import { initialsOf } from './user-avatar';

describe('initialsOf', () => {
  it('takes the first letters of two words, or two letters of one', () => {
    expect(initialsOf('Zezima the Great')).toBe('ZT');
    expect(initialsOf('Lynx Titan')).toBe('LT');
    expect(initialsOf('Ali')).toBe('AL');
    expect(initialsOf('  ')).toBe('?');
  });

  it('never cuts an emoji in half', () => {
    expect(initialsOf('🐉dragon')).toBe('🐉D');
    expect(initialsOf('🐉 slayer')).toBe('🐉S');
  });
});
