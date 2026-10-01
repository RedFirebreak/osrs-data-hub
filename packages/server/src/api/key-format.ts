/**
 * The format of an API key (D-69), for user and service keys alike: generating and parsing.
 *
 * A key is `ohub_<prefix>_<secret>`: a 10-character base62 prefix, unique and stored in clear so a
 * lookup is an index hit and the owner can recognise the key, and a 43-character base62 secret
 * (≈ 256 bits) of which only sha256 is stored. The key is shown once, at creation.
 */
import { randomBytes } from 'node:crypto';

/** Every key starts with this; the part after it is `<prefix>_<secret>`. */
export const API_KEY_PREFIX = 'ohub_';

const PREFIX_LENGTH = 10;
const SECRET_LENGTH = 43;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const KEY_RE = /^ohub_([0-9A-Za-z]{10})_([0-9A-Za-z]{43})$/;

/** `length` base62 characters from crypto randomness, unbiased (bytes ≥ 248 = 4 × 62 are dropped). */
function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length + 8)) {
      if (byte >= 248) continue;
      out += BASE62.charAt(byte % 62);
      if (out.length === length) break;
    }
  }
  return out;
}

/** A random prefix for a new key (insertWithFreshPrefix takes another one on a collision). */
export function newKeyPrefix(): string {
  return randomBase62(PREFIX_LENGTH);
}

/** The secret part of a new key. */
export function newKeySecret(): string {
  return randomBase62(SECRET_LENGTH);
}

/** `ohub_<prefix>_<secret>`. */
export function formatKey(prefix: string, secret: string): string {
  return `${API_KEY_PREFIX}${prefix}_${secret}`;
}

/** The parts of `ohub_<prefix>_<secret>` exactly (case-sensitive); null for anything else. */
export function parseKey(key: string): { prefix: string; secret: string } | null {
  const parts = KEY_RE.exec(key);
  const prefix = parts?.[1];
  const secret = parts?.[2];
  return prefix === undefined || secret === undefined ? null : { prefix, secret };
}
