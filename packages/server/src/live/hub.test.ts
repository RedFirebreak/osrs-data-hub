import { createDb, schema, users, type Db } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FeedEvent } from '../feed';
import { createTestMetrics, type HubMetrics } from '../metrics';
import { LiveHub, type LiveSubscriber } from './hub';
import type { DeviceMessage, LiveEventMessage, PresenceMessage } from './messages';
import {
  captureLogger,
  deathData,
  fakeSubscriber,
  grant,
  link,
  seedAccount,
  seedDevice,
  seedEvent,
  seedLatestState,
  seedUser,
  share,
  type SeededAccount,
} from './test-support';

const NOW = new Date('2026-09-28T12:00:00Z');
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let t: TestDatabase;
let metrics: HubMetrics;
let hub: LiveHub;

// Users
let owner: Awaited<ReturnType<typeof seedUser>>;
let contributor: Awaited<ReturnType<typeof seedUser>>;
let member: Awaited<ReturnType<typeof seedUser>>;
let granted: Awaited<ReturnType<typeof seedUser>>;
let blocked: Awaited<ReturnType<typeof seedUser>>;
let grace: Awaited<ReturnType<typeof seedUser>>;
let admin: Awaited<ReturnType<typeof seedUser>>;
// Accounts
let zezima: SeededAccount; // defaults; location_live selected for `granted`
let privy: SeededAccount; // events + activity private
let selective: SeededAccount; // events selected for `granted`
let hidden: SeededAccount; // owner in grace without transfer

beforeAll(async () => {
  t = await createTestDatabase('live-hub');
  owner = await seedUser(t.db, { name: 'Owner Olga' });
  contributor = await seedUser(t.db, { name: 'Contributor Carl' });
  member = await seedUser(t.db, { name: 'Member Mia' });
  granted = await seedUser(t.db, { name: 'Granted Gus' });
  blocked = await seedUser(t.db, { name: 'Blocked Bob' });
  grace = await seedUser(t.db, { name: 'Grace Gina', status: 'grace' });
  admin = await seedUser(t.db, { name: 'Admin Ada', isAdmin: true });

  zezima = await seedAccount(t.db, { name: 'Zezima', ownerUserId: owner.userId, accountType: 1 });
  await link(t.db, zezima.id, contributor.userId);
  await link(t.db, zezima.id, grace.userId);
  await share(t.db, zezima.id, 'location_live', 'selected');
  await grant(t.db, zezima.id, 'location_live', granted.userId);

  privy = await seedAccount(t.db, { name: 'Private Pete', ownerUserId: owner.userId });
  await link(t.db, privy.id, contributor.userId);
  await link(t.db, privy.id, blocked.userId, 'contributor', true);
  await share(t.db, privy.id, 'events', 'private');
  await share(t.db, privy.id, 'activity', 'private');

  selective = await seedAccount(t.db, { name: 'Selective Sam', ownerUserId: owner.userId });
  await share(t.db, selective.id, 'events', 'selected');
  await grant(t.db, selective.id, 'events', granted.userId);

  hidden = await seedAccount(t.db, {
    name: 'Hidden Hal',
    ownerUserId: owner.userId,
    status: 'hidden',
  });
});

afterAll(async () => {
  await t.drop();
});

function newHub(logger = captureLogger().logger): LiveHub {
  metrics = createTestMetrics();
  hub = new LiveHub({ db: t.db, logger, metrics, now: () => NOW });
  return hub;
}

function eventsOf(sub: ReturnType<typeof fakeSubscriber>): LiveEventMessage[] {
  return sub.messages('event').map((m) => m.data as LiveEventMessage);
}

function locationOf(event: FeedEvent): unknown {
  return ((event.data as { data?: Record<string, unknown> }).data ?? {}).location;
}

async function gauge(m: HubMetrics): Promise<number> {
  return (await m.sseConnections.get()).values[0]?.value ?? Number.NaN;
}

describe('LiveHub.onEvents', () => {
  it('delivers to the owner, contributors, guild members and admins, in ascending seq', async () => {
    newHub();
    const loot = await seedEvent(t.db, zezima.id, {
      occurredAt: ago(2 * MIN),
      valueGp: 1_000_000,
    });
    const death = await seedEvent(t.db, zezima.id, {
      type: 'death',
      occurredAt: ago(MIN),
      data: deathData(),
    });
    const subs = [owner, contributor, member, admin, grace].map((v) => fakeSubscriber(v));
    subs.forEach((s) => hub.subscribe(s));

    await hub.onEvents({ accountId: zezima.id, seqs: [death.seq, loot.seq] });

    const [o, c, m, a, g] = subs;
    for (const sub of [o, c, m, a]) {
      const msgs = sub!.messages('event');
      expect(msgs.map((x) => x.id)).toEqual([String(loot.seq), String(death.seq)]);
      const [first] = eventsOf(sub!);
      expect(first?.event).toMatchObject({
        id: loot.id,
        seq: loot.seq,
        type: 'loot',
        account: { publicId: zezima.publicId, name: 'Zezima' },
        occurredAt: ago(2 * MIN).toISOString(),
        valueGp: 1_000_000,
      });
      expect(first?.toast).toBe(true);
    }
    // A viewer in grace sees nothing (also not as a linked contributor).
    expect(g!.chunks).toEqual([]);
    // All messages of one notification go out in one write.
    expect(o!.chunks).toHaveLength(1);
  });

  it('redacts the death location for viewers without a location category', async () => {
    newHub();
    const death = await seedEvent(t.db, zezima.id, {
      type: 'death',
      occurredAt: ago(MIN),
      data: deathData(),
    });
    const [o, m, gr] = [owner, member, granted].map((v) => fakeSubscriber(v));
    [o, m, gr].forEach((s) => hub.subscribe(s!));

    await hub.onEvents({ accountId: zezima.id, seqs: [death.seq] });

    const [ownerEvent] = eventsOf(o!);
    const [memberEvent] = eventsOf(m!);
    const [grantedEvent] = eventsOf(gr!);
    expect(locationOf(ownerEvent!.event)).toEqual({ x: 3068, y: 3858, plane: 0 });
    expect(locationOf(grantedEvent!.event)).toEqual({ x: 3068, y: 3858, plane: 0 });
    expect(memberEvent!.event.data).toMatchObject({
      type: 'death',
      data: { killerName: 'Lynx Titan' },
    });
    expect(locationOf(memberEvent!.event)).toBeUndefined();
    expect(m!.chunks.join('')).not.toContain('3858');
    expect(memberEvent!.event.line).toContain('Zezima');
  });

  it('private events reach only the owner and non-blocked contributors', async () => {
    newHub();
    const e = await seedEvent(t.db, privy.id, { occurredAt: ago(MIN), valueGp: 5 });
    const subs = [owner, contributor, member, blocked, admin].map((v) => fakeSubscriber(v));
    subs.forEach((s) => hub.subscribe(s));

    await hub.onEvents({ accountId: privy.id, seqs: [e.seq] });

    expect(subs.map((s) => s.messages('event').length)).toEqual([1, 1, 0, 0, 0]);
  });

  it("'selected' events reach only granted users; hidden accounts only admins", async () => {
    newHub();
    const s1 = await seedEvent(t.db, selective.id, { occurredAt: ago(MIN) });
    const h1 = await seedEvent(t.db, hidden.id, { occurredAt: ago(MIN) });
    const [o, m, gr, a] = [owner, member, granted, admin].map((v) => fakeSubscriber(v));
    [o, m, gr, a].forEach((s) => hub.subscribe(s!));

    await hub.onEvents({ accountId: selective.id, seqs: [s1.seq] });
    expect([o, m, gr, a].map((s) => s!.messages('event').length)).toEqual([1, 0, 1, 0]);

    await hub.onEvents({ accountId: hidden.id, seqs: [h1.seq] });
    expect([o, m, gr, a].map((s) => s!.messages('event').length)).toEqual([1, 0, 1, 1]);
  });

  it("applies each viewer's toast filter; the event is delivered either way", async () => {
    newHub();
    const loot = await seedEvent(t.db, zezima.id, { occurredAt: ago(MIN), valueGp: 1_000_000 });
    const death = await seedEvent(t.db, zezima.id, {
      type: 'death',
      occurredAt: ago(MIN),
      data: deathData(),
    });
    const cases = {
      minLootAbove: fakeSubscriber(member, { minLootValue: 5_000_000 }),
      minLootBelow: fakeSubscriber(member, { minLootValue: 500_000 }),
      ownOnlyMember: fakeSubscriber(member, { ownAccountsOnly: true }),
      ownOnlyContributor: fakeSubscriber(contributor, { ownAccountsOnly: true }),
      disabled: fakeSubscriber(owner, { enabled: false }),
      deathsOnly: fakeSubscriber(owner, { types: ['death'] }),
    };
    Object.values(cases).forEach((s) => hub.subscribe(s));

    await hub.onEvents({ accountId: zezima.id, seqs: [loot.seq, death.seq] });

    const toasts = Object.fromEntries(
      Object.entries(cases).map(([k, s]) => [k, eventsOf(s).map((e) => e.toast)]),
    );
    expect(toasts).toEqual({
      // [loot, death]: the minimum applies to loot only.
      minLootAbove: [false, true],
      minLootBelow: [true, true],
      ownOnlyMember: [false, false],
      ownOnlyContributor: [true, true],
      disabled: [false, false],
      deathsOnly: [false, true],
    });
  });

  it('never toasts an event older than 15 minutes (late from the retry queue), but delivers it', async () => {
    newHub();
    const old = await seedEvent(t.db, zezima.id, {
      occurredAt: ago(16 * MIN),
      receivedAt: ago(MIN),
      valueGp: 50_000_000,
    });
    const edge = await seedEvent(t.db, zezima.id, {
      occurredAt: ago(15 * MIN),
      receivedAt: NOW,
      valueGp: 50_000_000,
    });
    const o = fakeSubscriber(owner);
    hub.subscribe(o);

    await hub.onEvents({ accountId: zezima.id, seqs: [old.seq, edge.seq] });

    expect(eventsOf(o).map((e) => [e.event.seq, e.toast])).toEqual([
      [old.seq, false],
      [edge.seq, false],
    ]);
  });

  it('ignores seqs that belong to another account, and unknown seqs', async () => {
    newHub();
    const e = await seedEvent(t.db, privy.id, { occurredAt: ago(MIN) });
    const o = fakeSubscriber(owner);
    hub.subscribe(o);

    await hub.onEvents({ accountId: zezima.id, seqs: [e.seq, 999_999_999] });
    await hub.onEvents({ accountId: 999_999, seqs: [e.seq] });

    expect(o.chunks).toEqual([]);
  });

  it('handles notifications one at a time, in arrival order, even when an earlier one is slow', async () => {
    newHub();
    const a = await seedEvent(t.db, zezima.id, { occurredAt: ago(MIN) });
    const o = fakeSubscriber(owner);
    hub.subscribe(o);
    // Block only the events read: the state notification behind it needs no events row.
    const locker = await t.pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE events IN ACCESS EXCLUSIVE MODE');
      const first = hub.onEvents({ accountId: zezima.id, seqs: [a.seq] });
      const second = hub.onState({ accountId: zezima.id, deviceId: null });
      await new Promise((r) => setTimeout(r, 300));
      expect(o.chunks).toEqual([]);
      await locker.query('COMMIT');
      await Promise.all([first, second]);
    } finally {
      locker.release();
    }

    expect(o.messages().map((m) => m.event)).toEqual(['event', 'presence']);
  });

  it('never throws: a failed read is logged without its message, and the hub keeps working', async () => {
    const { logger, lines } = captureLogger();
    const broken = createDb(t.url, { max: 1 });
    await broken.pool.end();
    const brokenHub = new LiveHub({ db: broken.db, logger, metrics: createTestMetrics() });

    // Without subscribers nothing is read at all.
    await expect(brokenHub.onEvents({ accountId: zezima.id, seqs: [1] })).resolves.toBeUndefined();
    expect(lines).toEqual([]);

    const sub = fakeSubscriber(owner);
    brokenHub.subscribe(sub);
    await expect(brokenHub.onEvents({ accountId: zezima.id, seqs: [1] })).resolves.toBeUndefined();
    await expect(
      brokenHub.onState({ accountId: zezima.id, deviceId: null }),
    ).resolves.toBeUndefined();
    const dropped = lines.filter((l) => l.includes('live: notification dropped'));
    expect(dropped).toHaveLength(2);
    // DB-3: neither the query nor its parameters.
    expect(dropped.join('\n')).not.toMatch(/Failed query|params|select /i);

    brokenHub.onReconnect();
    expect(sub.messages('resync')).toHaveLength(1);
  });
});

describe('LiveHub.onState', () => {
  let offline: SeededAccount;
  let fresh: SeededAccount;

  beforeAll(async () => {
    await seedLatestState(t.db, zezima.id, {
      lastSeen: ago(30_000),
      gameState: 'LOGGED_IN',
      world: 302,
      worldTypes: ['MEMBERS'],
    });
    await seedLatestState(t.db, privy.id, {
      lastSeen: ago(30_000),
      gameState: 'LOGGED_IN',
      world: 420,
    });
    offline = await seedAccount(t.db, { name: 'Offline Otto', ownerUserId: owner.userId });
    await seedLatestState(t.db, offline.id, {
      lastSeen: ago(2 * MIN),
      gameState: 'LOGGED_IN',
      tickDelay: 30, // timeout 60 s (floor)
      world: 330,
      specialWorld: true,
    });
    fresh = await seedAccount(t.db, { name: 'Fresh Fay', ownerUserId: owner.userId });
  });

  it('sends presence to viewers who may read activity', async () => {
    newHub();
    const subs = [owner, contributor, member, grace, blocked].map((v) => fakeSubscriber(v));
    subs.forEach((s) => hub.subscribe(s));

    await hub.onState({ accountId: zezima.id, deviceId: null });
    await hub.onState({ accountId: privy.id, deviceId: null });

    const [o, c, m, g, b] = subs;
    const expected: PresenceMessage = {
      account: { publicId: zezima.publicId, name: 'Zezima', accountType: 1 },
      online: true,
      world: 302,
      specialWorld: false,
      lastSeen: ago(30_000).toISOString(),
      // No tickDelay: the 25-minute timeout, 30 s of it gone.
      onlineForMs: 25 * MIN - 30_000,
    };
    expect(m!.messages('presence').map((x) => x.data)).toEqual([expected]);
    expect(b!.messages('presence').map((x) => x.data)).toEqual([expected]);
    expect(o!.messages('presence')).toHaveLength(2);
    expect(c!.messages('presence')).toHaveLength(2);
    expect(g!.chunks).toEqual([]);
    // Presence messages carry no id: they must not move the client's Last-Event-ID.
    expect(o!.messages('presence').every((x) => x.id === undefined)).toBe(true);
  });

  it('sends presence of a hidden account to admins only (not even its owner)', async () => {
    newHub();
    const subs = [owner, member, admin].map((v) => fakeSubscriber(v));
    subs.forEach((s) => hub.subscribe(s));

    await hub.onState({ accountId: hidden.id, deviceId: null });

    expect(subs.map((s) => s.messages('presence').length)).toEqual([0, 0, 1]);
  });

  it('tells the client how long "online" stays true, since no message comes when it expires', async () => {
    // A crash, a lost connection or a hop to a special world sends nothing more: the stale-session
    // job ends the session without a notification, so the client must expire "online" itself.
    newHub();
    const quick = await seedAccount(t.db, { name: 'Quick Quinn', ownerUserId: owner.userId });
    await seedLatestState(t.db, quick.id, {
      lastSeen: ago(20_000),
      gameState: 'LOGGED_IN',
      tickDelay: 100, // floor(100 × 1.86) = 186 s
    });
    const o = fakeSubscriber(owner);
    hub.subscribe(o);

    await hub.onState({ accountId: quick.id, deviceId: null });
    await hub.onState({ accountId: offline.id, deviceId: null });

    const [online, off] = o.messages('presence').map((x) => x.data as PresenceMessage);
    expect(online).toMatchObject({ online: true, onlineForMs: 186_000 - 20_000 });
    expect(off).toMatchObject({ online: false, onlineForMs: 0 });
  });

  it('computes online with isOnline at the hub clock', async () => {
    newHub();
    const o = fakeSubscriber(owner);
    hub.subscribe(o);

    await hub.onState({ accountId: offline.id, deviceId: null });
    await hub.onState({ accountId: fresh.id, deviceId: null });

    const [off, none] = o.messages('presence').map((x) => x.data as PresenceMessage);
    expect(off).toMatchObject({ online: false, world: 330, specialWorld: true });
    // No latest_state yet: offline, no world, the account's own last_seen.
    expect(none).toMatchObject({ online: false, world: null, specialWorld: false });
    expect(Number.isNaN(Date.parse(none!.lastSeen))).toBe(false);
  });

  it("sends 'device' on a device's first data to that device's owner only", async () => {
    newHub();
    const contributorDevice = await seedDevice(t.db, contributor.userId);
    const ownerDevice = await seedDevice(t.db, owner.userId);
    const [o, c, m] = [owner, contributor, member].map((v) => fakeSubscriber(v));
    [o, c, m].forEach((s) => hub.subscribe(s!));

    await hub.onState({
      accountId: zezima.id,
      deviceId: contributorDevice,
      firstDataForDevice: true,
    });
    await hub.onState({ accountId: zezima.id, deviceId: ownerDevice, firstDataForDevice: true });
    // Not the first data: no device message.
    await hub.onState({ accountId: zezima.id, deviceId: contributorDevice });

    const account = { publicId: zezima.publicId, name: 'Zezima', accountType: 1 };
    expect(c!.messages('device').map((x) => x.data)).toEqual([
      {
        deviceId: contributorDevice,
        account,
        role: 'contributor',
        ownerName: 'Owner Olga',
      } satisfies DeviceMessage,
    ]);
    expect(o!.messages('device').map((x) => x.data)).toEqual([
      { deviceId: ownerDevice, account, role: 'owner', ownerName: 'Owner Olga' },
    ]);
    expect(m!.messages('device')).toEqual([]);
    expect(m!.messages('presence')).toHaveLength(3);
  });

  it("sends 'device' regardless of categories, and names no owner when there is none", async () => {
    newHub();
    const stranger = await seedUser(t.db, { name: 'Stranger Stu' });
    const orphan = await seedAccount(t.db, { name: 'Orphan Ole' });
    await share(t.db, orphan.id, 'activity', 'private');
    const device = await seedDevice(t.db, stranger.userId);
    const s = fakeSubscriber(stranger);
    hub.subscribe(s);

    await hub.onState({ accountId: orphan.id, deviceId: device, firstDataForDevice: true });
    await hub.onState({ accountId: privy.id, deviceId: device, firstDataForDevice: true });

    expect(s.messages('presence')).toEqual([]);
    expect(s.messages('device').map((x) => x.data)).toEqual([
      {
        deviceId: device,
        account: { publicId: orphan.publicId, name: 'Orphan Ole', accountType: null },
        role: 'contributor',
        ownerName: null,
      },
      {
        deviceId: device,
        account: { publicId: privy.publicId, name: 'Private Pete', accountType: null },
        role: 'contributor',
        ownerName: 'Owner Olga',
      },
    ]);
  });
});

describe('LiveHub reads', () => {
  /** A hub on its own drizzle instance that counts the queries it runs. */
  function countingHub(): { hub: LiveHub; queries: () => number } {
    let count = 0;
    const db: Db = drizzle(t.pool, { schema, logger: { logQuery: () => void count++ } });
    const counted = new LiveHub({
      db,
      logger: captureLogger().logger,
      metrics: createTestMetrics(),
      now: () => NOW,
    });
    return { hub: counted, queries: () => count };
  }

  it('reads once per notification, however many streams are open (no query per subscriber)', async () => {
    const device = await seedDevice(t.db, owner.userId);
    const e = await seedEvent(t.db, zezima.id, {
      type: 'death',
      occurredAt: ago(MIN),
      data: deathData(),
    });
    const run = async (viewers: Awaited<ReturnType<typeof seedUser>>[]) => {
      const { hub: h, queries } = countingHub();
      const subs = viewers.map((v) => fakeSubscriber(v));
      subs.forEach((s) => h.subscribe(s));
      await h.onEvents({ accountId: zezima.id, seqs: [e.seq] });
      await h.onState({ accountId: zezima.id, deviceId: device, firstDataForDevice: true });
      return { queries: queries(), subs };
    };

    const one = await run([member]);
    const many = await run([owner, contributor, member, granted, blocked, admin, owner, member]);

    expect(many.queries).toBe(one.queries);
    expect(one.subs[0]!.messages('event')).toHaveLength(1);
    expect(many.subs.every((s) => s.messages('event').length === 1)).toBe(true);
  });
});

describe('LiveHub.onPairing and onReconnect', () => {
  it('sends pairing progress only to the streams of the code owner', () => {
    newHub();
    const [a1, a2, other] = [owner, owner, member].map((v) => fakeSubscriber(v));
    [a1, a2, other].forEach((s) => hub.subscribe(s!));
    const codeId = '01900000-0000-7000-8000-000000000001';
    const deviceId = '01900000-0000-7000-8000-000000000002';

    hub.onPairing({ kind: 'consumed', userId: owner.userId, codeId, deviceId });
    hub.onPairing({ kind: 'outdated_plugin', userId: owner.userId, codeId, version: '1.4.2' });

    for (const s of [a1, a2]) {
      expect(s!.messages('pairing').map((x) => x.data)).toEqual([
        { kind: 'consumed', codeId, deviceId },
        { kind: 'outdated_plugin', codeId, version: '1.4.2' },
      ]);
    }
    expect(other!.chunks).toEqual([]);
  });

  it("sends 'resync' to every stream", () => {
    newHub();
    const subs = [owner, member, grace].map((v) => fakeSubscriber(v));
    subs.forEach((s) => hub.subscribe(s));

    hub.onReconnect();

    for (const s of subs) expect(s.messages()).toEqual([{ event: 'resync', data: {} }]);
  });
});

describe('LiveHub subscriptions', () => {
  it('unsubscribe is idempotent and the connection gauge follows size()', async () => {
    newHub();
    const a = fakeSubscriber(owner);
    const b = fakeSubscriber(member);
    const offA = hub.subscribe(a);
    const offB = hub.subscribe(b);
    expect(hub.size()).toBe(2);
    expect(await gauge(metrics)).toBe(2);

    offA();
    offA();
    expect(hub.size()).toBe(1);
    expect(await gauge(metrics)).toBe(1);

    // The same object twice is two subscriptions.
    const offB2 = hub.subscribe(b);
    expect(hub.size()).toBe(2);
    hub.onReconnect();
    expect(b.messages('resync')).toHaveLength(2);
    expect(a.chunks).toEqual([]);

    offB();
    offB2();
    offB2();
    expect(hub.size()).toBe(0);
    expect(await gauge(metrics)).toBe(0);
  });

  it('counts open streams per user; the count falls when a stream ends for any reason (D-80)', async () => {
    newHub();
    const offs = [0, 1, 2].map(() => hub.subscribe(fakeSubscriber(member)));
    hub.subscribe(fakeSubscriber(owner));
    expect(hub.streamsOf(member.userId)).toBe(3);
    expect(hub.streamsOf(owner.userId)).toBe(1);
    expect(hub.streamsOf('nobody')).toBe(0);

    // Unsubscribed by the route (client gone, session over, shutdown); idempotent.
    offs[0]!();
    offs[0]!();
    expect(hub.streamsOf(member.userId)).toBe(2);

    // Dropped by the hub: a send that fails…
    const bad: LiveSubscriber = {
      ...fakeSubscriber(member),
      send() {
        throw new Error('stream closed');
      },
    };
    const offBad = hub.subscribe(bad);
    expect(hub.streamsOf(member.userId)).toBe(3);
    hub.onReconnect();
    expect(hub.streamsOf(member.userId)).toBe(2);
    offBad(); // the route's own cleanup afterwards changes nothing
    expect(hub.streamsOf(member.userId)).toBe(2);

    // …and a user who lost access (offboarded) before the next fan-out.
    const leaver = await seedUser(t.db, { name: 'Leaving Lea' });
    hub.subscribe(fakeSubscriber(leaver));
    hub.subscribe(fakeSubscriber(leaver));
    expect(hub.streamsOf(leaver.userId)).toBe(2);
    await t.db.update(users).set({ status: 'grace' }).where(eq(users.id, leaver.userId));
    await hub.onState({ accountId: zezima.id, deviceId: null });
    expect(hub.streamsOf(leaver.userId)).toBe(0);

    offs[1]!();
    offs[2]!();
    expect(hub.streamsOf(member.userId)).toBe(0);
    expect(hub.size()).toBe(1);
  });

  it('drops a throwing subscriber (and closes it) without affecting the others', async () => {
    const { logger, lines } = captureLogger();
    newHub(logger);
    let sends = 0;
    let closes = 0;
    const bad: LiveSubscriber = {
      viewer: member,
      toast: fakeSubscriber(member).toast,
      send() {
        sends++;
        throw new Error('stream closed');
      },
      close() {
        closes++;
        throw new Error('close throws too');
      },
    };
    const before = fakeSubscriber(owner);
    const after = fakeSubscriber(member);
    hub.subscribe(before);
    const offBad = hub.subscribe(bad);
    hub.subscribe(after);
    const e = await seedEvent(t.db, zezima.id, { occurredAt: ago(MIN) });

    await hub.onEvents({ accountId: zezima.id, seqs: [e.seq] });

    expect(before.messages('event')).toHaveLength(1);
    expect(after.messages('event')).toHaveLength(1);
    expect([sends, closes]).toEqual([1, 1]);
    expect(hub.size()).toBe(2);
    expect(await gauge(metrics)).toBe(2);
    expect(lines.some((l) => l.includes('send failed'))).toBe(true);

    hub.onReconnect();
    expect(sends).toBe(1);
    offBad(); // the route's own cleanup afterwards is a no-op
    expect(hub.size()).toBe(2);
  });

  it('re-reads subscribed users before a fan-out: offboarded or deleted users are dropped, a demoted admin loses the override', async () => {
    // The route captures the viewer when the stream opens, but a stream can stay open for days:
    // offboarding (worker process) or an admin change must take effect on the next notification.
    newHub();
    const leaver = await seedUser(t.db, { name: 'Leaver Lou' });
    const deleted = await seedUser(t.db, { name: 'Deleted Dee' });
    const exAdmin = await seedUser(t.db, { name: 'Ex-admin Ed', isAdmin: true });
    const closed: string[] = [];
    const sub = (v: Awaited<ReturnType<typeof seedUser>>) => {
      const s = fakeSubscriber(v);
      s.close = () => void closed.push(v.userId);
      hub.subscribe(s);
      return s;
    };
    const [l, d, x, m] = [leaver, deleted, exAdmin, member].map(sub);
    await t.db.update(users).set({ status: 'grace' }).where(eq(users.id, leaver.userId));
    await t.db.delete(users).where(eq(users.id, deleted.userId));
    await t.db.update(users).set({ isAdmin: false }).where(eq(users.id, exAdmin.userId));
    const e = await seedEvent(t.db, zezima.id, { occurredAt: ago(MIN) });
    const h = await seedEvent(t.db, hidden.id, { occurredAt: ago(MIN) });

    await hub.onEvents({ accountId: zezima.id, seqs: [e.seq] });
    await hub.onEvents({ accountId: hidden.id, seqs: [h.seq] });
    await hub.onState({ accountId: zezima.id, deviceId: null });

    expect(l!.chunks).toEqual([]);
    expect(d!.chunks).toEqual([]);
    expect(closed.sort()).toEqual([leaver.userId, deleted.userId].sort());
    expect(hub.size()).toBe(2);
    expect(await gauge(metrics)).toBe(2);
    // Still a member: guild events and presence, but no hidden account any more.
    expect(x!.messages('event').map((msg) => msg.id)).toEqual([String(e.seq)]);
    expect(x!.messages('presence')).toHaveLength(1);
    expect(m!.messages('event').map((msg) => msg.id)).toEqual([String(e.seq)]);
  });

  it('a stream subscribed while the users are re-read is kept', async () => {
    newHub();
    const early = fakeSubscriber(member);
    hub.subscribe(early);
    const late = fakeSubscriber(owner);
    const e = await seedEvent(t.db, zezima.id, { occurredAt: ago(MIN) });

    const pending = hub.onEvents({ accountId: zezima.id, seqs: [e.seq] });
    hub.subscribe(late);
    await pending;

    expect(hub.size()).toBe(2);
    expect(early.messages('event')).toHaveLength(1);
    expect(late.messages('event')).toHaveLength(1);
  });

  it('a subscriber that unsubscribes another while receiving does not break the loop', () => {
    newHub();
    const second = fakeSubscriber(member);
    let offSecond = () => {};
    const first: LiveSubscriber = {
      ...fakeSubscriber(owner),
      send() {
        offSecond();
      },
    };
    hub.subscribe(first);
    offSecond = hub.subscribe(second);

    hub.onReconnect();

    expect(second.chunks).toEqual([]);
    expect(hub.size()).toBe(1);
  });
});
