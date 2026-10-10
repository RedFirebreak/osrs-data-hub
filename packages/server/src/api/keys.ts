/**
 * API keys for the public, pull-only REST API (handoff §13, D-69, D-70, D-76): a member's own keys
 * (create, list, edit, revoke, delete once dead, D-111) and what they share with service keys (D-88,
 * managed in service-keys.ts): the row, its status and rate limit, the fields both kinds are created
 * with, and the edit, revoke and delete that both kinds go through. The key format is
 * in key-format.ts, authenticating a request in key-auth.ts.
 */
import { CATEGORIES, DAY_MS, sha256Hex, type Category } from '@hub/core';
import { apiKeys, osrsAccounts, users, type ApiKeyKind, type Db, type DbOrTx } from '@hub/db';
import { and, count, desc, eq, gt, inArray, isNull, not, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { loadViewer } from '../accounts/access';
import { loadVisibleAccounts } from '../accounts/load';
import { audit } from '../audit';
import { isUuid } from '../uuid';
import { formatKey, newKeyPrefix, newKeySecret } from './key-format';
import { API_RATE_LIMIT, SERVICE_KEY_RATE_LIMIT } from './limits';
import { isPublicIdLike } from './params';

/** Most active (neither revoked nor expired) keys one user may hold at once (D-69). */
export const MAX_ACTIVE_KEYS = 10;
/** Longest key name, in characters (code points), after trimming. */
export const API_KEY_NAME_MAX = 64;
/** Longest expiry a key can be created with. */
export const API_KEY_MAX_EXPIRY_DAYS = 365;
/** Most accounts a key with an explicit account list may name. */
export const MAX_KEY_ACCOUNTS = 500;

export type ApiKeyScope = 'all_visible' | 'list';
export type ApiKeyStatus = 'active' | 'expired' | 'revoked';

/** An account named by a key with an explicit account list. */
export interface ApiKeyAccount {
  publicId: string;
  /**
   * The account's current name; null once the key's creator may no longer see it, so a rename after
   * they lost access doesn't reach them (the devices page drops such accounts for the same reason).
   */
  name: string | null;
  /**
   * Whether the key's creator may still see the account. Accounts that are no longer visible stay
   * listed, so the owner can see why the key returns less and replace it; the API itself answers 404
   * for them (D-70).
   */
  visible: boolean;
}

/** A key as its owner sees it on the API keys page. Never contains the secret or its hash. */
export interface ApiKeyInfo {
  id: string;
  /** `user` (a member's own key) or `service` (an admin-created integration key, D-88). */
  kind: ApiKeyKind;
  name: string;
  /** The 10-character prefix; the page shows the key as `ohub_<prefix>_…`. */
  prefix: string;
  /** In the order of CATEGORIES. */
  categories: Category[];
  accountScope: ApiKeyScope;
  /**
   * For 'list', the named accounts, visible ones first by name (deleted accounts drop out); null for
   * 'all_visible'.
   */
  accounts: ApiKeyAccount[] | null;
  /** Requests per sliding minute: the key's own limit, or the default of its kind (D-72, D-88). */
  rateLimitPerMinute: number;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** revoked wins over expired. */
  status: ApiKeyStatus;
}

/**
 * Why a key operation refused: invalid → 400 (with `issues`), limit → 409, not_found → 404, conflict
 * → 409 (the key's status doesn't allow it: editing a key that is no longer active, deleting one
 * that still is, D-111).
 */
export type ApiKeyErrorCode = 'invalid' | 'limit' | 'not_found' | 'conflict';

export interface ApiKeyIssue {
  /** Dotted path of the offending field ('' for the whole body), e.g. 'name', 'accountPublicIds'. */
  path: string;
  message: string;
}

/** A refused key operation. The message is safe to show to the key's owner. */
export class ApiKeyError extends Error {
  override name = 'ApiKeyError';

  constructor(
    readonly code: ApiKeyErrorCode,
    message: string,
    readonly issues: ApiKeyIssue[] = [],
  ) {
    super(message);
  }
}

/** Control characters become spaces (NUL would fail in Postgres, DB-1), then trimmed. */
function normalizeKeyName(name: string): string {
  return name.replace(/\p{Cc}/gu, ' ').trim();
}

/** The fields user and service keys share (D-69): name, categories, expiry. */
export const KEY_FIELD_SCHEMAS = {
  name: z
    .string()
    .max(1024)
    .transform(normalizeKeyName)
    .refine((name) => name.length > 0, 'name must not be empty')
    .refine(
      (name) => Array.from(name).length <= API_KEY_NAME_MAX,
      `name must be at most ${API_KEY_NAME_MAX} characters`,
    ),
  categories: z
    .array(z.enum(CATEGORIES))
    .min(1, 'choose at least one category')
    .max(64)
    .transform((list) => CATEGORIES.filter((c) => list.includes(c))),
  expiresInDays: z.number().int().min(1).max(API_KEY_MAX_EXPIRY_DAYS).nullable().optional(),
};

/** An explicit account list: account ids, at least one, duplicates dropped. */
const ACCOUNT_PUBLIC_IDS = z
  .array(z.string().refine(isPublicIdLike, 'not an account id'))
  .min(1, 'choose at least one account')
  .max(MAX_KEY_ACCOUNTS)
  .transform((ids) => [...new Set(ids)]);

/** `accountPublicIds` goes with, and only with, `accountScope: 'list'`. */
function refineAccountList(
  body: { accountScope?: ApiKeyScope | undefined; accountPublicIds?: string[] | undefined },
  ctx: z.RefinementCtx,
): void {
  if (body.accountScope === 'list' && body.accountPublicIds === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['accountPublicIds'],
      message: 'required when accountScope is "list"',
    });
  }
  if (body.accountScope !== 'list' && body.accountPublicIds !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['accountPublicIds'],
      message: 'only allowed when accountScope is "list"',
    });
  }
}

/**
 * The body of "create a key" (D-69, D-10: strict, unknown keys rejected):
 * - `name`: 1–64 characters after trimming (control characters become spaces);
 * - `categories`: a non-empty list of CATEGORIES, duplicates dropped, returned in CATEGORIES order;
 * - `accountScope`: 'all_visible' (whatever the creator can see, evaluated on every request) or
 *   'list';
 * - `accountPublicIds`: required and non-empty for 'list', forbidden otherwise; duplicates dropped.
 *   createApiKey also checks that every one is an account the creator can see right now;
 * - `expiresInDays`: a whole number of days from 1 to 365; omitted or null = never expires.
 */
export const CreateApiKeySchema = z
  .strictObject({
    name: KEY_FIELD_SCHEMAS.name,
    categories: KEY_FIELD_SCHEMAS.categories,
    accountScope: z.enum(['all_visible', 'list']),
    accountPublicIds: ACCOUNT_PUBLIC_IDS.optional(),
    expiresInDays: KEY_FIELD_SCHEMAS.expiresInDays,
  })
  .superRefine(refineAccountList);

/** A body that names no field to change. */
export function refineNotEmpty(body: object, ctx: z.RefinementCtx): void {
  if (Object.values(body).every((v) => v === undefined)) {
    ctx.addIssue({ code: 'custom', path: [], message: 'nothing to change' });
  }
}

/**
 * The body of "edit a key" (D-111; strict, D-10): what the key reads, never the key itself. Each
 * field is optional and as in CreateApiKeySchema: `name`, `categories`, and `accountScope` with
 * `accountPublicIds` (required with 'list', forbidden otherwise; setting a scope replaces the whole
 * account list). At least one field. The expiry can't be changed: a key's lifetime is decided when
 * it is handed out.
 */
export const UpdateApiKeySchema = z
  .strictObject({
    name: KEY_FIELD_SCHEMAS.name.optional(),
    categories: KEY_FIELD_SCHEMAS.categories.optional(),
    accountScope: z.enum(['all_visible', 'list']).optional(),
    accountPublicIds: ACCOUNT_PUBLIC_IDS.optional(),
  })
  .superRefine(refineAccountList)
  .superRefine(refineNotEmpty);

export type KeyRow = typeof apiKeys.$inferSelect;

/** The key's requests per minute: its own, else the default of its kind (D-72, D-88). */
export function keyRateLimit(row: Pick<KeyRow, 'kind' | 'rateLimitPerMinute'>): number {
  return (
    row.rateLimitPerMinute ?? (row.kind === 'service' ? SERVICE_KEY_RATE_LIMIT : API_RATE_LIMIT)
  );
}

/** revoked, else expired (expiresAt at or before now), else active. */
export function apiKeyStatus(
  row: Pick<KeyRow, 'revokedAt' | 'expiresAt'>,
  now: Date,
): ApiKeyStatus {
  if (row.revokedAt !== null) return 'revoked';
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/** `schema.parse(input)`, but a failure is ApiKeyError 'invalid' with the field issues. */
export function parseKeyInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data as z.output<S>;
  const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  const first = issues[0];
  const message = first ? (first.path ? `${first.path}: ${first.message}` : first.message) : '';
  throw new ApiKeyError('invalid', message || 'invalid API key request', issues);
}

/**
 * Creates a key for `userId` from the page's request body (validated with CreateApiKeySchema; a
 * failure is ApiKeyError 'invalid' with the field issues). Returns the key, `ohub_<prefix>_<secret>`,
 * which is never stored or shown again (only sha256(secret) is kept), and its info.
 *
 * In one transaction that first locks the creator's row (FOR NO KEY UPDATE, the lock offboarding
 * takes too), so two creations can't both pass the limit, and a key can't be created by a user whose
 * offboarding (which revokes every key) is committing at the same time:
 * - the creator must exist (else 'not_found') and be active (else 'invalid');
 * - at most MAX_ACTIVE_KEYS active keys (not revoked, not expired): the next one is 'limit';
 * - for 'list', every account id must be one the creator can see right now, without any admin
 *   override (the API never applies it, D-70), else 'invalid'.
 * Audit: 'api_key.created' with the prefix, name, categories, scope and expiry (never the secret or
 * its hash).
 */
export async function createApiKey(
  db: Db,
  userId: string,
  input: unknown,
  now: Date = new Date(),
): Promise<{ key: string; info: ApiKeyInfo }> {
  const body = parseKeyInput(CreateApiKeySchema, input);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lock_timeout', '3s', true)`);
    const [user] = await tx
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .for('no key update');
    if (!user) throw new ApiKeyError('not_found', 'user not found');
    if (user.status !== 'active') {
      throw new ApiKeyError('invalid', 'only active members can create API keys');
    }
    const [active] = await tx
      .select({ n: count() })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), activeKeyFilter(now)));
    if ((active?.n ?? 0) >= MAX_ACTIVE_KEYS) {
      throw new ApiKeyError(
        'limit',
        `you already have ${MAX_ACTIVE_KEYS} active API keys; revoke one first`,
      );
    }
    const accounts =
      body.accountScope === 'list'
        ? await visibleListAccounts(tx, userId, body.accountPublicIds ?? [])
        : null;

    const secret = newKeySecret();
    const expiresAt = expiryFrom(body.expiresInDays, now);
    const row = await insertWithFreshPrefix(tx, {
      kind: 'user',
      userId,
      createdByUserId: userId,
      name: body.name,
      secretHash: sha256Hex(secret),
      categories: body.categories,
      accountScope: body.accountScope,
      accountIds: accounts?.map((a) => a.id) ?? null,
      expiresAt,
      createdAt: now,
    });
    await audit(tx, {
      actorUserId: userId,
      action: 'api_key.created',
      targetType: 'api_key',
      targetId: row.id,
      meta: {
        prefix: row.prefix,
        name: row.name,
        categories: body.categories,
        accountScope: body.accountScope,
        accountCount: accounts?.length ?? null,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    });
    const listed = accounts?.map(({ publicId, name }) => ({ publicId, name, visible: true }));
    return {
      key: formatKey(row.prefix, secret),
      info: keyInfoOf(row, listed ?? null, now),
    };
  });
}

/** `expiresInDays` from now, or null for "never". */
export function expiryFrom(expiresInDays: number | null | undefined, now: Date): Date | null {
  return expiresInDays === undefined || expiresInDays === null
    ? null
    : new Date(now.getTime() + expiresInDays * DAY_MS);
}

/** Not revoked and not expired at `now`. */
export function activeKeyFilter(now: Date): SQL | undefined {
  return and(isNull(apiKeys.revokedAt), or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)));
}

/**
 * The accounts behind `publicIds`, each of which the creator must be able to see (resolveAccess
 * `visible`, no admin override: loadVisibleAccounts with a restriction to those ids and every
 * category). Anything else, unknown or not visible alike, is ApiKeyError 'invalid'.
 */
async function visibleListAccounts(
  tx: DbOrTx,
  userId: string,
  publicIds: readonly string[],
): Promise<{ id: number; publicId: string; name: string }[]> {
  const rows = await tx
    .select({ id: osrsAccounts.id, publicId: osrsAccounts.publicId })
    .from(osrsAccounts)
    .where(inArray(osrsAccounts.publicId, [...publicIds]));
  const viewer = await loadViewer(tx, userId);
  const visible = viewer
    ? await loadVisibleAccounts(tx, viewer, {
        categories: new Set(CATEGORIES),
        accountIds: new Set(rows.map((r) => r.id)),
      })
    : [];
  const byPublicId = new Map(visible.map((e) => [e.account.publicId, e.account]));
  const missing = publicIds.filter((id) => !byPublicId.has(id));
  if (missing.length > 0) {
    throw new ApiKeyError('invalid', `account not found: ${missing.join(', ')}`, [
      { path: 'accountPublicIds', message: `account not found: ${missing.join(', ')}` },
    ]);
  }
  return publicIds.map((id) => {
    const account = byPublicId.get(id) as { id: number; publicId: string; name: string };
    return { id: account.id, publicId: account.publicId, name: account.name };
  });
}

/**
 * Inserts the key under a fresh random prefix. A prefix collision (62^10 possibilities, so in
 * practice never) takes another one; ON CONFLICT keeps the transaction usable for the retry.
 */
export async function insertWithFreshPrefix(
  tx: DbOrTx,
  values: Omit<typeof apiKeys.$inferInsert, 'prefix'>,
): Promise<KeyRow> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [row] = await tx
      .insert(apiKeys)
      .values({ ...values, prefix: newKeyPrefix() })
      .onConflictDoNothing({ target: apiKeys.prefix })
      .returning();
    if (row) return row;
  }
  throw new Error('createApiKey: no free key prefix');
}

/** A row as its page shows it (never the hash). */
export function keyInfoOf(row: KeyRow, accounts: ApiKeyAccount[] | null, now: Date): ApiKeyInfo {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    prefix: row.prefix,
    categories: CATEGORIES.filter((c) => row.categories.includes(c)),
    accountScope: row.accountScope,
    accounts: row.accountScope === 'list' ? (accounts ?? []) : null,
    rateLimitPerMinute: keyRateLimit(row),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    status: apiKeyStatus(row, now),
  };
}

/**
 * The user's keys, newest first, revoked and expired ones included (with their status). For keys
 * with an account list, the named accounts that still exist, each flagged `visible` when the user
 * may still see it (resolveAccess without admin override).
 */
export async function listApiKeys(
  db: DbOrTx,
  userId: string,
  now: Date = new Date(),
): Promise<ApiKeyInfo[]> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
  const ids = new Set<number>();
  for (const row of rows) for (const id of row.accountIds ?? []) ids.add(id);
  const accounts = await loadListedAccounts(db, userId, ids);
  return rows.map((row) => {
    const listed = (row.accountIds ?? [])
      .map((id) => accounts.get(id))
      .filter((a): a is ApiKeyAccount => a !== undefined)
      .sort(byNameThenHidden);
    return keyInfoOf(row, listed, now);
  });
}

/** The accounts with these ids (deleted ones are absent) and whether the user may still see each. */
async function loadListedAccounts(
  db: DbOrTx,
  userId: string,
  ids: ReadonlySet<number>,
): Promise<Map<number, ApiKeyAccount>> {
  const out = new Map<number, ApiKeyAccount>();
  if (ids.size === 0) return out;
  const rows = await db
    .select({
      id: osrsAccounts.id,
      publicId: osrsAccounts.publicId,
      name: osrsAccounts.currentName,
    })
    .from(osrsAccounts)
    .where(inArray(osrsAccounts.id, [...ids]));
  const viewer = await loadViewer(db, userId);
  const visible = viewer
    ? await loadVisibleAccounts(db, viewer, { categories: new Set(CATEGORIES), accountIds: ids })
    : [];
  const visibleIds = new Set(visible.map((e) => e.account.id));
  for (const r of rows) {
    const isVisible = visibleIds.has(r.id);
    out.set(r.id, { publicId: r.publicId, name: isVisible ? r.name : null, visible: isVisible });
  }
  return out;
}

/** Visible accounts by name, then the ones the creator no longer sees, by public id. */
function byNameThenHidden(a: ApiKeyAccount, b: ApiKeyAccount): number {
  if (a.name !== null && b.name !== null) {
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  }
  if (a.name !== null) return -1;
  if (b.name !== null) return 1;
  return a.publicId.localeCompare(b.publicId);
}

/**
 * Revokes one of the user's own keys (service keys are revoked through revokeServiceKey, D-88). The
 * next request with it gets 401. Idempotent: revoking a revoked key keeps its time, writes no second
 * audit entry and still returns true. False when the key doesn't exist, isn't the user's, or `keyId`
 * isn't a uuid, so the route answers 404 without revealing other users' keys. A key revoked by
 * offboarding stays revoked when the user is restored.
 * Audit: 'api_key.revoked' with the owner and the prefix (`asAdmin` is always false: nobody revokes
 * another user's key; the field keeps stored entries one shape).
 */
export async function revokeApiKey(
  db: Db,
  opts: { userId: string; keyId: string; now?: Date },
): Promise<boolean> {
  const scope = and(eq(apiKeys.kind, 'user'), eq(apiKeys.userId, opts.userId));
  return revokeKey(db, { keyId: opts.keyId, scope, now: opts.now }, (tx, revoked) =>
    audit(tx, {
      actorUserId: opts.userId,
      action: 'api_key.revoked',
      targetType: 'api_key',
      targetId: revoked.id,
      meta: { ownerUserId: revoked.userId, prefix: revoked.prefix, asAdmin: false },
    }),
  );
}

/**
 * Edits one of the user's own keys (D-111): its name, its categories and its account scope, from the
 * page's request body (UpdateApiKeySchema; a failure is ApiKeyError 'invalid'). The secret, prefix,
 * expiry and creation time stay: an app using the key keeps working and reads what the key reads
 * now from its next request on (access is evaluated per request, D-70). A 'list' scope may only name
 * accounts the user can see right now, as on creation; accounts the user no longer sees therefore
 * drop out of a list that is saved again. Only an active key can be edited (else 'conflict').
 * Returns the key's info, or null when the key doesn't exist, isn't the user's, or `keyId` isn't a
 * uuid (the route answers 404). Audit: 'api_key.updated' with what changed, only when something did.
 */
export async function updateApiKey(
  db: Db,
  opts: { userId: string; keyId: string; input: unknown; now?: Date },
): Promise<ApiKeyInfo | null> {
  const body = parseKeyInput(UpdateApiKeySchema, opts.input);
  const now = opts.now ?? new Date();
  const scope = and(eq(apiKeys.kind, 'user'), eq(apiKeys.userId, opts.userId));
  const row = await updateKey(
    db,
    { keyId: opts.keyId, scope, now },
    async (tx) => {
      const values: KeyChanges = {};
      if (body.name !== undefined) values.name = body.name;
      if (body.categories !== undefined) values.categories = body.categories;
      if (body.accountScope !== undefined) {
        values.accountScope = body.accountScope;
        values.accountIds =
          body.accountScope === 'list'
            ? (await visibleListAccounts(tx, opts.userId, body.accountPublicIds ?? [])).map(
                (a) => a.id,
              )
            : null;
      }
      return values;
    },
    (tx, before, after) =>
      audit(tx, {
        actorUserId: opts.userId,
        action: 'api_key.updated',
        targetType: 'api_key',
        targetId: after.id,
        meta: { prefix: after.prefix, name: after.name, changes: keyChanges(before, after) },
      }),
  );
  if (!row) return null;
  const accounts = await loadListedAccounts(db, opts.userId, new Set(row.accountIds ?? []));
  const listed = (row.accountIds ?? [])
    .map((id) => accounts.get(id))
    .filter((a): a is ApiKeyAccount => a !== undefined)
    .sort(byNameThenHidden);
  return keyInfoOf(row, listed, now);
}

/**
 * Deletes one of the user's own keys once it is revoked or expired (D-111): the row goes, so the
 * key leaves the page; it could never authenticate again anyway. The audit trail keeps its creation,
 * revocation and deletion. An active key must be revoked first ('conflict'). False when the key
 * doesn't exist (deleted already included), isn't the user's, or `keyId` isn't a uuid (404).
 * Audit: 'api_key.deleted' with the prefix and name.
 */
export async function deleteApiKey(
  db: Db,
  opts: { userId: string; keyId: string; now?: Date },
): Promise<boolean> {
  const scope = and(eq(apiKeys.kind, 'user'), eq(apiKeys.userId, opts.userId));
  return deleteKey(db, { keyId: opts.keyId, scope, now: opts.now }, (tx, deleted) =>
    audit(tx, {
      actorUserId: opts.userId,
      action: 'api_key.deleted',
      targetType: 'api_key',
      targetId: deleted.id,
      meta: { prefix: deleted.prefix, name: deleted.name, status: deleted.status },
    }),
  );
}

/** The columns an edit may change (D-111), user and service keys together. */
export type KeyChanges = Partial<
  Pick<KeyRow, 'name' | 'categories' | 'accountScope' | 'accountIds' | 'rateLimitPerMinute'>
>;

/**
 * What changed between two versions of a key, for the audit entry: `{ field: { from, to } }`. An
 * account list is recorded by its size, as on creation.
 */
export function keyChanges(before: KeyRow, after: KeyRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (before.name !== after.name) out.name = { from: before.name, to: after.name };
  if (!sameList(before.categories, after.categories)) {
    out.categories = { from: before.categories, to: after.categories };
  }
  if (before.accountScope !== after.accountScope) {
    out.accountScope = { from: before.accountScope, to: after.accountScope };
  }
  if (!sameList(before.accountIds ?? [], after.accountIds ?? [])) {
    out.accountCount = {
      from: before.accountIds?.length ?? null,
      to: after.accountIds?.length ?? null,
    };
  }
  if (before.rateLimitPerMinute !== after.rateLimitPerMinute) {
    out.rateLimitPerMinute = { from: before.rateLimitPerMinute, to: after.rateLimitPerMinute };
  }
  return out;
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Edits the key `keyId` if it is one of the keys `scope` selects (the keys the actor may edit), for
 * updateApiKey and updateServiceKey (D-111). In one transaction that locks the row first (so a
 * revocation can't slip in between the check and the write): an inactive key is ApiKeyError
 * 'conflict'; `change` computes the new values (and may refuse with an ApiKeyError); only values that
 * differ are written, and `auditUpdated` runs only when something did. Returns the row as it is now,
 * or null when the key isn't in scope or `keyId` isn't a uuid.
 */
export async function updateKey(
  db: Db,
  opts: { keyId: string; scope: SQL | undefined; now: Date },
  change: (tx: DbOrTx, row: KeyRow) => Promise<KeyChanges>,
  auditUpdated: (tx: DbOrTx, before: KeyRow, after: KeyRow) => Promise<void>,
): Promise<KeyRow | null> {
  if (!isUuid(opts.keyId)) return null;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lock_timeout', '3s', true)`);
    const [row] = await tx
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, opts.keyId), opts.scope))
      .for('update');
    if (!row) return null;
    const status = apiKeyStatus(row, opts.now);
    if (status !== 'active') {
      throw new ApiKeyError(
        'conflict',
        `This key is ${status}. Only an active key can be changed.`,
      );
    }
    const values = await change(tx, row);
    const changed = Object.fromEntries(
      Object.entries(values).filter(([field, value]) => {
        const current = row[field as keyof KeyChanges];
        return Array.isArray(value) && Array.isArray(current)
          ? !sameList(value, current)
          : value !== current;
      }),
    ) as KeyChanges;
    if (Object.keys(changed).length === 0) return row;
    const [after] = await tx.update(apiKeys).set(changed).where(eq(apiKeys.id, row.id)).returning();
    if (!after) throw new Error('updateKey: the locked row disappeared');
    await auditUpdated(tx, row, after);
    return after;
  });
}

/** What a deletion's audit entry is written from. */
export type DeletedKey = Pick<KeyRow, 'id' | 'userId' | 'prefix' | 'name'> & {
  status: Exclude<ApiKeyStatus, 'active'>;
};

/**
 * Deletes the key `keyId` if it is one of the keys `scope` selects and is revoked or expired, for
 * deleteApiKey and deleteServiceKey (D-111), and runs `auditDeleted` in the same transaction. True
 * when it was deleted; ApiKeyError 'conflict' when it is in scope but still active; false when it
 * isn't in scope (or no longer exists), or `keyId` isn't a uuid.
 */
export async function deleteKey(
  db: Db,
  opts: { keyId: string; scope: SQL | undefined; now?: Date | undefined },
  auditDeleted: (tx: DbOrTx, deleted: DeletedKey) => Promise<void>,
): Promise<boolean> {
  if (!isUuid(opts.keyId)) return false;
  const now = opts.now ?? new Date();
  const inScope = and(eq(apiKeys.id, opts.keyId), opts.scope);
  return db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(apiKeys)
      .where(and(inScope, not(activeKeyFilter(now) ?? sql`true`)))
      .returning();
    if (deleted) {
      const status = apiKeyStatus(deleted, now);
      await auditDeleted(tx, {
        id: deleted.id,
        userId: deleted.userId,
        prefix: deleted.prefix,
        name: deleted.name,
        status: status === 'active' ? 'revoked' : status,
      });
      return true;
    }
    const [existing] = await tx.select({ id: apiKeys.id }).from(apiKeys).where(inScope);
    if (!existing) return false;
    throw new ApiKeyError('conflict', 'This key is still active. Revoke it before deleting it.');
  });
}

/** What a revocation's audit entry is written from. */
export type RevokedKey = Pick<KeyRow, 'id' | 'userId' | 'prefix' | 'name'>;

/**
 * Revokes the key `keyId` if it is one of the keys `scope` selects (the keys the actor may revoke),
 * for revokeApiKey and revokeServiceKey: sets `revoked_at` once and runs `auditRevoked` in the same
 * transaction, only when this call revoked it. True when the key is in scope, revoked now or before
 * (idempotent); false when it isn't, or `keyId` isn't a uuid.
 */
export async function revokeKey(
  db: Db,
  opts: { keyId: string; scope: SQL | undefined; now?: Date | undefined },
  auditRevoked: (tx: DbOrTx, revoked: RevokedKey) => Promise<void>,
): Promise<boolean> {
  if (!isUuid(opts.keyId)) return false;
  const now = opts.now ?? new Date();
  const inScope = and(eq(apiKeys.id, opts.keyId), opts.scope);
  return db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(and(inScope, isNull(apiKeys.revokedAt)))
      .returning({
        id: apiKeys.id,
        userId: apiKeys.userId,
        prefix: apiKeys.prefix,
        name: apiKeys.name,
      });
    if (revoked) {
      await auditRevoked(tx, revoked);
      return true;
    }
    // Nothing updated: already revoked (idempotent success) or not a key in scope.
    const existing = await tx.select({ id: apiKeys.id }).from(apiKeys).where(inScope);
    return existing.length > 0;
  });
}
