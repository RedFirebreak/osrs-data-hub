/**
 * The whole live path on real payloads: the fixtures go through ingest (which calls pg_notify inside
 * its transaction), the LISTEN connection, the hub and two streams. Proves the notifications ingest
 * writes are the ones the listener accepts, and that the live stream and the replay show a viewer the
 * same events, redacted the same way.
 */
import { events } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { FIXTURES, fixtureJson, type FixtureName } from '@hub/fixtures';
import { asc } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness, type SeededDevice } from '../ingest/test-support';
import { createTestMetrics } from '../metrics';
import { notifyPairing } from '../notify';
import { LiveHub } from './hub';
import { startLiveListener, type LiveListener, type LiveSink } from './listener';
import type { DeviceMessage, LiveEventMessage, PresenceMessage } from './messages';
import { replayEvents } from './replay';
import { captureLogger, fakeSubscriber, seedAccount, share } from './test-support';

const EVENT_FIXTURES = FIXTURES.filter((name) => name.startsWith('event-')).sort(
  (a, b) => timestampOf(a) - timestampOf(b),
);

function timestampOf(name: FixtureName): number {
  return fixtureJson<{ timestamp: number }>(name).timestamp;
}

function locationOf(message: LiveEventMessage): unknown {
  return ((message.event.data as { data?: Record<string, unknown> }).data ?? {}).location;
}

let t: TestDatabase;
let h: Harness;
let listener: LiveListener;
let hub: LiveHub;
let device: SeededDevice;
let owner: ReturnType<typeof fakeSubscriber>;
let member: ReturnType<typeof fakeSubscriber>;
let memberId: string;
/** Everything the listener and the hub logged. */
let logLines: string[];
/** State notifications the listener forwarded to the hub. */
let stateNotifications = 0;

beforeAll(async () => {
  t = await createTestDatabase('live-e2e');
  h = createHarness(t);
  const { logger, lines } = captureLogger();
  logLines = lines;
  hub = new LiveHub({
    db: t.db,
    logger,
    metrics: createTestMetrics(),
    now: () => new Date(h.clock.now),
  });
  device = await h.seedDevice();
  memberId = await h.seedUser();
  // Live location is shared with the guild by default (D-82). The fixture accounts keep it private,
  // so the member has no location category: created bare ahead of ingest, which fills them in.
  const names = new Map<string, string>();
  for (const name of FIXTURES) {
    const player = fixtureJson<{ player?: { accountHash?: string; name?: string } }>(name).player;
    if (player?.accountHash && !names.get(player.accountHash)) {
      names.set(player.accountHash, player.name ?? '');
    }
  }
  for (const [accountHash, name] of names) {
    const account = await seedAccount(t.db, { name: name || 'Unknown', accountHash });
    await share(t.db, account.id, 'location_live', 'private');
  }
  owner = fakeSubscriber({ userId: device.userId, status: 'active', isAdmin: false });
  member = fakeSubscriber({ userId: memberId, status: 'active', isAdmin: false });
  hub.subscribe(owner);
  hub.subscribe(member);
  const sink: LiveSink = {
    onEvents: (n) => hub.onEvents(n),
    onState: (n) => {
      stateNotifications++;
      return hub.onState(n);
    },
    onPairing: (n) => hub.onPairing(n),
    onReconnect: () => hub.onReconnect(),
  };
  listener = startLiveListener({ connectionString: t.url, hub: sink, logger });
  await vi.waitFor(() => expect(listener.connected()).toBe(true), { timeout: 5_000 });
});

afterAll(async () => {
  await listener?.stop();
  await t.drop();
});

describe('ingest → NOTIFY → listener → hub, on every event fixture', () => {
  it('delivers every stored event to the owner and (redacted) to a guild member, in seq order', async () => {
    for (const name of EVENT_FIXTURES) {
      const res = await h.send(device, fixtureJson(name));
      expect({ name, status: res.status }).toEqual({ name, status: 200 });
    }
    const stored = await t.db
      .select({ id: events.id, seq: events.seq, type: events.type })
      .from(events)
      .orderBy(asc(events.seq));
    expect(stored.length).toBeGreaterThanOrEqual(EVENT_FIXTURES.length);

    await vi.waitFor(() => expect(owner.messages('event')).toHaveLength(stored.length), {
      timeout: 5_000,
    });
    await vi.waitFor(() => expect(member.messages('event')).toHaveLength(stored.length));
    // One presence per payload, and the wizard's 'device' message once, to the device owner only.
    await vi.waitFor(() => expect(owner.messages('presence')).toHaveLength(EVENT_FIXTURES.length));

    const ownerEvents = owner.messages('event').map((m) => m.data as LiveEventMessage);
    const memberEvents = member.messages('event').map((m) => m.data as LiveEventMessage);
    expect(ownerEvents.map((m) => m.event.id)).toEqual(stored.map((s) => s.id));
    expect(memberEvents.map((m) => m.event.id)).toEqual(stored.map((s) => s.id));
    expect(owner.messages('event').map((m) => Number(m.id))).toEqual(stored.map((s) => s.seq));

    // Death and superior locations: the owner sees them, the member (no location category) doesn't.
    const located = ownerEvents.filter((m) => locationOf(m) !== undefined);
    expect(located.map((m) => m.event.type).sort()).toEqual(
      ['death', 'death', 'superior_spawn'].sort(),
    );
    expect(memberEvents.filter((m) => locationOf(m) !== undefined)).toEqual([]);
    for (const m of memberEvents) {
      expect(m.event.title.length).toBeGreaterThan(0);
      expect(m.event.line).toContain(m.event.account.name);
    }

    const devices = owner.messages('device').map((m) => m.data as DeviceMessage);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ deviceId: device.id, role: 'owner' });
    expect(member.messages('device')).toEqual([]);
    const presence = member.messages('presence').map((m) => m.data as PresenceMessage);
    expect(presence.length).toBe(EVENT_FIXTURES.length);

    // A reconnecting stream replays exactly what the live stream showed, redacted the same way.
    const replayed = await replayEvents(
      t.db,
      { userId: memberId, status: 'active', isAdmin: false },
      {
        afterSeq: 0,
        maxAgeMs: 2 * 86_400_000,
        now: new Date(h.clock.now),
        toast: member.toast,
      },
    );
    expect(replayed.map((m) => m.event)).toEqual(memberEvents.map((m) => m.event));
  });
});

describe('ingest → NOTIFY → listener → hub, on every payload fixture', () => {
  /**
   * Waits until the listener has forwarded every notification committed so far and the hub has
   * handled them: a pairing notification sent now arrives after them, and the hub handles
   * notifications one at a time, so a no-op handled after it has seen them all.
   */
  async function drained(): Promise<void> {
    const codeId = crypto.randomUUID();
    await notifyPairing(t.db, {
      kind: 'outdated_plugin',
      userId: device.userId,
      codeId,
      version: null,
    });
    await vi.waitFor(() =>
      expect(
        owner.messages('pairing').some((m) => (m.data as { codeId: string }).codeId === codeId),
      ).toBe(true),
    );
    await hub.onState({ accountId: 2_000_000_000, deviceId: null });
  }

  it('every notification ingest sends is accepted and handled, and a member never sees coordinates', async () => {
    const payloads = FIXTURES.filter((name) => name !== 'pair-request').sort(
      (a, b) => timestampOf(a) - timestampOf(b),
    );
    const other = await h.seedDevice();
    await drained();
    const presenceBefore = owner.messages('presence').length;
    const statesBefore = stateNotifications;

    for (const name of payloads) {
      const res = await h.send(other, fixtureJson(name));
      // Never a 5xx: the plugin would stall its queue (PLUGIN-3).
      expect({ name, status: res.status }).toEqual({ name, status: 200 });
    }
    await drained();

    // One presence per state notification to the owner of every fixture account, and nothing
    // malformed, dropped or failed on the way.
    const states = stateNotifications - statesBefore;
    expect(states).toBeGreaterThan(payloads.length / 2);
    expect(owner.messages('presence').length - presenceBefore).toBe(states);
    expect(logLines.filter((l) => /malformed|dropped|failed/.test(l))).toEqual([]);
    expect(member.chunks.join('')).not.toMatch(/"location"/);
    for (const m of member.messages('presence')) {
      expect(Object.keys(m.data as PresenceMessage).sort()).toEqual(
        ['account', 'lastSeen', 'online', 'onlineForMs', 'specialWorld', 'world'].sort(),
      );
    }
  });
});
