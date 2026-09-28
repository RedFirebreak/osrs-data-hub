import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const PAIRING_CODE_RE = /^[0-9]{5}$/;
const PUBLIC_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const PUBLIC_ID_LENGTH = 12;

/** 5 ASCII digits, leading zeros kept (crypto.randomInt). */
export function generatePairingCode(): string {
  return String(randomInt(0, 100_000)).padStart(5, '0');
}

/**
 * The plugin accepts any Unicode digit when typing (PLUGIN-6): only ^[0-9]{5}$ strings are valid.
 * Numbers are NOT accepted (a JSON number would lose leading zeros). No trimming: " 12345" and
 * "12345\n" are invalid.
 */
export function isValidPairingCode(code: unknown): code is string {
  // JS `$` (without the m flag) only matches at the very end, so a trailing newline fails too.
  return typeof code === 'string' && PAIRING_CODE_RE.test(code);
}

/** 32 random bytes as 64 lowercase hex chars. */
export function generateDeviceToken(): string {
  return randomBytes(32).toString('hex');
}

/** Lowercase hex sha256 of a UTF-8 string. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two strings (false when lengths differ, or when either isn't a string
 * at runtime). Compares UTF-16 code units, so lone surrogates don't collapse to U+FFFD as they would
 * in UTF-8. Only the length can leak through timing.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf16le');
  const bb = Buffer.from(b, 'utf16le');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Short opaque public id for accounts: 12 chars of [0-9A-Za-z] from crypto randomness (unbiased). */
export function generatePublicId(): string {
  let id = '';
  for (let i = 0; i < PUBLIC_ID_LENGTH; i++) {
    id += PUBLIC_ID_ALPHABET.charAt(randomInt(0, PUBLIC_ID_ALPHABET.length));
  }
  return id;
}
