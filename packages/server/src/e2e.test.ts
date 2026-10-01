/**
 * The whole server across its groups, the way the web routes and the worker drive it: a device is
 * paired through the wizard's code (pairing), real plugin payloads go through handleIngest (ingest),
 * the read models show them to the owner and to a guild member (accounts), the NOTIFY that ingest
 * sends reaches LiveHub streams through the LISTEN connection (live), the decommission switch stops
 * ingest and pairing (settings), and offboarding revokes the device (ingest answers 401) and hides the
 * account until restoreUser brings it back (offboarding). Each group has its own tests; this file
 * checks that what one writes is what the next reads.
 */
import type { Viewer } from '@hub/core';
import { events, osrsAccounts, users } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { FIXTURE_ACCOUNTS, fixtureJson, type FixtureName } from '@hub/fixtures';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAccountPage, type AccountPage } from './accounts/account-page';
import { loadViewer } from './accounts/access';
import { getDashboard } from './accounts/dashboard';
import { getSessions } from './accounts/history';
import { listFeed } from './accounts/list-feed';
import { listAuditLog } from './admin/audit-log';
import { listDevices } from './devices/devices';
import type { FeedEvent } from './feed';
import { handleIngest } from './ingest/handler';
import { createIngestLimiter } from './ingest/limits';
import { captureLogger, counterValue, type Wire } from './ingest/test-support';
import type { IngestDeps } from './ingest/types';
import { LiveHub } from './live/hub';
import { startLiveListener, type LiveListener } from './live/listener';
import type { DeviceMessage, LiveEventMessage, PairingMessage } from './live/messages';
import { fakeSubscriber } from './live/test-support';
import { createTestMetrics, type HubMetrics } from './metrics';
import { offboardUser, restoreUser } from './offboarding/offboard';
import { createPairingCode, getDeviceFirstData, getPairingCodeStatus } from './pairing/codes';
import { createPairLimits } from './pairing/limits';
import { handlePair, PAIR_MESSAGES, type PairDeps } from './pairing/pair';
import type { PluginResponse } from './plugin/protocol';
import { isDecommissioned, setDecommissioned } from './settings/decommission';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const IP = '198.51.100.20';

type Subscriber = ReturnType<typeof fakeSubscriber> & { closed: boolean };

let t: TestDatabase;
let metrics: HubMetrics;
let logLines: Record<string, unknown>[];
let ingestDeps: IngestDeps;
let pairDeps: PairDeps;
let hub: LiveHub;
let listener: LiveListener;
/** The one clock of the scenario (epoch ms): ingest, pairing, the hub and the read models. */
const clock = { now: 0 };

let ownerId: string;
let memberId: string;
let adminId: string;
let ownerStream: Subscriber;
let memberStream: Subscriber;
/** The owner's paired device (token from handlePair). */
let device: { id: string; token: string };
let zezima: { id: number; publicId: string };

const at = (ms: number) => new Date(ms);

async function seedUser(name: string, opts: { isAdmin?: boolean } = {}): Promise<string> {
  const id = `e2e-${name.toLowerCase()}`;
  await t.db.insert(users).values({
    id,
    name,
    email: `${id}@discord.invalid`,
    isAdmin: opts.isAdmin ?? false,
  });
  return id;
}

async function viewer(userId: string): Promise<Viewer> {
  const v = await loadViewer(t.db, userId);
  if (!v) throw new Error(`no user ${userId}`);
  return v;
}

function subscribe(v: Viewer): Subscriber {
  const sub: Subscriber = Object.assign(fakeSubscriber(v), {
    closed: false,
    close() {
      sub.closed = true;
    },
  });
  hub.subscribe(sub);
  return sub;
}

/** The wizard: createPairingCode for the user, then the plugin's POST /pair with that code. */
async function pairDevice(userId: string, label: string): Promise<{ id: string; token: string }> {
  const code = await createPairingCode(t.db, {
    userId,
    label,
    ttlSeconds: 300,
    now: at(clock.now),
  });
  const res = await pair(code.code);
  expect(res.status).toBe(200);
  const body = res.body as { ok: boolean; token: string; device_id: string; name: string };
  expect(body).toMatchObject({ ok: true, name: 'E2E Hub' });
  return { id: body.device_id, token: body.token };
}

function pair(code: string): Promise<PluginResponse> {
  return handlePair(pairDeps, { versionHeader: '1.5', ip: IP, body: JSON.stringify({ code }) });
}

/** POST /api/osrs-data/events as the route handler builds it, received at `recv`. */
function ingest(token: string, body: unknown, recv: number): Promise<PluginResponse> {
  clock.now = recv;
  const text = JSON.stringify(body);
  return handleIngest(ingestDeps, {
    token,
    versionHeader: '1.5',
    ip: IP,
    readBody: (max) => Promise.resolve(Buffer.byteLength(text, 'utf8') > max ? null : text),
  });
}

/**
 * A fixture received one second after its own timestamp. `keepStats` false drops the skills: the
 * Zezima fixtures aren't XP-consistent over time and would trip the XP guard (D-24) after the first
 * snapshot, which isn't what this file is about.
 */
async function send(
  token: string,
  name: FixtureName,
  opts: { keepStats?: boolean; offset?: number } = {},
): Promise<PluginResponse> {
  const body = fixtureJson<Wire>(name);
  if (!opts.keepStats && body.player) delete body.player.stats;
  if (opts.offset !== undefined && typeof body.timestamp === 'number') {
    body.timestamp += opts.offset;
  }
  return ingest(token, body, (body.timestamp as number) + SECOND);
}

async function storedEvents(accountId: number) {
  return t.db
    .select({ id: events.id, seq: events.seq, type: events.type })
    .from(events)
    .where(eq(events.accountId, accountId))
    .orderBy(asc(events.seq));
}

function eventMessages(sub: Subscriber): LiveEventMessage[] {
  return sub.messages('event').map((m) => m.data as LiveEventMessage);
}

function locationOf(event: FeedEvent): unknown {
  return ((event.data as { data?: Record<string, unknown> }).data ?? {}).location;
}

function shared<T>(section: { visible: boolean; shared?: boolean; data?: T }): T {
  if (!section.visible || !section.shared) throw new Error('section not shared');
  return section.data as T;
}

async function page(v: Viewer, publicId: string): Promise<AccountPage | null> {
  return getAccountPage(t.db, v, publicId, { now: at(clock.now) });
}

beforeAll(async () => {
  t = await createTestDatabase('server-e2e');
  metrics = createTestMetrics();
  const captured = captureLogger();
  const logger = captured.logger;
  logLines = captured.lines;
  clock.now = fixtureJson<{ timestamp: number }>('snapshot-normal').timestamp - 10 * MINUTE;

  ingestDeps = {
    db: t.db,
    minPluginVersion: '1.5',
    maxBodyBytes: 256 * 1024,
    limiter: createIngestLimiter({ clock: { now: () => clock.now } }),
    logger,
    metrics,
    // What the route passes: the admin switch from hub_settings (cached, cleared on change).
    isDecommissioned: () => isDecommissioned(t.db),
    now: () => at(clock.now),
  };
  pairDeps = {
    db: t.db,
    minPluginVersion: '1.5',
    hubName: 'E2E Hub',
    limits: createPairLimits({ clock: { now: () => clock.now } }),
    logger,
    metrics,
    isDecommissioned: () => isDecommissioned(t.db),
    now: () => at(clock.now),
  };
  hub = new LiveHub({ db: t.db, logger, metrics, now: () => at(clock.now) });
  listener = startLiveListener({ connectionString: t.url, hub, logger });
  await vi.waitFor(() => expect(listener.connected()).toBe(true), { timeout: 5_000 });

  ownerId = await seedUser('Owner');
  memberId = await seedUser('Member');
  adminId = await seedUser('Admin', { isAdmin: true });
  ownerStream = subscribe(await viewer(ownerId));
  memberStream = subscribe(await viewer(memberId));
});

afterAll(async () => {
  await listener?.stop();
  // The switch is cached per process (globalThis): leave it off for other files in this worker.
  if (t) await setDecommissioned(t.db, { value: false, actorUserId: adminId });
  await t?.drop();
});

describe('pairing', () => {
  it('pairs a device with a wizard code and tells the wizard', async () => {
    const code = await createPairingCode(t.db, {
      userId: ownerId,
      label: 'Desktop PC',
      ttlSeconds: 300,
      now: at(clock.now),
    });
    const res = await pair(code.code);
    expect(res.status).toBe(200);
    const body = res.body as { token: string; device_id: string };
    device = { id: body.device_id, token: body.token };

    expect(
      await getPairingCodeStatus(t.db, { userId: ownerId, codeId: code.id, now: at(clock.now) }),
    ).toMatchObject({ status: 'consumed', deviceId: device.id });
    await vi.waitFor(() => expect(ownerStream.messages('pairing')).toHaveLength(1));
    expect(ownerStream.messages('pairing')[0]?.data).toEqual({
      kind: 'consumed',
      codeId: code.id,
      deviceId: device.id,
    } satisfies PairingMessage);
    expect(memberStream.messages('pairing')).toEqual([]);

    const [listed] = await listDevices(t.db, ownerId);
    expect(listed).toMatchObject({
      id: device.id,
      label: 'Desktop PC',
      status: 'active',
      pluginVersion: '1.5',
      firstDataAt: null,
      accounts: [],
    });
    expect(await getDeviceFirstData(t.db, { userId: ownerId, deviceId: device.id })).toBeNull();
  });
});

describe('ingest → read models → live', () => {
  it('stores real payloads from the paired device', async () => {
    const statuses: Record<string, number> = {};
    statuses['snapshot-normal'] = (
      await send(device.token, 'snapshot-normal', { keepStats: true })
    ).status;
    for (const name of [
      'snapshot-world-hop',
      'logout',
      'event-loot',
      'event-death-safe',
      'event-superior',
      'retry-duplicate-a',
      'retry-duplicate-b',
    ] as const) {
      statuses[name] = (await send(device.token, name)).status;
    }
    expect(Object.values(statuses).every((s) => s === 200)).toBe(true);

    const [account] = await t.db
      .select({ id: osrsAccounts.id, publicId: osrsAccounts.publicId })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.accountHash, FIXTURE_ACCOUNTS.zezima));
    if (!account) throw new Error('Zezima was not created');
    zezima = account;
    // loot, death, superior, and the resent loot once (retry-duplicate-a/-b share an eventId).
    expect((await storedEvents(zezima.id)).map((e) => e.type)).toEqual([
      'loot',
      'death',
      'superior_spawn',
      'loot',
    ]);
  });

  it('shows the device, its first account and its sessions', async () => {
    const [listed] = await listDevices(t.db, ownerId);
    expect(listed?.firstDataAt).not.toBeNull();
    expect(listed?.accounts).toEqual([
      { publicId: zezima.publicId, name: 'Zezima', lastSeen: expect.any(Date) as unknown },
    ]);
    expect(await getDeviceFirstData(t.db, { userId: ownerId, deviceId: device.id })).toEqual({
      account: { publicId: zezima.publicId, name: 'Zezima', accountType: expect.any(Number) },
      role: 'owner',
      ownerName: 'Owner',
    });

    const sessions = await getSessions(t.db, await viewer(ownerId), zezima.publicId, {
      from: at(clock.now - 2 * 86_400_000),
      to: at(clock.now),
    });
    // The first session ended with the logout fixture; loot reopened one that is still open.
    expect(sessions?.map((s) => s.endReason).sort()).toEqual(['logout', null].sort());
  });

  it("gives the owner a complete dashboard card and the member only what's shared", async () => {
    const owner = await viewer(ownerId);
    const member = await viewer(memberId);
    const now = at(clock.now);

    const mine = await getDashboard(t.db, owner, { now });
    expect(mine.accounts).toHaveLength(1);
    const [card] = mine.accounts;
    expect(card).toMatchObject({
      publicId: zezima.publicId,
      relation: 'owner',
      totalLevel: 2372, // Σ min(level, 99), PLUGIN-9
      presence: { visible: true, shared: true, data: { online: true } },
    });
    expect(card?.recentEvents.map((e) => e.type)).toEqual([
      'loot',
      'superior_spawn',
      'death',
      'loot',
    ]);

    const theirs = await getDashboard(t.db, member, { now });
    expect(theirs.accounts).toEqual([]);
    expect(theirs.onlineNow.map((o) => o.publicId)).toEqual([zezima.publicId]);
  });

  it('applies the sharing defaults on the account page and the feed', async () => {
    const owner = await viewer(ownerId);
    const member = await viewer(memberId);

    const own = await page(owner, zezima.publicId);
    expect(own?.account).toMatchObject({ relation: 'owner', canManage: true, hidden: false });
    expect(shared(own!.skills).totalLevel).toBe(2372);
    expect(own?.location).toMatchObject({ visible: true, shared: true });
    expect(own?.inventory).toMatchObject({ visible: true, shared: true });

    const theirs = await page(member, zezima.publicId);
    expect(theirs?.account).toMatchObject({ relation: 'member', canManage: false });
    expect(shared(theirs!.skills).totalLevel).toBe(2372);
    // Every category is shared with the guild by default (D-96).
    expect(theirs?.location).toMatchObject({ visible: true, shared: true });
    expect(theirs?.equipment).toMatchObject({ visible: true, shared: true });
    expect(theirs?.inventory).toMatchObject({ visible: true, shared: true });

    const ownFeed = await listFeed(t.db, owner, { accountPublicId: zezima.publicId });
    const memberFeed = await listFeed(t.db, member, { accountPublicId: zezima.publicId });
    expect(memberFeed.map((e) => e.id)).toEqual(ownFeed.map((e) => e.id));
    expect(ownFeed.filter((e) => locationOf(e) !== undefined).map((e) => e.type)).toEqual([
      'superior_spawn',
      'death',
    ]);
    // With live location (D-82) the member gets the same coordinates as the owner.
    expect(memberFeed.filter((e) => locationOf(e) !== undefined).map(locationOf)).toEqual(
      ownFeed.filter((e) => locationOf(e) !== undefined).map(locationOf),
    );
    expect(shared(theirs!.recentEvents).map((e) => e.id)).toEqual(memberFeed.map((e) => e.id));
  });

  it('streams the same events to both, redacted the same way as the feed', async () => {
    const stored = await storedEvents(zezima.id);
    await vi.waitFor(() => expect(eventMessages(ownerStream)).toHaveLength(stored.length));
    await vi.waitFor(() => expect(eventMessages(memberStream)).toHaveLength(stored.length));

    const ownerLive = eventMessages(ownerStream).map((m) => m.event);
    const memberLive = eventMessages(memberStream).map((m) => m.event);
    expect(ownerLive.map((e) => e.seq)).toEqual(stored.map((e) => e.seq));
    expect(memberLive.map((e) => e.seq)).toEqual(stored.map((e) => e.seq));
    const memberFeed = await listFeed(t.db, await viewer(memberId), {
      accountPublicId: zezima.publicId,
    });
    // The live stream and the page build events the same way (toFeedEvent, same redaction).
    expect([...memberLive].reverse()).toEqual(memberFeed);
    // The member has live location by default (D-82): the same coordinates as the owner's stream.
    expect(memberLive.filter((e) => locationOf(e) !== undefined).map(locationOf)).toEqual(
      ownerLive.filter((e) => locationOf(e) !== undefined).map(locationOf),
    );
    expect(memberLive.filter((e) => locationOf(e) !== undefined)).toHaveLength(2);

    // The wizard's step 3 reaches the device owner only, once.
    const devices = ownerStream.messages('device').map((m) => m.data as DeviceMessage);
    expect(devices).toEqual([
      {
        deviceId: device.id,
        account: { publicId: zezima.publicId, name: 'Zezima', accountType: expect.any(Number) },
        role: 'owner',
        ownerName: 'Owner',
      },
    ]);
    expect(memberStream.messages('device')).toEqual([]);
    expect(memberStream.messages('presence').length).toBeGreaterThan(0);
  });
});

describe('decommissioning', () => {
  it('makes ingest and pairing answer 410 until the switch is turned off', async () => {
    await setDecommissioned(t.db, { value: true, actorUserId: adminId });
    expect(await send(device.token, 'event-unknown-type')).toEqual({
      status: 410,
      body: { ok: false, error: 'This hub no longer accepts data.' },
    });
    const code = await createPairingCode(t.db, {
      userId: memberId,
      ttlSeconds: 300,
      now: at(clock.now),
    });
    expect(await pair(code.code)).toEqual({
      status: 410,
      body: { ok: false, error: PAIR_MESSAGES.decommissioned },
    });

    await setDecommissioned(t.db, { value: false, actorUserId: adminId });
    expect((await send(device.token, 'event-unknown-type')).status).toBe(200);
    expect((await pair(code.code)).status).toBe(200);
  });
});

describe('offboarding and coming back', () => {
  it("revokes the device (401), hides the account and ends the owner's stream", async () => {
    const before = (await storedEvents(zezima.id)).length;
    const result = await offboardUser(t.db, {
      userId: ownerId,
      reason: 'left_guild',
      graceDays: 30,
      now: at(clock.now),
    });
    expect(result).toEqual({
      transferred: [],
      hidden: [zezima.id],
      revokedDevices: 1,
      deletedSessions: 0,
    });

    expect(await send(device.token, 'event-combattask')).toEqual({
      status: 401,
      body: { ok: false, error: 'unauthorized' },
    });
    expect(await storedEvents(zezima.id)).toHaveLength(before);
    expect(await listDevices(t.db, ownerId)).toMatchObject([
      { id: device.id, status: 'revoked', revokedReason: 'offboarding' },
    ]);

    // Hidden from members (handoff §10), still there for admins.
    const member = await viewer(memberId);
    expect(await page(member, zezima.publicId)).toBeNull();
    expect(await listFeed(t.db, member, { accountPublicId: zezima.publicId })).toEqual([]);
    expect((await getDashboard(t.db, member, { now: at(clock.now) })).onlineNow).toEqual([]);
    expect((await page(await viewer(adminId), zezima.publicId))?.account.hidden).toBe(true);

    // The next fan-out re-reads the subscribed users: the grace user's stream is closed, the
    // member's gets the new event (the member's own device, their own account).
    const ownerEvents = eventMessages(ownerStream).length;
    const memberToken = await pairDevice(memberId, 'Laptop');
    expect(
      (await send(memberToken.token, 'event-death-dangerous', { keepStats: true })).status,
    ).toBe(200);
    await vi.waitFor(() =>
      expect(eventMessages(memberStream).map((m) => m.event.account.name)).toContain('Iron Mira'),
    );
    await vi.waitFor(() => expect(ownerStream.closed).toBe(true));
    expect(eventMessages(ownerStream)).toHaveLength(ownerEvents);
    const [iron] = await t.db
      .select({ ownerUserId: osrsAccounts.ownerUserId })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.accountHash, FIXTURE_ACCOUNTS.ironMira));
    expect(iron?.ownerUserId).toBe(memberId);
  });

  it('restores the user: the account is visible again, the old token stays revoked', async () => {
    expect(await restoreUser(t.db, { userId: ownerId, actorUserId: adminId })).toEqual({
      unhidden: [zezima.id],
    });
    expect((await send(device.token, 'event-combattask')).status).toBe(401);

    clock.now += MINUTE;
    ownerStream = subscribe(await viewer(ownerId));
    const fresh = await pairDevice(ownerId, 'New PC');
    expect((await send(fresh.token, 'event-combattask')).status).toBe(200);
    await vi.waitFor(() =>
      expect(eventMessages(ownerStream).map((m) => m.event.type)).toContain('combat_task'),
    );

    const member = await viewer(memberId);
    const theirs = await page(member, zezima.publicId);
    expect(theirs?.account.hidden).toBe(false);
    expect(shared(theirs!.recentEvents)[0]?.type).toBe('combat_task');
    expect((await listDevices(t.db, ownerId)).map((d) => [d.label, d.status])).toEqual([
      ['New PC', 'active'],
      ['Desktop PC', 'revoked'],
    ]);
  });

  it('left an audit trail and counted every outcome', async () => {
    const actions = (await listAuditLog(t.db, { limit: 100 })).map((r) => r.action);
    expect(actions.filter((a) => a === 'device.paired')).toHaveLength(4);
    expect(actions.filter((a) => a === 'hub.decommissioned')).toHaveLength(2);
    expect(actions).toContain('user.offboarded');
    expect(actions).toContain('user.restored');

    expect(await counterValue(metrics.ingestPayloads, { status: '410' })).toBe(1);
    expect(await counterValue(metrics.ingestPayloads, { status: '401' })).toBe(2);
    expect(await counterValue(metrics.ingestPayloads, { status: '500' })).toBe(0);
    expect(await counterValue(metrics.ingestPayloads, { status: '503' })).toBe(0);
    // Nothing failed on the way (the hub logs 'live: notification dropped' on a failed read).
    expect(logLines.filter((l) => l.level !== undefined && Number(l.level) >= 50)).toEqual([]);
  });
});
