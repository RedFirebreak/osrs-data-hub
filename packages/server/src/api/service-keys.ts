/**
 * Service keys, the integration keys of the public API (D-88): created and revoked by admins on
 * Admin → Integrations, they belong to no user, so offboarding anyone (the admin who created one
 * included) never revokes them and they count towards nobody's per-user limit. A service key reads
 * exactly what the guild audience sees (GUILD_AUDIENCE, D-89): the accounts and categories whose
 * sharing audience is `guild`; `private` and `selected` stay hidden, and there is no admin override
 * (D-70). Same format (key-format.ts), storage, categories and expiry as user keys (D-69, keys.ts),
 * and the same authentication (key-auth.ts); its rate limit is its own (`rateLimitPerMinute`,
 * default SERVICE_KEY_RATE_LIMIT).
 */
import { sha256Hex, type Viewer } from '@hub/core';
import { apiKeys, users, type Db, type DbOrTx } from '@hub/db';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { assertAdmin } from '../admin/errors';
import { audit } from '../audit';
import { formatKey, newKeySecret } from './key-format';
import {
  KEY_FIELD_SCHEMAS,
  expiryFrom,
  insertWithFreshPrefix,
  keyInfoOf,
  parseKeyInput,
  revokeKey,
  type ApiKeyInfo,
} from './keys';
import { MAX_KEY_RATE_LIMIT } from './limits';

/**
 * The body of "create a service key" (strict, D-10): the shared `name`, `categories` and
 * `expiresInDays` (KEY_FIELD_SCHEMAS), plus `rateLimitPerMinute`, a whole number from 1 to
 * MAX_KEY_RATE_LIMIT; omitted or null = the service default.
 */
export const CreateServiceKeySchema = z.strictObject({
  name: KEY_FIELD_SCHEMAS.name,
  categories: KEY_FIELD_SCHEMAS.categories,
  expiresInDays: KEY_FIELD_SCHEMAS.expiresInDays,
  rateLimitPerMinute: z.number().int().min(1).max(MAX_KEY_RATE_LIMIT).nullable().optional(),
});

/** A service key as the admin page shows it: an ApiKeyInfo plus who created it. */
export interface ServiceKeyInfo extends ApiKeyInfo {
  /** The admin who created it; null once that user was deleted. */
  createdBy: { id: string; name: string } | null;
}

/**
 * Creates a service key from the admin page's request body (validated with CreateServiceKeySchema; a
 * failure is ApiKeyError 'invalid' with the field issues). Returns the key, `ohub_<prefix>_<secret>`,
 * which is never stored or shown again (only sha256(secret) is kept), and its info. No per-user
 * limit: the key is nobody's. Audit: 'service_key.created' by the actor with the prefix, name,
 * categories, rate limit and expiry (never the secret or its hash).
 */
export async function createServiceKey(
  db: Db,
  opts: { actor: Viewer; input: unknown; now?: Date },
): Promise<{ key: string; info: ServiceKeyInfo }> {
  assertAdmin(opts.actor);
  const now = opts.now ?? new Date();
  const body = parseKeyInput(CreateServiceKeySchema, opts.input);
  return db.transaction(async (tx) => {
    const secret = newKeySecret();
    const expiresAt = expiryFrom(body.expiresInDays, now);
    const row = await insertWithFreshPrefix(tx, {
      kind: 'service',
      userId: null,
      createdByUserId: opts.actor.userId,
      name: body.name,
      secretHash: sha256Hex(secret),
      categories: body.categories,
      accountScope: 'all_visible',
      accountIds: null,
      rateLimitPerMinute: body.rateLimitPerMinute ?? null,
      expiresAt,
      createdAt: now,
    });
    await audit(tx, {
      actorUserId: opts.actor.userId,
      action: 'service_key.created',
      targetType: 'api_key',
      targetId: row.id,
      meta: {
        prefix: row.prefix,
        name: row.name,
        categories: body.categories,
        rateLimitPerMinute: body.rateLimitPerMinute ?? null,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    });
    const [creator] = await tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.id, opts.actor.userId));
    return {
      key: formatKey(row.prefix, secret),
      info: { ...keyInfoOf(row, null, now), createdBy: creator ?? null },
    };
  });
}

/** Every service key, newest first, revoked and expired ones included (with their status). */
export async function listServiceKeys(
  db: DbOrTx,
  now: Date = new Date(),
): Promise<ServiceKeyInfo[]> {
  const rows = await db
    .select({ key: apiKeys, creatorId: users.id, creatorName: users.name })
    .from(apiKeys)
    .leftJoin(users, eq(users.id, apiKeys.createdByUserId))
    .where(eq(apiKeys.kind, 'service'))
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
  return rows.map(({ key, creatorId, creatorName }) => ({
    ...keyInfoOf(key, null, now),
    createdBy:
      creatorId !== null && creatorName !== null ? { id: creatorId, name: creatorName } : null,
  }));
}

/**
 * Revokes a service key: the next request with it gets 401. Idempotent (a revoked key keeps its time,
 * writes no second audit entry and still returns true). False when the key doesn't exist, isn't a
 * service key, or `keyId` isn't a uuid, so the route answers 404. Audit: 'service_key.revoked' by the
 * actor with the prefix.
 */
export async function revokeServiceKey(
  db: Db,
  opts: { actor: Viewer; keyId: string; now?: Date },
): Promise<boolean> {
  assertAdmin(opts.actor);
  const scope = eq(apiKeys.kind, 'service');
  return revokeKey(db, { keyId: opts.keyId, scope, now: opts.now }, (tx, revoked) =>
    audit(tx, {
      actorUserId: opts.actor.userId,
      action: 'service_key.revoked',
      targetType: 'api_key',
      targetId: revoked.id,
      meta: { prefix: revoked.prefix, name: revoked.name },
    }),
  );
}
