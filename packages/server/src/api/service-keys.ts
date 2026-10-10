/**
 * Service keys, the integration keys of the public API (D-88): created, edited, revoked and deleted
 * by admins on Admin → Integrations (D-111), they belong to no user, so offboarding anyone (the admin who created one
 * included) never revokes them and they count towards nobody's per-user limit. A service key reads
 * exactly what the guild audience sees (GUILD_AUDIENCE, D-89): the accounts and categories whose
 * sharing audience is `guild`; `private` and `selected` stay hidden, and there is no admin override
 * (D-70). Same format (key-format.ts), storage, categories and expiry as user keys (D-69, keys.ts),
 * and the same authentication (key-auth.ts); its rate limit is its own (`rateLimitPerMinute`,
 * default SERVICE_KEY_RATE_LIMIT).
 */
import { sha256Hex, type Viewer } from '@hub/core';
import { apiKeys, users, type Db, type DbOrTx } from '@hub/db';
import { desc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { assertAdmin } from '../admin/errors';
import { audit } from '../audit';
import { formatKey, newKeySecret } from './key-format';
import {
  KEY_FIELD_SCHEMAS,
  deleteKey,
  expiryFrom,
  insertWithFreshPrefix,
  keyChanges,
  keyInfoOf,
  parseKeyInput,
  refineNotEmpty,
  revokeKey,
  updateKey,
  type ApiKeyInfo,
  type KeyChanges,
  type KeyRow,
} from './keys';
import { MAX_KEY_RATE_LIMIT } from './limits';

/**
 * The body of "create a service key" (strict, D-10): the shared `name`, `categories` and
 * `expiresInDays` (KEY_FIELD_SCHEMAS), plus `rateLimitPerMinute`, a whole number from 1 to
 * MAX_KEY_RATE_LIMIT; omitted or null = the service default.
 */
const RATE_LIMIT = z.number().int().min(1).max(MAX_KEY_RATE_LIMIT).nullable().optional();

export const CreateServiceKeySchema = z.strictObject({
  name: KEY_FIELD_SCHEMAS.name,
  categories: KEY_FIELD_SCHEMAS.categories,
  expiresInDays: KEY_FIELD_SCHEMAS.expiresInDays,
  rateLimitPerMinute: RATE_LIMIT,
});

/**
 * The body of "edit a service key" (D-111; strict, D-10): `name`, `categories` and
 * `rateLimitPerMinute` (null = back to the service default), each optional and as on creation, at
 * least one. The expiry can't be changed, and the account scope of a service key is always the guild
 * audience (D-89).
 */
export const UpdateServiceKeySchema = z
  .strictObject({
    name: KEY_FIELD_SCHEMAS.name.optional(),
    categories: KEY_FIELD_SCHEMAS.categories.optional(),
    rateLimitPerMinute: RATE_LIMIT,
  })
  .superRefine(refineNotEmpty);

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
 * Edits a service key (D-111): its name, the categories it reads and its rate limit. The secret stays,
 * so the integration using it keeps its configuration and reads what the key reads now from its next
 * request on; that is how an integration gains a category added after its key was made (the live
 * map and `hiscores`, D-105) without a new key. Only an active key (else ApiKeyError 'conflict');
 * a body UpdateServiceKeySchema refuses is 'invalid'. Null when the key doesn't exist, isn't a
 * service key, or `keyId` isn't a uuid (404). Audit: 'service_key.updated' by the actor with what
 * changed, only when something did.
 */
export async function updateServiceKey(
  db: Db,
  opts: { actor: Viewer; keyId: string; input: unknown; now?: Date },
): Promise<ServiceKeyInfo | null> {
  assertAdmin(opts.actor);
  const body = parseKeyInput(UpdateServiceKeySchema, opts.input);
  const now = opts.now ?? new Date();
  const row = await updateKey(
    db,
    { keyId: opts.keyId, scope: SERVICE_SCOPE, now },
    () => {
      const values: KeyChanges = {};
      if (body.name !== undefined) values.name = body.name;
      if (body.categories !== undefined) values.categories = body.categories;
      if (body.rateLimitPerMinute !== undefined)
        values.rateLimitPerMinute = body.rateLimitPerMinute;
      return Promise.resolve(values);
    },
    (tx, before, after) =>
      audit(tx, {
        actorUserId: opts.actor.userId,
        action: 'service_key.updated',
        targetType: 'api_key',
        targetId: after.id,
        meta: { prefix: after.prefix, name: after.name, changes: keyChanges(before, after) },
      }),
  );
  return row ? serviceKeyInfoOf(db, row, now) : null;
}

/**
 * Deletes a service key once it is revoked or expired (D-111), so it leaves Admin → Integrations; the
 * audit trail keeps its history. An active key must be revoked first (ApiKeyError 'conflict'). False
 * when the key doesn't exist (deleted already included), isn't a service key, or `keyId` isn't a
 * uuid (404). Audit: 'service_key.deleted' by the actor with the prefix and name.
 */
export async function deleteServiceKey(
  db: Db,
  opts: { actor: Viewer; keyId: string; now?: Date },
): Promise<boolean> {
  assertAdmin(opts.actor);
  return deleteKey(db, { keyId: opts.keyId, scope: SERVICE_SCOPE, now: opts.now }, (tx, deleted) =>
    audit(tx, {
      actorUserId: opts.actor.userId,
      action: 'service_key.deleted',
      targetType: 'api_key',
      targetId: deleted.id,
      meta: { prefix: deleted.prefix, name: deleted.name, status: deleted.status },
    }),
  );
}

const SERVICE_SCOPE: SQL = eq(apiKeys.kind, 'service');

/** A service key row as the admin page shows it, with its creator. */
async function serviceKeyInfoOf(db: DbOrTx, row: KeyRow, now: Date): Promise<ServiceKeyInfo> {
  const [creator] = row.createdByUserId
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(eq(users.id, row.createdByUserId))
    : [];
  return { ...keyInfoOf(row, null, now), createdBy: creator ?? null };
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
  return revokeKey(db, { keyId: opts.keyId, scope: SERVICE_SCOPE, now: opts.now }, (tx, revoked) =>
    audit(tx, {
      actorUserId: opts.actor.userId,
      action: 'service_key.revoked',
      targetType: 'api_key',
      targetId: revoked.id,
      meta: { prefix: revoked.prefix, name: revoked.name },
    }),
  );
}
