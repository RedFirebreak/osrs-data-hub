import { fixtureJson } from '@hub/fixtures';
import { describe, expect, it } from 'vitest';
import {
  constantTimeEqual,
  generateDeviceToken,
  generatePairingCode,
  generatePublicId,
  isValidPairingCode,
  sha256Hex,
} from './crypto';

describe('generatePairingCode', () => {
  it('is always 5 ASCII digits and valid', () => {
    for (let i = 0; i < 2_000; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(/^[0-9]{5}$/);
      expect(isValidPairingCode(code)).toBe(true);
    }
  });

  it('keeps leading zeros and covers the whole 00000–99999 range', () => {
    const codes = Array.from({ length: 5_000 }, () => generatePairingCode());
    // P(no code below 10000 in 5000 draws) = 0.9^5000 ≈ 0.
    expect(codes.some((c) => c.startsWith('0'))).toBe(true);
    expect(codes.some((c) => c.startsWith('9'))).toBe(true);
    const firstDigits = new Set(codes.map((c) => c[0]));
    expect(firstDigits.size).toBe(10);
  });

  it('is random', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generatePairingCode()));
    // 200 draws from 100k: a handful of collisions at most.
    expect(codes.size).toBeGreaterThan(190);
  });
});

describe('isValidPairingCode', () => {
  it('accepts 5 ASCII digit strings, leading zeros included', () => {
    for (const code of ['12345', '00000', '99999', '01234', '00001'])
      expect(isValidPairingCode(code)).toBe(true);
  });

  it('accepts the fixture pairing body code (a JSON string with a leading zero)', () => {
    const { code } = fixtureJson<{ code: unknown }>('pair-request');
    expect(code).toBe('04817');
    expect(isValidPairingCode(code)).toBe(true);
  });

  it('rejects numbers (a JSON number would lose leading zeros)', () => {
    for (const code of [12345, 4817, 0, 99999, Number.NaN, 12345n])
      expect(isValidPairingCode(code)).toBe(false);
  });

  it('rejects the wrong length', () => {
    for (const code of ['', '1', '1234', '123456', '0000000'])
      expect(isValidPairingCode(code)).toBe(false);
  });

  it('rejects whitespace (no trimming)', () => {
    for (const code of [
      ' 12345',
      '12345 ',
      '12345\n',
      '\n12345',
      '123 45',
      '\t12345',
      '12345\r\n',
    ]) {
      expect(isValidPairingCode(code)).toBe(false);
    }
  });

  it('rejects non-ASCII Unicode digits the plugin lets through when typing (PLUGIN-6)', () => {
    for (const code of [
      '١٢٣٤٥', // Arabic-Indic
      '۱۲۳۴۵', // Extended Arabic-Indic (Persian)
      '१२३४५', // Devanagari
      '１２３４５', // Fullwidth
      '1234５', // one fullwidth digit
      '𝟏𝟐𝟑𝟒𝟓', // Mathematical bold (surrogate pairs)
    ]) {
      expect(isValidPairingCode(code)).toBe(false);
    }
  });

  it('rejects letters, signs and number syntax', () => {
    for (const code of [
      '12a45',
      'abcde',
      '+1234',
      '-1234',
      '1.234',
      '1e345',
      '0x123',
      '12_45',
      '12,45',
    ]) {
      expect(isValidPairingCode(code)).toBe(false);
    }
  });

  it('rejects non-strings', () => {
    for (const code of [
      null,
      undefined,
      true,
      {},
      ['12345'],
      { code: '12345' },
      new String('12345'),
    ]) {
      expect(isValidPairingCode(code)).toBe(false);
    }
  });
});

describe('generateDeviceToken', () => {
  it('is 64 lowercase hex chars (32 bytes)', () => {
    for (let i = 0; i < 100; i++) expect(generateDeviceToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is unique', () => {
    const tokens = new Set(Array.from({ length: 1_000 }, () => generateDeviceToken()));
    expect(tokens.size).toBe(1_000);
  });
});

describe('sha256Hex', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes UTF-8 bytes', () => {
    // U+00E9 as UTF-8 (c3 a9), not Latin-1 (e9).
    expect(sha256Hex('é')).toBe('4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c');
    expect(sha256Hex('pairing ✓ 🐉')).toBe(
      '5ba209dbcc6ff4a8858a47582a26ea9da90198b5ac4c471c651ac9dc9e9e860e',
    );
  });

  it('gives 64 lowercase hex chars for a device token', () => {
    const token = generateDeviceToken();
    const hash = sha256Hex(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);
    expect(sha256Hex(token)).toBe(hash);
  });
});

describe('constantTimeEqual', () => {
  it('is true for equal strings', () => {
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    const hash = sha256Hex(generateDeviceToken());
    expect(constantTimeEqual(hash, `${hash}`)).toBe(true);
    expect(constantTimeEqual('é🐉', 'é🐉')).toBe(true);
  });

  it('is false for different strings of the same length', () => {
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'ABC')).toBe(false);
    const a = sha256Hex('a');
    expect(constantTimeEqual(a, sha256Hex('b'))).toBe(false);
    expect(constantTimeEqual(a, a.slice(0, -1) + (a.endsWith('0') ? '1' : '0'))).toBe(false);
  });

  it('is false when lengths differ', () => {
    expect(constantTimeEqual('', 'a')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('abcd', 'abc')).toBe(false);
  });

  it("doesn't confuse strings that encode alike in UTF-8", () => {
    // Lone surrogates both become U+FFFD in UTF-8.
    expect(constantTimeEqual('\uD800', '\uDC00')).toBe(false);
    expect(constantTimeEqual('\uD800', '�')).toBe(false);
    // Precomposed vs combining é.
    expect(constantTimeEqual('é', 'é')).toBe(false);
  });

  it('is false for non-strings at runtime', () => {
    const bad = (v: unknown) => v as string;
    expect(constantTimeEqual(bad(undefined), 'a')).toBe(false);
    expect(constantTimeEqual('a', bad(null))).toBe(false);
    expect(constantTimeEqual(bad(undefined), bad(undefined))).toBe(false);
    expect(constantTimeEqual(bad(123), '123')).toBe(false);
  });
});

describe('generatePublicId', () => {
  it('is 12 chars of [0-9A-Za-z]', () => {
    for (let i = 0; i < 500; i++) expect(generatePublicId()).toMatch(/^[0-9A-Za-z]{12}$/);
  });

  it('is unique', () => {
    const ids = new Set(Array.from({ length: 2_000 }, () => generatePublicId()));
    expect(ids.size).toBe(2_000);
  });

  it('uses the whole alphabet', () => {
    const chars = new Set(Array.from({ length: 2_000 }, () => generatePublicId()).join(''));
    // 24k draws over 62 symbols: P(one missing) ≈ 62 × (61/62)^24000 ≈ 0.
    expect(chars.size).toBe(62);
  });
});
