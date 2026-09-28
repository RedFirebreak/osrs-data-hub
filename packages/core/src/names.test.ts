import { describe, expect, it } from 'vitest';
import { normalizeName, toJagexName } from './names';

const NBSP = String.fromCharCode(0xa0);

describe('toJagexName', () => {
  // Test vectors run through the real RuneLite 1.13.0 Text.toJagexName (critic report §3.1).
  it.each([
    ['Zezima', 'Zezima'],
    [' Zezima ', 'Zezima'],
    [`Iron${NBSP}Man`, 'Iron Man'],
    ['iron_man', 'iron man'],
    ['Iron-Man', 'Iron Man'],
    ['Ir\u00f8n Man', 'Irn Man'],
    ['a  b', 'a  b'],
    [`${NBSP}lead`, 'lead'],
    ['x\u0001y', 'x\u0001y'],
    ['Mc\u00e9 Duck', 'Mc Duck'],
    ['_-_', ''],
  ])('%j → %j (matches Java)', (input, expected) => {
    expect(toJagexName(input)).toBe(expected);
  });

  it('trims every char <= U+0020 at both ends, unlike String.prototype.trim', () => {
    expect(toJagexName('\u0001\u0008 Zezima\u001f\u0000')).toBe('Zezima');
    expect(toJagexName('\t\n\r Zezima \t')).toBe('Zezima');
  });

  it('keeps DEL (U+007F), which is > U+0020', () => {
    expect(toJagexName('\u007fZezima\u007f')).toBe('\u007fZezima\u007f');
  });

  it('replaces NBSP before dropping non-ASCII, so an NBSP edge is trimmed', () => {
    expect(toJagexName(`${NBSP}${NBSP}Zezima${NBSP}`)).toBe('Zezima');
    expect(toJagexName(`a${NBSP}${NBSP}b`)).toBe('a  b');
  });

  it('does not trim Unicode spaces that JS trim would, it drops them as non-ASCII', () => {
    // U+2003 EM SPACE and U+3000 IDEOGRAPHIC SPACE are removed (non-ASCII), not replaced by a space.
    expect(toJagexName('\u2003Zezima\u3000')).toBe('Zezima');
    expect(toJagexName('Ze\u2003zima')).toBe('Zezima');
  });

  it('drops both halves of a surrogate pair', () => {
    expect(toJagexName('Ze\u{1F600}zima')).toBe('Zezima');
    expect(toJagexName('Ze\ud83dzima')).toBe('Zezima');
  });

  it('does not lowercase or collapse inner whitespace', () => {
    expect(toJagexName('Lynx__Titan')).toBe('Lynx  Titan');
    expect(toJagexName('ZEZIMA')).toBe('ZEZIMA');
  });

  it('handles empty and all-whitespace input', () => {
    expect(toJagexName('')).toBe('');
    expect(toJagexName('   ')).toBe('');
    expect(toJagexName(NBSP)).toBe('');
  });
});

describe('normalizeName', () => {
  it('is toJagexName lowercased', () => {
    expect(normalizeName('Lynx_Titan')).toBe('lynx titan');
    expect(normalizeName(`Iron${NBSP}Mira`)).toBe('iron mira');
    expect(normalizeName(' Iron-Mira ')).toBe('iron mira');
  });

  it('makes the separators RuneLite treats as equivalent compare equal', () => {
    const variants = ['Iron Mira', 'iron_mira', 'IRON-MIRA', `iron${NBSP}mira`];
    expect(new Set(variants.map(normalizeName))).toEqual(new Set(['iron mira']));
  });
});
