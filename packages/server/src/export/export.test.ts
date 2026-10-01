/**
 * "Download my data" (D-79): the document is valid JSON with every section, holds only the user's
 * own accounts and the categories they can see, never a secret, and streams its histories in
 * keyset batches that are read only when the consumer gets to them.
 */
import type { Category } from '@hub/core';
import {
  accountNames,
  apiKeys,
  auditLog,
  deviceAccounts,
  devices,
  equipmentChanges,
  events,
  locationSamples,
  playSessions,
  session,
  skills,
  userSettings,
  users,
  wealthDaily,
  xpSamples,
} from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadVisibleAccounts, restrictAccess, type AccountWithAccess } from '../accounts/load';
import {
  deathData,
  refreshXpAggregates,
  seedAccount,
  seedEvent,
  seedGrant,
  seedLatestState,
  seedLink,
  seedSharing,
  seedUser,
  seedXp,
  skillId,
  skillMap,
  type SeededAccount,
  type SeededUser,
} from '../accounts/test-support';
import { seedAudit } from '../offboarding/test-support';
import { accountDocument, type AccountExportContext } from './accounts';
import { EXPORT_FORMAT, EXPORT_VERSION, exportUserData } from './document';

let t: TestDatabase;

const NOW = new Date('2026-09-29T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const RECENT = Date.parse('2026-09-20T00:00:00Z');
const OLD = Date.parse('2025-01-10T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

// The secrets the document must never contain.
const DEVICE_TOKEN_HASH = 'a'.repeat(64);
const KEY_SECRET_HASH = 'b'.repeat(64);
const SESSION_TOKEN = 'session-token-that-must-not-leak';

let me: SeededUser;
let contributor: SeededUser;
let blocked: SeededUser;
let grantee: SeededUser;
let other: SeededUser;
let mine: SeededAccount;
let shared: SeededAccount;
let deviceId: string;

type Doc = Record<string, unknown> & {
  accounts: (Record<string, unknown> & { id: string })[];
};

async function collect(gen: AsyncIterable<string>): Promise<{ chunks: string[]; text: string }> {
  const chunks: string[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return { chunks, text: chunks.join('') };
}

async function exportOf(userId: string, batchSize?: number) {
  const { chunks, text } = await collect(exportUserData(t.db, userId, { now: NOW, batchSize }));
  return { chunks, text, doc: JSON.parse(text) as Doc };
}

function accountIn(doc: Doc, publicId: string) {
  const found = doc.accounts.find((a) => a.id === publicId);
  if (!found) throw new Error(`account ${publicId} not in the export`);
  return found;
}

beforeAll(async () => {
  t = await createTestDatabase('export');
  me = await seedUser(t.db, { name: 'Me', image: 'https://cdn.example/me.png' });
  await t.db
    .update(users)
    .set({ nickname: 'Nick', discordId: '123456789012345678', roles: ['r1'] })
    .where(eq(users.id, me.id));
  contributor = await seedUser(t.db, { name: 'Co Player' });
  blocked = await seedUser(t.db, { name: 'Blocked Player' });
  grantee = await seedUser(t.db, { name: 'Grantee' });
  other = await seedUser(t.db, { name: 'Other Owner' });
  await t.db.insert(userSettings).values({
    userId: me.id,
    toastMinLootValue: 100_000,
    timezone: 'Europe/Amsterdam',
  });

  // An account the user owns, with everything; a co-player, a blocked one, a grant and old history.
  mine = await seedAccount(t.db, { name: 'Bravo', owner: me.id, contributors: [contributor.id] });
  await seedLink(t.db, mine.id, blocked.id, { blocked: true });
  await seedSharing(t.db, mine.id, 'inventory', 'selected');
  await seedGrant(t.db, mine.id, 'inventory', grantee.id);
  await t.db.insert(accountNames).values([
    { accountId: mine.id, name: 'Bravo', firstSeen: new Date(RECENT), lastSeen: NOW },
    { accountId: mine.id, name: 'Old Bravo', firstSeen: new Date(OLD), lastSeen: new Date(RECENT) },
  ]);
  await seedLatestState(t.db, mine.id, {
    lastSeen: new Date(NOW.getTime() - MIN),
    gameState: 'LOGGED_IN',
    world: 302,
    hpCurrent: 50,
    hpMax: 99,
    healthUpdatedAt: new Date(NOW.getTime() - MIN),
    skills: skillMap({ Attack: [5000, 40], Strength: [7000, 45] }),
    skillsUpdatedAt: new Date(NOW.getTime() - MIN),
    location: { x: 3200, y: 3200, plane: 0, isOnBoat: false },
    locationUpdatedAt: new Date(NOW.getTime() - MIN),
    inventory: [{ id: 995, name: 'Coins', quantity: 1000, gePrice: 1, haPrice: 1 }],
    inventoryUpdatedAt: new Date(NOW.getTime() - HOUR),
  });
  // Old raw XP (aggregated, then dropped as the retention policy would) and recent raw XP.
  await seedXp(t.db, mine.id, [
    ['Attack', iso(OLD + 10 * HOUR), 100],
    ['Attack', iso(OLD + DAY + 10 * HOUR), 200],
    ['Strength', iso(OLD + 10 * HOUR), 300],
  ]);
  const recent: [string, string, number][] = [];
  for (let i = 0; i < 5; i++) recent.push(['Attack', iso(RECENT + i * 5 * MIN), 1000 + i]);
  for (let i = 0; i < 4; i++) recent.push(['Strength', iso(RECENT + i * 5 * MIN), 2000 + i]);
  await seedXp(t.db, mine.id, recent);
  await refreshXpAggregates(t.db);
  await t.db
    .delete(xpSamples)
    .where(and(eq(xpSamples.accountId, mine.id), lt(xpSamples.bucket, new Date(RECENT))));
  for (let i = 0; i < 7; i++) {
    await seedEvent(t.db, mine.id, {
      type: 'loot',
      valueGp: 1000 * (i + 1),
      occurredAt: new Date(RECENT + i * HOUR),
    });
  }
  await seedEvent(t.db, mine.id, {
    type: 'death',
    data: deathData(),
    occurredAt: new Date(RECENT + 8 * HOUR),
  });
  await t.db.insert(playSessions).values([
    {
      accountId: mine.id,
      startedAt: new Date(RECENT),
      lastSeenAt: new Date(RECENT + HOUR),
      endedAt: new Date(RECENT + HOUR),
      endReason: 'logout',
      worlds: [302],
    },
    { accountId: mine.id, startedAt: new Date(NOW.getTime() - HOUR), lastSeenAt: NOW, worlds: [] },
  ]);
  await t.db.insert(equipmentChanges).values({
    accountId: mine.id,
    changedAt: new Date(RECENT),
    equipment: [
      { id: 4151, name: 'Abyssal whip', quantity: 1, gePrice: 1, equipmentSlot: 'WEAPON' },
    ],
  });
  await t.db.insert(wealthDaily).values([
    { accountId: mine.id, day: '2026-09-20', lastValue: 10, maxValue: 20 },
    { accountId: mine.id, day: '2026-09-21', lastValue: 30, maxValue: 40 },
  ]);
  await t.db.insert(locationSamples).values([
    { accountId: mine.id, ts: new Date(RECENT), x: 3200, y: 3201, plane: 0, world: 302 },
    { accountId: mine.id, ts: new Date(RECENT + MIN), x: 3201, y: 3202, plane: 0, world: 302 },
  ]);

  // An account the user plays on (another owner).
  shared = await seedAccount(t.db, { name: 'Alpha', owner: other.id, contributors: [me.id] });
  // Not in the export: hidden (owner in grace), blocked on, and only visible through the guild.
  const inGrace = await seedUser(t.db, { status: 'grace' });
  await seedAccount(t.db, {
    name: 'Hidden',
    owner: inGrace.id,
    contributors: [me.id],
    status: 'hidden',
  });
  const blockedOn = await seedAccount(t.db, { name: 'Blocked On', owner: other.id });
  await seedLink(t.db, blockedOn.id, me.id, { blocked: true });
  const guildOnly = await seedAccount(t.db, { name: 'Guild Only', owner: other.id });
  // Grants to the user: one they can use (selected), one on a category now private.
  await seedSharing(t.db, guildOnly.id, 'inventory', 'selected');
  await seedGrant(t.db, guildOnly.id, 'inventory', me.id);
  await seedSharing(t.db, guildOnly.id, 'equipment', 'private');
  await seedGrant(t.db, guildOnly.id, 'equipment', me.id);

  // Devices, keys, sessions: with secrets that must stay out.
  const [device] = await t.db
    .insert(devices)
    .values({
      userId: me.id,
      label: 'Desktop',
      tokenHash: DEVICE_TOKEN_HASH,
      pluginVersion: '1.5',
      lastIp: '203.0.113.9',
    })
    .returning({ id: devices.id });
  deviceId = device!.id;
  await t.db.insert(deviceAccounts).values({ deviceId, accountId: mine.id });
  await t.db.insert(apiKeys).values({
    userId: me.id,
    name: 'Home Assistant',
    prefix: 'AbCdEfGhIj',
    secretHash: KEY_SECRET_HASH,
    categories: ['stats'],
  });
  await t.db.insert(session).values({
    id: 'session-id-1',
    userId: me.id,
    token: SESSION_TOKEN,
    expiresAt: new Date('2026-10-06T00:00:00Z'),
    updatedAt: NOW,
    ipAddress: '198.51.100.4',
    userAgent: 'Firefox',
  });

  // Audit entries: by the user, about the user, and neither.
  await seedAudit(t.db, { actorUserId: me.id, action: 'device.paired', targetType: 'device' });
  await seedAudit(t.db, {
    actorUserId: other.id,
    action: 'user.restored',
    targetType: 'user',
    targetId: me.id,
  });
  await seedAudit(t.db, { actorUserId: other.id, action: 'device.revoked', targetType: 'device' });
});

afterAll(async () => {
  await t.drop();
});

describe('exportUserData', () => {
  it('is one JSON document with every section', async () => {
    const { doc } = await exportOf(me.id);
    expect(Object.keys(doc)).toEqual([
      'format',
      'version',
      'generated_at',
      'notes',
      'user',
      'settings',
      'devices',
      'api_keys',
      'sign_in_sessions',
      'sharing',
      'audit',
      'accounts',
    ]);
    expect(doc).toMatchObject({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      generated_at: NOW.toISOString(),
      user: {
        id: me.id,
        name: 'Me',
        nickname: 'Nick',
        image_url: 'https://cdn.example/me.png',
        discord_id: '123456789012345678',
        roles: ['r1'],
        status: 'active',
        is_admin: false,
      },
      settings: {
        toasts: { enabled: true, types: null, min_loot_value: 100_000, own_accounts_only: false },
        timezone: 'Europe/Amsterdam',
      },
    });
    expect((doc.notes as string[]).join(' ')).toMatch(/raw plugin messages/);
  });

  it('writes `hub` only when given', async () => {
    const { text } = await collect(
      exportUserData(t.db, me.id, { now: NOW, hub: { name: 'Test Hub', url: 'http://hub.test' } }),
    );
    expect(JSON.parse(text)).toMatchObject({ hub: { name: 'Test Hub', url: 'http://hub.test' } });
  });

  it('lists devices with their accounts and last address, API keys and sign-ins', async () => {
    const { doc } = await exportOf(me.id);
    expect(doc.devices).toEqual([
      expect.objectContaining({
        id: deviceId,
        label: 'Desktop',
        plugin_version: '1.5',
        status: 'active',
        last_ip: '203.0.113.9',
        revoked_at: null,
        accounts: [expect.objectContaining({ id: mine.publicId, name: 'Bravo' })],
      }),
    ]);
    expect(doc.api_keys).toEqual([
      expect.objectContaining({
        name: 'Home Assistant',
        prefix: 'AbCdEfGhIj',
        categories: ['stats'],
        account_scope: 'all_visible',
        status: 'active',
      }),
    ]);
    expect(doc.sign_in_sessions).toEqual([
      expect.objectContaining({ ip_address: '198.51.100.4', user_agent: 'Firefox' }),
    ]);
  });

  it('never contains a token, a token hash or a key secret', async () => {
    const { text } = await exportOf(me.id);
    for (const secret of [DEVICE_TOKEN_HASH, KEY_SECRET_HASH, SESSION_TOKEN, 'session-id-1']) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/token_hash|secret_hash|"token"/);
  });

  it('holds the accounts the user owns or plays on, not blocked, hidden or guild-only ones', async () => {
    const { doc } = await exportOf(me.id);
    expect(doc.accounts.map((a) => [a.name, a.relation])).toEqual([
      ['Alpha', 'contributor'],
      ['Bravo', 'owner'],
    ]);
    expect(accountIn(doc, mine.publicId)).toMatchObject({
      owner: { name: 'Me', you: true },
      // The blocked player isn't named.
      contributors: [{ name: 'Co Player', you: false }],
      previous_names: [expect.objectContaining({ name: 'Old Bravo' })],
      hidden: false,
    });
    expect(accountIn(doc, shared.publicId)).toMatchObject({
      owner: { name: 'Other Owner', you: false },
      contributors: [{ name: 'Me', you: true }],
    });
    expect(JSON.stringify(doc.accounts)).not.toContain('Blocked Player');
  });

  it('writes the sharing settings the user made and the grants they can use', async () => {
    const { doc } = await exportOf(me.id);
    const sharing = doc.sharing as {
      accounts_you_own: { account: { id: string }; categories: unknown[] }[];
      granted_to_you: unknown[];
    };
    expect(sharing.accounts_you_own).toEqual([
      expect.objectContaining({
        account: { id: mine.publicId, name: 'Bravo' },
        blocked_contributors: ['Blocked Player'],
      }),
    ]);
    expect(sharing.accounts_you_own[0]!.categories).toContainEqual({
      category: 'inventory',
      audience: 'selected',
      is_default: false,
      granted_to: ['Grantee'],
    });
    expect(sharing.accounts_you_own[0]!.categories).toContainEqual({
      category: 'stats',
      audience: 'guild',
      is_default: true,
      granted_to: [],
    });
    // The equipment grant is on a category its owner made private: it gives nothing, so it's out.
    expect(sharing.granted_to_you).toEqual([
      expect.objectContaining({
        account: { id: expect.any(String), name: 'Guild Only' },
        category: 'inventory',
      }),
    ]);
  });

  it('writes audit entries by and about the user, and audits the export itself', async () => {
    const before = await t.db.select().from(auditLog).where(eq(auditLog.action, 'user.exported'));
    const { doc } = await exportOf(me.id);
    const actions = (doc.audit as { action: string }[]).map((a) => a.action);
    expect(actions).toContain('device.paired');
    expect(actions).toContain('user.restored');
    expect(actions).not.toContain('device.revoked');
    expect(doc.audit).toContainEqual(
      expect.objectContaining({ action: 'user.restored', actor_name: 'Other Owner' }),
    );
    const after = await t.db.select().from(auditLog).where(eq(auditLog.action, 'user.exported'));
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({
      actorUserId: me.id,
      targetType: 'user',
      targetId: me.id,
      meta: { accounts: 2 },
    });
  });

  it("replaces other people's ids in audit entries, keeping the user's own and the actor's name", async () => {
    await seedAudit(t.db, {
      actorUserId: me.id,
      action: 'sharing.granted',
      targetType: 'account',
      targetId: mine.publicId,
      meta: { userId: grantee.id, deviceId, nested: [{ to: other.id }], category: 'stats', n: 3 },
    });
    await seedAudit(t.db, {
      actorUserId: me.id,
      action: 'user.offboarded',
      targetType: 'user',
      targetId: other.id,
      meta: { reason: 'admin' },
    });
    const { doc, text } = await exportOf(me.id);
    const audit = doc.audit as Record<string, unknown>[];
    expect(audit.find((a) => a.action === 'sharing.granted')).toMatchObject({
      actor_user_id: me.id,
      target_id: mine.publicId,
      meta: {
        userId: '[redacted]',
        deviceId,
        nested: [{ to: '[redacted]' }],
        category: 'stats',
        n: 3,
      },
    });
    expect(audit.find((a) => a.action === 'user.offboarded')).toMatchObject({
      target_type: 'user',
      target_id: '[redacted]',
    });
    // Someone else acting on the user: their name stays, their id doesn't.
    expect(audit.find((a) => a.action === 'user.restored')).toMatchObject({
      actor_user_id: null,
      actor_name: 'Other Owner',
      target_id: me.id,
    });
    for (const id of [other.id, grantee.id]) expect(text).not.toContain(id);
  });

  it("writes an owned account's state and every history", async () => {
    const { doc } = await exportOf(me.id);
    const acc = accountIn(doc, mine.publicId);
    expect(acc.categories).toEqual([
      'stats',
      'events',
      'activity',
      'location_live',
      'location_history',
      'equipment',
      'inventory',
    ]);
    expect(acc).toMatchObject({
      presence: { shared: true, online: true, world: 302, game_state: 'LOGGED_IN' },
      vitals: { shared: true, hp: { current: 50, max: 99 } },
      skills: { shared: true, total_level: 85, overall_xp: 12000 },
      location: { shared: true, x: 3200, y: 3200, plane: 0, is_on_boat: false },
      equipment: { shared: false, updated_at: null },
      inventory: { shared: true, value: 1000 },
    });
    // Raw XP within retention; the aggregate only for the days before it.
    expect(acc.xp_samples).toHaveLength(9);
    expect(acc.xp_samples).toContainEqual({
      skill: 'Attack',
      bucket: iso(RECENT),
      xp: 1000,
      level: 1,
    });
    expect(acc.xp_daily).toEqual([
      { skill: 'Attack', day: '2025-01-10', xp: 100, level: 1 },
      { skill: 'Attack', day: '2025-01-11', xp: 200, level: 1 },
      { skill: 'Strength', day: '2025-01-10', xp: 300, level: 1 },
    ]);
    const events = acc.events as { type: string; value_gp: number | null; data: unknown }[];
    expect(events.map((e) => e.type)).toEqual([...Array(7).fill('loot'), 'death']);
    // The owner sees the death's location.
    expect(JSON.stringify(events.at(-1)!.data)).toContain('"location"');
    expect(acc.sessions).toHaveLength(2);
    expect(acc.equipment_changes).toEqual([
      {
        changed_at: iso(RECENT),
        items: [
          expect.objectContaining({ id: 4151, name: 'Abyssal whip', equipment_slot: 'WEAPON' }),
        ],
      },
    ]);
    expect(acc.wealth_days).toEqual([
      { day: '2026-09-20', last_value: 10, max_value: 20 },
      { day: '2026-09-21', last_value: 30, max_value: 40 },
    ]);
    expect(acc.location_trail).toEqual([
      { at: iso(RECENT), x: 3200, y: 3201, plane: 0, world: 302, is_on_boat: false },
      { at: iso(RECENT + MIN), x: 3201, y: 3202, plane: 0, world: 302, is_on_boat: false },
    ]);
  });

  it('batches every history across batch boundaries, without gaps or repeats', async () => {
    const whole = (await exportOf(me.id)).doc;
    const { doc, chunks } = await exportOf(me.id, 2);
    expect(accountIn(doc, mine.publicId)).toEqual(accountIn(whole, mine.publicId));
    // The same entries, plus the second export's own `user.exported`.
    const audit = doc.audit as unknown[];
    expect(audit.slice(0, -1)).toEqual(whole.audit);
    expect(audit.at(-1)).toMatchObject({ action: 'user.exported' });
    // 9 raw XP rows in batches of 2: five pieces, each with at most two rows.
    const xpPieces = chunks.filter((c) => c.includes('"bucket"'));
    expect(xpPieces).toHaveLength(5);
    for (const piece of xpPieces) expect(piece.match(/"bucket"/g)!.length).toBeLessThanOrEqual(2);
  });

  it('pages equipment changes by time, then id, each change once', async () => {
    const worn = (id: number) => [
      { id, name: `Item ${id}`, quantity: 1, gePrice: 1, equipmentSlot: 'WEAPON' },
    ];
    // Two changes of one instant, and an earlier one stored after them (a higher id).
    const added = await t.db
      .insert(equipmentChanges)
      .values([
        { accountId: mine.id, changedAt: new Date(RECENT + 2 * MIN), equipment: worn(1) },
        { accountId: mine.id, changedAt: new Date(RECENT + 2 * MIN), equipment: worn(2) },
        { accountId: mine.id, changedAt: new Date(RECENT + MIN), equipment: worn(3) },
      ])
      .returning({ id: equipmentChanges.id });
    try {
      for (const batchSize of [1, 2, undefined]) {
        const { doc } = await exportOf(me.id, batchSize);
        const changes = accountIn(doc, mine.publicId).equipment_changes as {
          changed_at: string;
          items: { id: number }[];
        }[];
        expect(changes.map((c) => [c.changed_at, c.items[0]!.id])).toEqual([
          [iso(RECENT), 4151],
          [iso(RECENT + MIN), 3],
          [iso(RECENT + 2 * MIN), 1],
          [iso(RECENT + 2 * MIN), 2],
        ]);
      }
    } finally {
      await t.db.delete(equipmentChanges).where(
        inArray(
          equipmentChanges.id,
          added.map((r) => r.id),
        ),
      );
    }
  });

  it('reads a history batch by batch while the consumer reads', async () => {
    const gen = exportUserData(t.db, me.id, { now: NOW, batchSize: 3 });
    const chunks: string[] = [];
    let added = false;
    for await (const chunk of gen) {
      chunks.push(chunk);
      if (!added && chunk.includes('"bucket"')) {
        // Only the first batch has been read: a sample added now, after the others in key order,
        // is still read by a later batch.
        added = true;
        await t.db.insert(xpSamples).values({
          accountId: mine.id,
          skillId: await skillId(t.db, 'Strength'),
          bucket: new Date(RECENT + 50 * MIN),
          xp: 9999,
          level: 50,
        });
      }
    }
    const acc = accountIn(JSON.parse(chunks.join('')) as Doc, mine.publicId);
    expect(acc.xp_samples).toContainEqual({
      skill: 'Strength',
      bucket: iso(RECENT + 50 * MIN),
      xp: 9999,
      level: 50,
    });
    await t.db
      .delete(xpSamples)
      .where(and(eq(xpSamples.accountId, mine.id), eq(xpSamples.xp, 9999)));
  });

  it('stops reading when the consumer stops', async () => {
    const gen = exportUserData(t.db, me.id, { now: NOW, batchSize: 1 });
    const first = await gen.next();
    expect(first.done).toBe(false);
    await gen.return(undefined);
    expect(await gen.next()).toEqual({ done: true, value: undefined });
  });

  it('refuses an unknown user and a bad batch size', async () => {
    await expect(collect(exportUserData(t.db, 'nobody', { now: NOW }))).rejects.toThrow(
      /unknown user/,
    );
    await expect(collect(exportUserData(t.db, me.id, { batchSize: 0 }))).rejects.toThrow(
      RangeError,
    );
  });
});

describe('accountDocument', () => {
  async function ctx(): Promise<AccountExportContext> {
    const rows = await t.db.select({ id: skills.id, name: skills.name }).from(skills);
    return {
      db: t.db,
      userId: me.id,
      now: NOW,
      batchSize: 5000,
      skillNames: new Map(rows.map((r) => [r.id, r.name])),
    };
  }

  async function owned(categories: Category[]): Promise<AccountWithAccess> {
    const entries = await loadVisibleAccounts(t.db, me.viewer);
    const entry = entries.find((e) => e.account.id === mine.id)!;
    return {
      ...entry,
      access: restrictAccess(entry.access, {
        categories: new Set(categories),
        accountIds: null,
      }),
    };
  }

  it('leaves out every section and history of a category the user can not see', async () => {
    const { text } = await collect(accountDocument(await ctx(), await owned(['stats'])));
    const acc = JSON.parse(text) as Record<string, unknown>;
    expect(acc.categories).toEqual(['stats']);
    expect(acc.skills).toMatchObject({ shared: true });
    expect(acc.xp_samples).toBeDefined();
    expect(acc.xp_daily).toBeDefined();
    for (const key of [
      'presence',
      'vitals',
      'location',
      'equipment',
      'inventory',
      'events',
      'sessions',
      'equipment_changes',
      'wealth_days',
      'location_trail',
    ]) {
      expect(acc, key).not.toHaveProperty(key);
    }
    // A last-seen time is presence (D-50).
    expect(acc.last_seen).toBeNull();
  });

  it('redacts event locations exactly as the feed does without a location category', async () => {
    const { text } = await collect(accountDocument(await ctx(), await owned(['events'])));
    const acc = JSON.parse(text) as { events: { type: string; data: unknown }[] };
    const death = acc.events.find((e) => e.type === 'death')!;
    expect(JSON.stringify(death.data)).not.toContain('location');
    expect(death.data).toMatchObject({ type: 'death', data: { valueLost: 34906 } });
  });

  it('writes a stored event whose data is not an object as an empty object, like /events', async () => {
    const stored = [
      await seedEvent(t.db, mine.id, { type: 'loot', data: 'not an object' }),
      await seedEvent(t.db, mine.id, { type: 'loot', data: [1, 2] }),
    ];
    try {
      const { text } = await collect(accountDocument(await ctx(), await owned(['events'])));
      const acc = JSON.parse(text) as { events: { id: string; data: unknown }[] };
      for (const { id } of stored) {
        expect(acc.events.find((e) => e.id === id)?.data).toEqual({});
      }
    } finally {
      await t.db.delete(events).where(
        inArray(
          events.id,
          stored.map((e) => e.id),
        ),
      );
    }
  });
});
