import { DEFAULT_TOAST_FILTER, type ToastFilter } from '@hub/core';
import { events, type Db } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { eq, inArray, max } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FeedEvent } from '../feed';
import {
  LIVE_POLL_SETTLE_MS,
  LIVE_REPLAY_MAX_AGE_MS,
  replayEvents,
  settledLiveCursor,
} from './replay';
import {
  deathData,
  grant,
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

/**
 * `db`, running `hook` right after the first SELECT that replayEvents issues has returned (so a test
 * can change the table between its queries).
 */
function afterFirstQuery(db: Db, hook: () => Promise<void>): Db {
  let fired = false;
  const wrap = (builder: {
    from: (...a: unknown[]) => { execute: (...a: unknown[]) => Promise<unknown> };
  }) => {
    const from = builder.from.bind(builder);
    builder.from = (...args: unknown[]) => {
      const query = from(...args);
      const execute = query.execute.bind(query);
      query.execute = async (...a: unknown[]) => {
        const result = await execute(...a);
        if (!fired) {
          fired = true;
          await hook();
        }
        return result;
      };
      return query;
    };
    return builder;
  };
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if ((prop === 'select' || prop === 'selectDistinct') && typeof value === 'function') {
        return (...args: unknown[]) => wrap(value.apply(target, args));
      }
      return value;
    },
  });
}

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
    // No location category for the member: neither is shared (both are by default, D-96).
    await share(t.db, guildAcc.id, 'location_live', 'private');
    await share(t.db, guildAcc.id, 'location_history', 'private');
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

  it('applies the resolver: hidden accounts only for admins, selected audiences only with a grant', async () => {
    const base = await baseline();
    const admin = await seedUser(t.db, { isAdmin: true });
    const granted = await seedUser(t.db);
    const hiddenAcc = await seedAccount(t.db, {
      name: 'Hidden Hal',
      ownerUserId: owner.userId,
      status: 'hidden',
    });
    const selectedAcc = await seedAccount(t.db, { name: 'Selective Sam' });
    await share(t.db, selectedAcc.id, 'events', 'selected');
    await grant(t.db, selectedAcc.id, 'events', granted.userId);
    const h = await seedEvent(t.db, hiddenAcc.id, { occurredAt: ago(MIN) });
    const s = await seedEvent(t.db, selectedAcc.id, { occurredAt: ago(MIN) });

    expect(seqs(await replay(owner, { afterSeq: base }))).toEqual([]);
    expect(seqs(await replay(admin, { afterSeq: base }))).toEqual([h.seq]);
    expect(seqs(await replay(member, { afterSeq: base }))).toEqual([]);
    expect(seqs(await replay(granted, { afterSeq: base }))).toEqual([s.seq]);
  });

  it('the window excludes an event received exactly maxAgeMs ago', async () => {
    const base = await baseline();
    await seedEvent(t.db, guildAcc.id, { occurredAt: ago(6 * MIN), receivedAt: ago(5 * MIN) });
    const inside = await seedEvent(t.db, guildAcc.id, {
      occurredAt: ago(6 * MIN),
      receivedAt: ago(5 * MIN - 1),
    });

    expect(seqs(await replay(member, { afterSeq: base }))).toEqual([inside.seq]);
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

  it('with settleMs, stops at the first unsettled seq: a later settled row must not move the cursor past it (DB-4)', async () => {
    // inserted_at order can differ from seq order (a backend descheduled between taking its seq and
    // its clock_timestamp(), or the database clock stepping back). A settled row above an unsettled
    // one would move the client's cursor past the unsettled row for good.
    const base = await baseline();
    const settledBefore = await seedEvent(t.db, guildAcc.id, {
      occurredAt: ago(MIN),
      insertedAt: new Date(Date.now() - 2 * LIVE_POLL_SETTLE_MS),
    });
    const unsettled = await seedEvent(t.db, guildAcc.id, { occurredAt: ago(MIN) });
    await seedEvent(t.db, guildAcc.id, {
      occurredAt: ago(MIN),
      insertedAt: new Date(Date.now() - 2 * LIVE_POLL_SETTLE_MS),
    });

    const polled = await replay(member, { afterSeq: base, settleMs: LIVE_POLL_SETTLE_MS });
    expect(seqs(polled)).toEqual([settledBefore.seq]);
    // Once it has settled, the client gets it and everything after.
    await t.db
      .update(events)
      .set({ insertedAt: new Date(Date.now() - 2 * LIVE_POLL_SETTLE_MS) })
      .where(eq(events.id, unsettled.id));
    const next = await replay(member, {
      afterSeq: settledBefore.seq,
      settleMs: LIVE_POLL_SETTLE_MS,
    });
    expect(seqs(next)[0]).toBe(unsettled.seq);
    expect(next).toHaveLength(2);
  });

  it('never returns a row above what its access check saw, so rows landing in between are not skipped', async () => {
    // The accounts are read first, the rows second. Rows that become visible (or settle) in between
    // come from accounts the first read didn't see; returning a later row of a known account would
    // move the cursor past them.
    const base = await baseline();
    const other = await seedAccount(t.db, { name: 'Newcomer Ned', ownerUserId: owner.userId });
    const old = new Date(Date.now() - 2 * LIVE_POLL_SETTLE_MS);
    const known = await seedEvent(t.db, guildAcc.id, { occurredAt: ago(MIN), insertedAt: old });
    const newcomer = await seedEvent(t.db, other.id, { occurredAt: ago(MIN) });
    const later = await seedEvent(t.db, guildAcc.id, { occurredAt: ago(MIN) });
    // Both settle right after the first query: the moment time passes the settle margin.
    const db = afterFirstQuery(t.db, async () => {
      await t.db
        .update(events)
        .set({ insertedAt: old })
        .where(inArray(events.id, [newcomer.id, later.id]));
    });

    const polled = await replayEvents(db, member, {
      afterSeq: base,
      maxAgeMs: LIVE_REPLAY_MAX_AGE_MS,
      now: NOW,
      toast: TOAST,
      settleMs: LIVE_POLL_SETTLE_MS,
    });
    expect(seqs(polled)).toEqual([known.seq]);
    expect(
      seqs(await replay(member, { afterSeq: known.seq, settleMs: LIVE_POLL_SETTLE_MS })),
    ).toEqual([newcomer.seq, later.seq]);
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

describe('settledLiveCursor', () => {
  it('is 0 on a hub without events, then the newest seq below the first unsettled one (DB-4)', async () => {
    // Its own database: the cursor looks at every account's events.
    const fresh = await createTestDatabase('live-cursor');
    try {
      expect(await settledLiveCursor(fresh.db)).toBe(0);
      const u = await seedUser(fresh.db);
      const acc = await seedAccount(fresh.db, { name: 'Zezima', ownerUserId: u.userId });
      const settledAt = new Date(Date.now() - 2 * LIVE_POLL_SETTLE_MS);
      const old = await seedEvent(fresh.db, acc.id, {
        occurredAt: ago(3 * MIN),
        insertedAt: new Date(Date.now() - 3 * MIN),
      });
      const settled = await seedEvent(fresh.db, acc.id, {
        occurredAt: ago(MIN),
        insertedAt: settledAt,
      });
      // Inserted just now: a lower seq may still commit after it, so the cursor stops below it,
      // even though a settled row follows it (seq order and inserted_at order can differ).
      const young = await seedEvent(fresh.db, acc.id, { occurredAt: ago(MIN) });
      await seedEvent(fresh.db, acc.id, { occurredAt: ago(MIN), insertedAt: settledAt });
      expect(old.seq).toBeLessThan(settled.seq);
      expect(await settledLiveCursor(fresh.db)).toBe(settled.seq);
      await fresh.db.update(events).set({ insertedAt: settledAt }).where(eq(events.id, young.id));
      expect(await settledLiveCursor(fresh.db)).toBeGreaterThan(young.seq);
    } finally {
      await fresh.drop();
    }
  });
});
