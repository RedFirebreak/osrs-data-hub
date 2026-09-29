import { DEFAULT_TOAST_FILTER, type ToastFilter } from '@hub/core';
import { events } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { max } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FeedEvent } from '../feed';
import { LIVE_POLL_SETTLE_MS, LIVE_REPLAY_MAX_AGE_MS, replayEvents } from './replay';
import {
  deathData,
  link,
  seedAccount,
  seedEvent,
  seedUser,
  share,
  type SeededAccount,
} from './test-support';

// Real time: `settleMs` compares inserted_at with the database clock.
const NOW = new Date();
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const TOAST: ToastFilter = DEFAULT_TOAST_FILTER;

let t: TestDatabase;
let owner: Awaited<ReturnType<typeof seedUser>>;
let contributor: Awaited<ReturnType<typeof seedUser>>;
let member: Awaited<ReturnType<typeof seedUser>>;
let grace: Awaited<ReturnType<typeof seedUser>>;
let guildAcc: SeededAccount;
let privateAcc: SeededAccount;

beforeAll(async () => {
  t = await createTestDatabase('live-replay');
  owner = await seedUser(t.db);
  contributor = await seedUser(t.db);
  member = await seedUser(t.db);
  grace = await seedUser(t.db, { status: 'grace' });
  guildAcc = await seedAccount(t.db, { name: 'Zezima', ownerUserId: owner.userId });
  await link(t.db, guildAcc.id, contributor.userId);
  privateAcc = await seedAccount(t.db, { name: 'Private Pete', ownerUserId: owner.userId });
  await share(t.db, privateAcc.id, 'events', 'private');
});

afterAll(async () => {
  await t.drop();
});

/** The highest seq so far: each test replays only what it seeded after it. */
async function baseline(): Promise<number> {
  const [row] = await t.db.select({ seq: max(events.seq) }).from(events);
  return row?.seq ?? 0;
}

function seqs(list: { event: FeedEvent }[]): number[] {
  return list.map((m) => m.event.seq);
}

function replay(
  viewer: Awaited<ReturnType<typeof seedUser>>,
  opts: Partial<Parameters<typeof replayEvents>[2]> & { afterSeq: number },
) {
  return replayEvents(t.db, viewer, {
    maxAgeMs: LIVE_REPLAY_MAX_AGE_MS,
    now: NOW,
    toast: TOAST,
    ...opts,
  });
}

describe('replayEvents', () => {
  it('returns the events after the cursor within the window, ascending, for the viewer', async () => {
    const base = await baseline();
    const tooOld = await seedEvent(t.db, guildAcc.id, { occurredAt: ago(10 * MIN) });
    const loot = await seedEvent(t.db, guildAcc.id, {
      occurredAt: ago(4 * MIN),
      valueGp: 1_000_000,
    });
    const hidden = await seedEvent(t.db, privateAcc.id, { occurredAt: ago(3 * MIN) });
    const death = await seedEvent(t.db, guildAcc.id, {
      type: 'death',
      occurredAt: ago(2 * MIN),
      data: deathData(),
    });
    // Late from the plugin's retry queue: received a minute ago, occurred 16 minutes ago.
    const late = await seedEvent(t.db, guildAcc.id, {
      occurredAt: ago(16 * MIN),
      receivedAt: ago(MIN),
    });

    const forMember = await replay(member, { afterSeq: base });
    expect(seqs(forMember)).toEqual([loot.seq, death.seq, late.seq]);
    expect(forMember.map((m) => m.toast)).toEqual([true, true, false]);
    expect(forMember[0]?.event).toMatchObject({
      id: loot.id,
      type: 'loot',
      account: { publicId: guildAcc.publicId, name: 'Zezima' },
      valueGp: 1_000_000,
    });
    // Redacted for a member without location categories.
    expect(forMember[1]?.event.data).toMatchObject({ data: { killerName: 'Lynx Titan' } });
    expect(JSON.stringify(forMember[1]?.event.data)).not.toContain('3858');

    const forOwner = await replay(owner, { afterSeq: base });
    expect(seqs(forOwner)).toEqual([loot.seq, hidden.seq, death.seq, late.seq]);
    expect(JSON.stringify(forOwner[2]?.event.data)).toContain('3858');

    // The cursor excludes what the client already has; the old event never comes back.
    expect(seqs(await replay(member, { afterSeq: loot.seq }))).toEqual([death.seq, late.seq]);
    expect(seqs(await replay(owner, { afterSeq: late.seq }))).toEqual([]);
    expect(seqs(await replay(owner, { afterSeq: base }))).not.toContain(tooOld.seq);
  });

  it('applies the toast filter of the viewer and "own accounts" from the resolver', async () => {
    const base = await baseline();
    await seedEvent(t.db, guildAcc.id, { occurredAt: ago(MIN), valueGp: 1_000 });
    const ownOnly = { ...TOAST, ownAccountsOnly: true };

    const [m] = await replay(member, { afterSeq: base, toast: ownOnly });
    const [c] = await replay(contributor, { afterSeq: base, toast: ownOnly });
    const [rich] = await replay(owner, {
      afterSeq: base,
      toast: { ...TOAST, minLootValue: 5_000 },
    });
    expect([m?.toast, c?.toast, rich?.toast]).toEqual([false, true, false]);
  });

  it('respects the limit, keeping the lowest seqs so the client continues from there', async () => {
    const base = await baseline();
    const a = await seedEvent(t.db, guildAcc.id, { occurredAt: ago(MIN) });
    const b = await seedEvent(t.db, guildAcc.id, { occurredAt: ago(MIN) });
    await seedEvent(t.db, guildAcc.id, { occurredAt: ago(MIN) });

    expect(seqs(await replay(member, { afterSeq: base, limit: 2 }))).toEqual([a.seq, b.seq]);
    expect(seqs(await replay(member, { afterSeq: base, limit: 0 }))).toEqual([a.seq]);
    expect(await replay(member, { afterSeq: base, limit: Number.NaN })).toHaveLength(3);
  });

  it('filters accounts before the limit, so invisible bursts never hide visible events', async () => {
    const base = await baseline();
    for (let i = 0; i < 5; i++) await seedEvent(t.db, privateAcc.id, { occurredAt: ago(MIN) });
    const visible = await seedEvent(t.db, guildAcc.id, { occurredAt: ago(MIN) });

    expect(seqs(await replay(member, { afterSeq: base, limit: 3 }))).toEqual([visible.seq]);
  });

  it('returns nothing for a viewer in grace, or for a window that matches nothing', async () => {
    const base = await baseline();
    await seedEvent(t.db, guildAcc.id, { occurredAt: ago(MIN) });

    expect(await replay(grace, { afterSeq: base })).toEqual([]);
    expect(await replay(member, { afterSeq: base, maxAgeMs: 0 })).toEqual([]);
    expect(await replay(member, { afterSeq: base, maxAgeMs: Number.NaN })).toEqual([]);
    expect(await replay(member, { afterSeq: base, now: new Date(Number.NaN) })).toEqual([]);
  });

  it('treats a cursor that is not a safe integer as 0', async () => {
    const base = await baseline();
    const e = await seedEvent(t.db, guildAcc.id, { occurredAt: ago(MIN) });

    for (const afterSeq of [Number.NaN, -5, 1e300]) {
      expect(seqs(await replay(member, { afterSeq }))).toContain(e.seq);
    }
    expect(seqs(await replay(member, { afterSeq: base }))).toEqual([e.seq]);
  });

  it('still replays rows whose seq order differs slightly from their receive order', async () => {
    const base = await baseline();
    // Received inside the window but inserted before a row received just outside it (a slow
    // transaction): the seq bound of the scan must not cut it off.
    const inside = await seedEvent(t.db, guildAcc.id, {
      occurredAt: ago(4.5 * MIN),
      receivedAt: ago(4.5 * MIN),
    });
    await seedEvent(t.db, guildAcc.id, { occurredAt: ago(5.5 * MIN), receivedAt: ago(5.5 * MIN) });
    const after = await seedEvent(t.db, guildAcc.id, { occurredAt: ago(MIN) });

    expect(seqs(await replay(member, { afterSeq: base }))).toEqual([inside.seq, after.seq]);
    expect(seqs(await replay(member, { afterSeq: 0 }))).toEqual(
      expect.arrayContaining([inside.seq, after.seq]),
    );
  });

  it('holds back rows that may still have a lower seq pending when settleMs is set (DB-4)', async () => {
    const base = await baseline();
    const settled = await seedEvent(t.db, guildAcc.id, {
      occurredAt: ago(MIN),
      insertedAt: new Date(Date.now() - 2 * LIVE_POLL_SETTLE_MS),
    });
    const fresh = await seedEvent(t.db, guildAcc.id, { occurredAt: ago(MIN) });

    expect(seqs(await replay(member, { afterSeq: base }))).toEqual([settled.seq, fresh.seq]);
    expect(seqs(await replay(member, { afterSeq: base, settleMs: LIVE_POLL_SETTLE_MS }))).toEqual([
      settled.seq,
    ]);
  });
});
