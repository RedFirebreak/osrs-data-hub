import { createDb } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
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

  it('keeps notification order when handlers overlap', async () => {
    newHub();
    const a = await seedEvent(t.db, zezima.id, { occurredAt: ago(MIN) });
    const b = await seedEvent(t.db, privy.id, { occurredAt: ago(MIN) });
    const o = fakeSubscriber(owner);
    hub.subscribe(o);

    await Promise.all([
      hub.onEvents({ accountId: zezima.id, seqs: [a.seq] }),
      hub.onEvents({ accountId: privy.id, seqs: [b.seq] }),
    ]);

    expect(o.messages('event').map((m) => m.id)).toEqual([String(a.seq), String(b.seq)]);
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
    expect(lines.filter((l) => l.includes('live: notification dropped'))).toHaveLength(2);

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
    };
    expect(m!.messages('presence').map((x) => x.data)).toEqual([expected]);
    expect(b!.messages('presence').map((x) => x.data)).toEqual([expected]);
    expect(o!.messages('presence')).toHaveLength(2);
    expect(c!.messages('presence')).toHaveLength(2);
    expect(g!.chunks).toEqual([]);
    // Presence messages carry no id: they must not move the client's Last-Event-ID.
    expect(o!.messages('presence').every((x) => x.id === undefined)).toBe(true);
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
