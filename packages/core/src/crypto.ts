import { notImplemented } from './todo';

/** 5 ASCII digits, leading zeros kept (crypto.randomInt). */
export function generatePairingCode(): string {
  return notImplemented('generatePairingCode');
}

/**
 * The plugin accepts any Unicode digit when typing (PLUGIN-6): only ^[0-9]{5}$ strings are valid.
 * Numbers are NOT accepted (a JSON number would lose leading zeros).
 */
export function isValidPairingCode(code: unknown): code is string {
  return notImplemented('isValidPairingCode');
}

/** 32 random bytes as 64 lowercase hex chars. */
export function generateDeviceToken(): string {
  return notImplemented('generateDeviceToken');
}

/** Lowercase hex sha256 of a UTF-8 string. */
export function sha256Hex(value: string): string {
  return notImplemented('sha256Hex');
}

/** Constant-time comparison of two strings (false when lengths differ). */
export function constantTimeEqual(a: string, b: string): boolean {
  return notImplemented('constantTimeEqual');
}

/** Short opaque public id for accounts: 12 chars of [0-9A-Za-z] from crypto randomness. */
export function generatePublicId(): string {
  return notImplemented('generatePublicId');
}
