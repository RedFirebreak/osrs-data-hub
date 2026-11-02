import { randomBytes, randomUUID } from 'node:crypto';
import { AI_ASSISTANT_CATEGORIES } from '@hub/core';
import {
  apiKeys,
  auditLog,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
} from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedAccount, seedUser, type SeededUser } from '../accounts/test-support';
import { offboardUser } from '../offboarding/offboard';
import { authenticateApiKey } from './key-auth';
import { ApiKeyError, MAX_ACTIVE_KEYS, createApiKey, listApiKeys, revokeApiKey } from './keys';
import { OAUTH_ACCESS_TOKEN_PREFIX, forgetOAuthGrant, oauthTokenHash } from './oauth-grants';
import {
  OAUTH_KEY_FALLBACK_NAME,
  createOAuthKey,
  oauthClientInfo,
  oauthKeyName,
} from './oauth-keys';

let t: TestDatabase;
let alice: SeededUser;

const NOW = new Date('2026-11-02T12:00:00Z');
const HOUR = 3_600_000;
const RESOURCE = 'https://hub.example/api/v1/mcp';
const OAUTH = { oauthResource: RESOURCE };

beforeAll(async () => {
  t = await createTestDatabase('oauth-keys');
  alice = await seedUser(t.db, { name: 'Alice' });
  await seedAccount(t.db, { name: 'Alice Main', owner: alice.id });
});

afterAll(async () => {
  await t.drop();
});

/** A dynamically registered client, as the provider would store it. */
async function seedClient(name: string | null = 'Claude', disabled = false): Promise<string> {
  const clientId = randomBytes(16).toString('hex');
  await t.db.insert(oauthClient).values({
    id: randomUUID(),
    clientId,
    name,
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    disabled,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return clientId;
}

/**
 * An access token the provider handed out for `clientId` to `userId`, stored as the provider stores
 * it (the hash of the token without its prefix); returns the token as the client sends it.
 */
async function seedToken(
  clientId: string,
  userId: string | null,
  opts: { expiresAt?: Date; revoked?: Date; resources?: string[] | null } = {},
): Promise<string> {
  const raw = randomBytes(24).toString('base64url');
  await t.db.insert(oauthAccessToken).values({
    id: randomUUID(),
    token: oauthTokenHash(raw),
    clientId,
    userId,
    scopes: ['mcp', 'offline_access'],
    resources: opts.resources === undefined ? [RESOURCE] : opts.resources,
    createdAt: NOW,
    expiresAt: opts.expiresAt ?? new Date(NOW.getTime() + HOUR),
    revoked: opts.revoked ?? null,
  });
  return `${OAUTH_ACCESS_TOKEN_PREFIX}${raw}`;
}

async function seedGrant(clientId: string, userId: string): Promise<void> {
  await t.db.insert(oauthConsent).values({
    id: randomUUID(),
    clientId,
    userId,
    scopes: ['mcp'],
    createdAt: NOW,
    updatedAt: NOW,
  });
  await t.db.insert(oauthRefreshToken).values({
    id: randomUUID(),
    token: oauthTokenHash(randomBytes(24).toString('base64url')),
    clientId,
    userId,
    scopes: ['mcp', 'offline_access'],
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 30 * 24 * HOUR),
  });
}

async function grantRows(clientId: string, userId: string): Promise<number> {
  const consents = await t.db
    .select()
    .from(oauthConsent)
    .where(and(eq(oauthConsent.clientId, clientId), eq(oauthConsent.userId, userId)));
  const access = await t.db
    .select()
    .from(oauthAccessToken)
    .where(and(eq(oauthAccessToken.clientId, clientId), eq(oauthAccessToken.userId, userId)));
  const refresh = await t.db
    .select()
    .from(oauthRefreshToken)
    .where(and(eq(oauthRefreshToken.clientId, clientId), eq(oauthRefreshToken.userId, userId)));
  return consents.length + access.length + refresh.length;
}

describe('oauthKeyName', () => {
  it('uses the client name, cleaned and cut to the key name limit', () => {
    expect(oauthKeyName('Claude')).toBe('Claude');
    expect(oauthKeyName('  Claude\n\tDesktop ')).toBe('Claude  Desktop');
    expect(Array.from(oauthKeyName('x'.repeat(100)))).toHaveLength(64);
  });

  it('falls back when the client gave no name', () => {
    expect(oauthKeyName(null)).toBe(OAUTH_KEY_FALLBACK_NAME);
    expect(oauthKeyName(' ')).toBe(OAUTH_KEY_FALLBACK_NAME);
  });
});

describe('oauthClientInfo', () => {
  it('finds a client, and not a disabled one', async () => {
    const id = await seedClient('Claude');
    expect(await oauthClientInfo(t.db, id)).toEqual({ clientId: id, name: 'Claude', uri: null });
    expect(await oauthClientInfo(t.db, await seedClient('Off', true))).toBeNull();
    expect(await oauthClientInfo(t.db, 'nope')).toBeNull();
  });
});

describe('createOAuthKey', () => {
  it('makes a user key with the AI assistant categories on every visible account', async () => {
    const clientId = await seedClient('Claude');
    const info = await createOAuthKey(t.db, {
      userId: alice.id,
      clientId,
      clientName: 'Claude',
      now: NOW,
    });
    expect(info).toMatchObject({
      kind: 'user',
      name: 'Claude',
      categories: [...AI_ASSISTANT_CATEGORIES],
      accountScope: 'all_visible',
      expiresAt: null,
      status: 'active',
      connected: true,
    });
    const [row] = await t.db.select().from(apiKeys).where(eq(apiKeys.id, info.id));
    expect(row?.oauthClientId).toBe(clientId);
    const listed = await listApiKeys(t.db, alice.id, NOW);
    expect(listed.find((k) => k.id === info.id)?.connected).toBe(true);
    const created = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'api_key.created'), eq(auditLog.targetId, info.id)));
    expect(created[0]?.meta).toMatchObject({ oauthClientId: clientId });
  });

  it('replaces the key the same client already had', async () => {
    const clientId = await seedClient('Claude');
    const first = await createOAuthKey(t.db, {
      userId: alice.id,
      clientId,
      clientName: 'Claude',
      now: NOW,
    });
    const second = await createOAuthKey(t.db, {
      userId: alice.id,
      clientId,
      clientName: 'Claude',
      now: NOW,
    });
    const rows = await t.db.select().from(apiKeys).where(eq(apiKeys.oauthClientId, clientId));
    expect(rows.find((r) => r.id === first.id)?.revokedAt).toEqual(NOW);
    expect(rows.find((r) => r.id === second.id)?.revokedAt).toBeNull();
  });

  it('counts towards the active key limit', async () => {
    const bob = await seedUser(t.db, { name: 'Bob' });
    for (let i = 0; i < MAX_ACTIVE_KEYS; i++) {
      await createApiKey(
        t.db,
        bob.id,
        { name: `k${i}`, categories: ['stats'], accountScope: 'all_visible' },
        NOW,
      );
    }
    const clientId = await seedClient('Claude');
    const err = await createOAuthKey(t.db, {
      userId: bob.id,
      clientId,
      clientName: 'Claude',
      now: NOW,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiKeyError);
    expect((err as ApiKeyError).code).toBe('limit');
  });
});

describe('authenticateApiKey with an OAuth access token', () => {
  async function connected() {
    const clientId = await seedClient('Claude');
    const key = await createOAuthKey(t.db, {
      userId: alice.id,
      clientId,
      clientName: 'Claude',
      now: NOW,
    });
    return { clientId, key };
  }

  it('acts as the key the connection made', async () => {
    const { clientId, key } = await connected();
    const token = await seedToken(clientId, alice.id);
    const result = await authenticateApiKey(t.db, `Bearer ${token}`, NOW, OAUTH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toMatchObject({ kind: 'user', keyId: key.id, userId: alice.id });
    expect([...result.principal.categories]).toEqual([...AI_ASSISTANT_CATEGORIES]);
  });

  it('takes a token issued for no resource in particular', async () => {
    const { clientId } = await connected();
    const token = await seedToken(clientId, alice.id, { resources: null });
    expect((await authenticateApiKey(t.db, `Bearer ${token}`, NOW, OAUTH)).ok).toBe(true);
  });

  it('is malformed where OAuth tokens are not taken', async () => {
    const { clientId } = await connected();
    const token = await seedToken(clientId, alice.id);
    expect(await authenticateApiKey(t.db, `Bearer ${token}`, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('refuses a token for another resource, an unknown, expired or revoked one, or one without a user', async () => {
    const { clientId } = await connected();
    const cases: [string, string][] = [
      [
        await seedToken(clientId, alice.id, { resources: ['https://other.example/mcp'] }),
        'unknown',
      ],
      [`${OAUTH_ACCESS_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`, 'unknown'],
      [await seedToken(clientId, alice.id, { expiresAt: NOW }), 'expired'],
      [await seedToken(clientId, alice.id, { revoked: NOW }), 'revoked'],
      [await seedToken(clientId, null), 'unknown'],
    ];
    for (const [token, reason] of cases) {
      expect(await authenticateApiKey(t.db, `Bearer ${token}`, NOW, OAUTH)).toEqual({
        ok: false,
        reason,
      });
    }
  });

  it('is revoked once the key is, and forgets the grant so the client must ask again', async () => {
    const { clientId, key } = await connected();
    const token = await seedToken(clientId, alice.id);
    await seedGrant(clientId, alice.id);
    // Revoked by hand in the table: a path that didn't forget the grant itself.
    await t.db.update(apiKeys).set({ revokedAt: NOW }).where(eq(apiKeys.id, key.id));
    expect(await authenticateApiKey(t.db, `Bearer ${token}`, NOW, OAUTH)).toEqual({
      ok: false,
      reason: 'revoked',
    });
    expect(await grantRows(clientId, alice.id)).toBe(0);
  });
});

describe('forgetting a grant', () => {
  it('revokeApiKey on a connection key forgets the consent and the tokens', async () => {
    const clientId = await seedClient('Claude');
    const key = await createOAuthKey(t.db, {
      userId: alice.id,
      clientId,
      clientName: 'Claude',
      now: NOW,
    });
    await seedToken(clientId, alice.id);
    await seedGrant(clientId, alice.id);
    expect(await grantRows(clientId, alice.id)).toBe(3);
    expect(await revokeApiKey(t.db, { userId: alice.id, keyId: key.id, now: NOW })).toBe(true);
    expect(await grantRows(clientId, alice.id)).toBe(0);
  });

  it('touches only that user and client', async () => {
    const carol = await seedUser(t.db, { name: 'Carol' });
    const one = await seedClient('One');
    const two = await seedClient('Two');
    await seedGrant(one, carol.id);
    await seedGrant(two, carol.id);
    await seedGrant(one, alice.id);
    await forgetOAuthGrant(t.db, carol.id, one);
    expect(await grantRows(one, carol.id)).toBe(0);
    expect(await grantRows(two, carol.id)).toBe(2);
    expect(await grantRows(one, alice.id)).toBe(2);
  });

  it('offboarding forgets every grant of the user', async () => {
    const dave = await seedUser(t.db, { name: 'Dave' });
    const clientId = await seedClient('Claude');
    await createOAuthKey(t.db, { userId: dave.id, clientId, clientName: 'Claude', now: NOW });
    await seedToken(clientId, dave.id);
    await seedGrant(clientId, dave.id);
    await offboardUser(t.db, { userId: dave.id, reason: 'left_guild', graceDays: 30, now: NOW });
    expect(await grantRows(clientId, dave.id)).toBe(0);
  });
});
