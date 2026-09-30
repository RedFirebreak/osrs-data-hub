/**
 * API keys for the public, pull-only REST API (handoff §13, D-69, D-70, D-76): create, list, revoke,
 * and authenticate a request's bearer key into an ApiPrincipal. Service keys (D-87) share the table,
 * the format and the authentication; their management is in service-keys.ts.
 *
 * A key is `ohub_<prefix>_<secret>`: a 10-character base62 prefix, unique and stored in clear so a
 * lookup is an index hit and the owner can recognise the key, and a 43-character base62 secret
 * (≈ 256 bits) of which only sha256 is stored. The key is shown once, at creation.
 */
import { randomBytes } from 'node:crypto';
import {
  CATEGORIES,
  GUILD_AUDIENCE,
  constantTimeEqual,
  isCategory,
  sha256Hex,
  type Category,
  type Principal,
} from '@hub/core';
import {
  apiKeys,
  osrsAccounts,
  pgErrorCode,
  users,
  type ApiKeyKind,
  type Db,
  type DbOrTx,
} from '@hub/db';
import { and, count, desc, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { loadViewer } from '../accounts/access';
import { loadVisibleAccounts } from '../accounts/load';
import { audit } from '../audit';
import { isUuid } from '../devices/util';
import { getLogger } from '../logger';
import { API_RATE_LIMIT, SERVICE_KEY_RATE_LIMIT } from './limits';

/** Every key starts with this; the part after it is `<prefix>_<secret>`. */
export const API_KEY_PREFIX = 'ohub_';
/** Most active (neither revoked nor expired) keys one user may hold at once (D-69). */
export const MAX_ACTIVE_KEYS = 10;
/** Longest key name, in characters (code points), after trimming. */
export const API_KEY_NAME_MAX = 64;
/** Longest expiry a key can be created with. */
export const API_KEY_MAX_EXPIRY_DAYS = 365;
/** Most accounts a key with an explicit account list may name. */
export const MAX_KEY_ACCOUNTS = 500;
/** How often `last_used_at` is written per key at most. */
export const LAST_USED_RESOLUTION_MS = 60_000;

const PREFIX_LENGTH = 10;
const SECRET_LENGTH = 43;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const KEY_RE = /^ohub_([0-9A-Za-z]{10})_([0-9A-Za-z]{43})$/;
const BEARER_RE = /^bearer +(\S+)$/i;
/** Longer Authorization headers are refused before any parsing. */
const MAX_AUTHORIZATION_LENGTH = 512;
/** Compared against when no key has the prefix, so both failures do the same work (see below). */
const NO_KEY_HASH = '0'.repeat(64);
const DAY_MS = 24 * 60 * 60 * 1000;

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
  /** `user` (a member's own key) or `service` (an admin-created integration key, D-87). */
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
  /** Requests per sliding minute: the key's own limit, or the default of its kind (D-72, D-87). */
  rateLimitPerMinute: number;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** revoked wins over expired. */
  status: ApiKeyStatus;
}

/** Why createApiKey refused: invalid → 400 (with `issues`), limit → 409, not_found → 404. */
export type ApiKeyErrorCode = 'invalid' | 'limit' | 'not_found';

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
    accountPublicIds: z
      .array(z.string().regex(/^[0-9A-Za-z]{1,64}$/, 'not an account id'))
      .min(1, 'choose at least one account')
      .max(MAX_KEY_ACCOUNTS)
      .transform((ids) => [...new Set(ids)])
      .optional(),
    expiresInDays: KEY_FIELD_SCHEMAS.expiresInDays,
  })
  .superRefine((body, ctx) => {
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
  });

/** The request body the API keys page sends. */
export type CreateApiKeyInput = z.input<typeof CreateApiKeySchema>;
/** The body after validation. */
export type CreateApiKey = z.output<typeof CreateApiKeySchema>;

export type KeyRow = typeof apiKeys.$inferSelect;

/** The key's requests per minute: its own, else the default of its kind (D-72, D-87). */
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

/** The secret part of a new key. */
export function newKeySecret(): string {
  return randomBase62(SECRET_LENGTH);
}

/** `ohub_<prefix>_<secret>`. */
export function formatKey(prefix: string, secret: string): string {
  return `${API_KEY_PREFIX}${prefix}_${secret}`;
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
      .values({ ...values, prefix: randomBase62(PREFIX_LENGTH) })
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
 * Revokes a user key: the user's own, or any user's when `asAdmin` (the caller checks that the actor
 * is an admin; service keys are revoked through revokeServiceKey, D-87). The next request with it
 * gets 401. Idempotent: revoking a revoked key keeps its time, writes no second audit entry and
 * still returns true. False when the key doesn't exist, isn't the user's (and not `asAdmin`), or
 * `keyId` isn't a uuid, so the route answers 404 without revealing other users' keys. A key revoked
 * by offboarding stays revoked when the user is restored.
 * Audit: 'api_key.revoked' with the owner and the prefix.
 */
export async function revokeApiKey(
  db: Db,
  opts: { userId: string; keyId: string; asAdmin?: boolean; now?: Date },
): Promise<boolean> {
  if (!isUuid(opts.keyId)) return false;
  const now = opts.now ?? new Date();
  const scope = and(
    eq(apiKeys.kind, 'user'),
    opts.asAdmin === true ? undefined : eq(apiKeys.userId, opts.userId),
  );
  return db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(and(eq(apiKeys.id, opts.keyId), isNull(apiKeys.revokedAt), scope))
      .returning({ id: apiKeys.id, userId: apiKeys.userId, prefix: apiKeys.prefix });
    if (revoked) {
      await audit(tx, {
        actorUserId: opts.userId,
        action: 'api_key.revoked',
        targetType: 'api_key',
        targetId: revoked.id,
        meta: {
          ownerUserId: revoked.userId,
          prefix: revoked.prefix,
          asAdmin: opts.asAdmin === true,
        },
      });
      return true;
    }
    // Nothing updated: already revoked (idempotent success) or not the actor's key.
    const existing = await tx
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, opts.keyId), scope));
    return existing.length > 0;
  });
}

/**
 * Who a request acts as: the key and whom the resolver evaluates for it. For a user key, `viewer` is
 * the creator as the resolver sees them, with isAdmin always false (no admin override through the
 * API, D-70) and `userId` the creator; for a service key (D-87), `viewer` is the guild audience
 * (GUILD_AUDIENCE, D-88) and `userId` is null. `categories` are the key's; `accountIds` its explicit
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
  /** Requests per sliding minute this key may make (D-72, D-87). */
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
  const parts = token === undefined ? null : KEY_RE.exec(token);
  const prefix = parts?.[1];
  const secret = parts?.[2];
  if (prefix === undefined || secret === undefined) return { ok: false, reason: 'malformed' };

  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.prefix, prefix));
  const matches = constantTimeEqual(sha256Hex(secret), row?.secretHash ?? NO_KEY_HASH);
  if (!row || !matches) return { ok: false, reason: 'unknown' };
  if (row.revokedAt !== null) return { ok: false, reason: 'revoked' };
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  const categories = new Set(row.categories.filter(isCategory));
  const rateLimitPerMinute = keyRateLimit(row);
  if (row.kind === 'service') {
    // Belongs to no user (D-87): nothing to load, and no offboarding can have touched it.
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
