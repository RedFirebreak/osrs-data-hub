/**
 * Authentication of the public API (D-69, D-70, D-88): a request's bearer key into an ApiPrincipal,
 * for user and service keys alike.
 */
import {
  GUILD_AUDIENCE,
  constantTimeEqual,
  isCategory,
  sha256Hex,
  type Category,
  type Principal,
} from '@hub/core';
import { apiKeys, pgErrorCode, type ApiKeyKind, type DbOrTx } from '@hub/db';
import { eq, sql } from 'drizzle-orm';
import { loadViewer } from '../accounts/access';
import { getLogger } from '../logger';
import { parseKey } from './key-format';
import { apiKeyStatus, keyRateLimit, type KeyRow } from './keys';

/** How often `last_used_at` is written per key at most. */
export const LAST_USED_RESOLUTION_MS = 60_000;

const BEARER_RE = /^bearer +(\S+)$/i;
/** Longer Authorization headers are refused before any parsing. */
const MAX_AUTHORIZATION_LENGTH = 512;
/** Compared against when no key has the prefix, so both failures do the same work (see below). */
const NO_KEY_HASH = '0'.repeat(64);

/**
 * Who a request acts as: the key and whom the resolver evaluates for it. For a user key, `viewer` is
 * the creator as the resolver sees them, with isAdmin always false (no admin override through the
 * API, D-70) and `userId` the creator; for a service key (D-88), `viewer` is the guild audience
 * (GUILD_AUDIENCE, D-89) and `userId` is null. `categories` are the key's; `accountIds` its explicit
 * account list (internal ids), or null for 'all_visible' (always null for service keys). What the
 * key may read is evaluated on every request from these (api/access.ts).
 */
export interface ApiPrincipal {
  keyId: string;
  kind: ApiKeyKind;
  userId: string | null;
  viewer: Principal;
  categories: ReadonlySet<Category>;
  accountIds: ReadonlySet<number> | null;
  /** Requests per sliding minute this key may make (D-72, D-88). */
  rateLimitPerMinute: number;
}

/**
 * Why a request's key was refused (all answered 401; the web doesn't tell them apart):
 * missing (no Authorization header), malformed (not `Bearer ohub_<prefix>_<secret>`), unknown (no key
 * with that prefix, or a wrong secret: indistinguishable on purpose), revoked, expired, inactive_user
 * (a user key whose creator is in grace or gone; never a service key, which has no user).
 */
export type ApiAuthFailure =
  'missing' | 'malformed' | 'unknown' | 'revoked' | 'expired' | 'inactive_user';

export type ApiAuthResult =
  { ok: true; principal: ApiPrincipal } | { ok: false; reason: ApiAuthFailure };

/**
 * Authenticates an `Authorization` header value: `Bearer ohub_<prefix>_<secret>` exactly (the scheme
 * name is case-insensitive, RFC 7235; the key is not). The key is looked up by prefix and
 * sha256(secret) is compared in constant time; an unknown prefix is compared against a placeholder
 * hash, so an unknown prefix and a wrong secret do the same work and give the same reason. Only a
 * key whose secret matched can come back as revoked or expired. Then the creator is loaded
 * (loadViewer) and must be active.
 *
 * On success, `last_used_at` is written when it is older than LAST_USED_RESOLUTION_MS (one small
 * UPDATE, skipped when the loaded row is recent and never waiting for a row lock); a failure there is
 * logged by code and never fails the request.
 */
export async function authenticateApiKey(
  db: DbOrTx,
  authorization: string | null | undefined,
  now: Date = new Date(),
): Promise<ApiAuthResult> {
  if (typeof authorization !== 'string' || authorization.trim() === '') {
    return { ok: false, reason: 'missing' };
  }
  if (authorization.length > MAX_AUTHORIZATION_LENGTH) return { ok: false, reason: 'malformed' };
  const token = BEARER_RE.exec(authorization.trim())?.[1];
  const parts = token === undefined ? null : parseKey(token);
  if (parts === null) return { ok: false, reason: 'malformed' };
  const { prefix, secret } = parts;

  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.prefix, prefix));
  const matches = constantTimeEqual(sha256Hex(secret), row?.secretHash ?? NO_KEY_HASH);
  if (!row || !matches) return { ok: false, reason: 'unknown' };
  const status = apiKeyStatus(row, now);
  if (status !== 'active') return { ok: false, reason: status };
  const categories = new Set(row.categories.filter(isCategory));
  const rateLimitPerMinute = keyRateLimit(row);
  if (row.kind === 'service') {
    // Belongs to no user (D-88): nothing to load, and no offboarding can have touched it.
    await touchLastUsed(db, row, now);
    return {
      ok: true,
      principal: {
        keyId: row.id,
        kind: 'service',
        userId: null,
        viewer: GUILD_AUDIENCE,
        categories,
        accountIds: null,
        rateLimitPerMinute,
      },
    };
  }
  // A user key always has its user (the table's check constraint); fail closed otherwise.
  const viewer = row.userId === null ? null : await loadViewer(db, row.userId);
  if (!viewer || viewer.status !== 'active') return { ok: false, reason: 'inactive_user' };

  await touchLastUsed(db, row, now);
  return {
    ok: true,
    principal: {
      keyId: row.id,
      kind: 'user',
      userId: viewer.userId,
      viewer: { ...viewer, isAdmin: false },
      categories,
      accountIds: row.accountScope === 'list' ? new Set(row.accountIds ?? []) : null,
      rateLimitPerMinute,
    },
  };
}

/**
 * Writes last_used_at = now when the stored value is older than a minute. The row loaded for the
 * check says whether that can be the case, so most requests issue no write at all. The UPDATE
 * re-checks the age itself (two requests racing write once) and skips a row another transaction has
 * locked (an offboarding revoking the key, say) rather than wait for it.
 */
async function touchLastUsed(
  db: DbOrTx,
  row: Pick<KeyRow, 'id' | 'lastUsedAt'>,
  now: Date,
): Promise<void> {
  if (
    row.lastUsedAt !== null &&
    now.getTime() - row.lastUsedAt.getTime() < LAST_USED_RESOLUTION_MS
  ) {
    return;
  }
  const at = now.toISOString();
  try {
    await db.execute(sql`
      UPDATE api_keys SET last_used_at = ${at}::timestamptz
      WHERE id = (
        SELECT id FROM api_keys
        WHERE id = ${row.id}
          AND (last_used_at IS NULL
               OR last_used_at < ${at}::timestamptz - make_interval(secs => ${LAST_USED_RESOLUTION_MS / 1000}))
        FOR UPDATE SKIP LOCKED
      )`);
  } catch (err) {
    // Never the message: it lists the bound parameters (DB-3).
    getLogger().warn({ keyId: row.id, pgCode: pgErrorCode(err) }, 'api: last_used_at not updated');
  }
}
