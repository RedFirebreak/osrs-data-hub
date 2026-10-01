/**
 * Sharing mutations racing the other writers of an account, with real concurrent transactions:
 * the ingest transaction (it holds the payload's account_links row from its first statements and
 * writes the account row late, TSDB-12) and offboarding (it locks the user row, then the accounts).
 * Each test parks the other writer at a known point by holding a lock it needs next, starts the
 * mutation, waits until the mutation is either done or waiting on a lock, then lets the writer go.
 */
import type { Viewer } from '@hub/core';
import { accountLinks, osrsAccounts, users } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAccount, seedLink } from '../accounts/test-support';
import { ACCOUNT_LOCK_CLASS } from '../ingest/lock';
import {
  captureLogger,
  createHarness,
  newHash,
  wire,
  type Harness,
  type SeededDevice,
  type Wire,
} from '../ingest/test-support';
import { offboardUser } from '../offboarding';
import { SharingError } from './errors';
import {
  claimOwnership,
  removeContributor,
  setContributorBlocked,
  transferOwnership,
} from './mutations';

let t: TestDatabase;
let h: Harness;
let logLines: Record<string, unknown>[];
/** Holds the locks that park the other writer (a plain connection, so statements run one by one). */
let holder: pg.Client;
/** Reads pg_stat_activity. */
let observer: pg.Client;

const viewerOf = (userId: string): Viewer => ({ userId, status: 'active', isAdmin: false });

beforeAll(async () => {
  t = await createTestDatabase('sharing-concurrency');
  const captured = captureLogger();
  logLines = captured.lines;
  h = createHarness(t, { logger: captured.logger });
  holder = new pg.Client({ connectionString: t.url });
  observer = new pg.Client({ connectionString: t.url });
  await holder.connect();
  await observer.connect();
});

afterAll(async () => {
  await holder.end();
  await observer.end();
  await t.drop();
});

beforeEach(() => {
  logLines.length = 0;
});

/** Backends of this database (other than the observer) waiting for a heavyweight lock. */
async function lockWaiters(): Promise<number> {
  const r = await observer.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
  );
  return r.rows[0]?.n ?? 0;
}

/** Polls until `done()` or 3 s have passed. */
async function waitUntil(done: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

function settledFlag(p: Promise<unknown>): { settled: boolean } {
  const flag = { settled: false };
  p.then(
    () => (flag.settled = true),
    () => (flag.settled = true),
  );
  return flag;
}

describe('against an ingest transaction in flight (no deadlock, TSDB-12)', () => {
  interface Scene {
    accountId: number;
    publicId: string;
    owner: string;
    contributor: string;
    other: string;
    contributorDevice: SeededDevice;
    body: Wire;
    at: number;
  }

  /**
   * An account reported by its owner, `contributor` and `other`, and the contributor's next payload
   * (with an XP change, so it writes xp_samples) ready to send.
   */
  async function scene(): Promise<Scene> {
    const hash = newHash();
    const owner = await h.seedUser();
    const contributor = await h.seedUser();
    const other = await h.seedUser();
    const ownerDevice = await h.seedDevice(owner);
    const contributorDevice = await h.seedDevice(contributor);
    const otherDevice = await h.seedDevice(other);
    const first = wire('snapshot-normal', { hash });
    const base = first.timestamp as number;
    expect((await h.send(ownerDevice, first, { at: base + 1_000 })).status).toBe(200);
    expect((await h.send(contributorDevice, first, { at: base + 2_000 })).status).toBe(200);
    expect((await h.send(otherDevice, first, { at: base + 3_000 })).status).toBe(200);
    const [account] = await t.db
      .select({ id: osrsAccounts.id, publicId: osrsAccounts.publicId })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.accountHash, hash));
    if (!account) throw new Error('account missing');

    const body = wire('snapshot-normal', { hash });
    body.timestamp = base + 600_000;
    const attack = body.player?.stats?.skills.Attack;
    if (attack) attack.xp += 1_000;
    return {
      accountId: account.id,
      publicId: account.publicId,
      owner,
      contributor,
      other,
      contributorDevice,
      body,
      at: base + 601_000,
    };
  }

  /**
   * Sends the contributor's payload and parks it on its device row (touchDeviceWithData locks it),
   * i.e. after it took the account lock and wrote its account_links row; runs `mutate`; releases
   * the payload once the mutation is done or waiting; returns both outcomes.
   */
  async function race(
    s: Scene,
    mutate: () => Promise<void>,
  ): Promise<{ status: number; mutation: PromiseSettledResult<void> }> {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM devices WHERE id = $1 FOR UPDATE', [s.contributorDevice.id]);
    const sent = h.send(s.contributorDevice, s.body, { at: s.at });
    const sentFlag = settledFlag(sent);
    await waitUntil(async () => sentFlag.settled || (await lockWaiters()) >= 1);
    expect(sentFlag.settled).toBe(false);

    const mutation = mutate();
    const flag = settledFlag(mutation);
    await waitUntil(async () => flag.settled || (await lockWaiters()) >= 2);
    await holder.query('COMMIT');
    const [response, outcome] = await Promise.allSettled([sent, mutation]);
    if (response.status !== 'fulfilled') throw response.reason;
    return { status: response.value.status, mutation: outcome };
  }

  /** Ingest retried its transaction (it was a deadlock victim). */
  const ingestRetried = () => logLines.some((l) => l.msg === 'ingest: retrying');

  it('blocks a contributor whose payload is being stored', async () => {
    const s = await scene();
    const r = await race(s, () =>
      setContributorBlocked(t.db, viewerOf(s.owner), s.publicId, s.contributor, true),
    );
    expect(r.mutation).toEqual({ status: 'fulfilled', value: undefined });
    expect(r.status).toBe(200);
    expect(ingestRetried()).toBe(false);
    const [link] = await t.db
      .select({ blocked: accountLinks.blocked })
      .from(accountLinks)
      .where(and(eq(accountLinks.accountId, s.accountId), eq(accountLinks.userId, s.contributor)));
    expect(link?.blocked).toBe(true);
  });

  it('removes a contributor whose payload is being stored', async () => {
    const s = await scene();
    const r = await race(s, () =>
      removeContributor(t.db, viewerOf(s.owner), s.publicId, s.contributor),
    );
    expect(r.mutation).toEqual({ status: 'fulfilled', value: undefined });
    expect(r.status).toBe(200);
    expect(ingestRetried()).toBe(false);
    // The payload committed first, so the removal came after it and deleted the link.
    const links = await t.db
      .select({ userId: accountLinks.userId })
      .from(accountLinks)
      .where(eq(accountLinks.accountId, s.accountId));
    expect(links.map((l) => l.userId)).not.toContain(s.contributor);
  });

  it('transfers ownership while a contributor payload is being stored', async () => {
    const s = await scene();
    const r = await race(s, () => transferOwnership(t.db, viewerOf(s.owner), s.publicId, s.other));
    expect(r.mutation).toEqual({ status: 'fulfilled', value: undefined });
    expect(r.status).toBe(200);
    expect(ingestRetried()).toBe(false);
    const [account] = await t.db
      .select({ ownerUserId: osrsAccounts.ownerUserId })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.id, s.accountId));
    expect(account?.ownerUserId).toBe(s.other);
  });
});

describe('against an offboarding in flight', () => {
  /**
   * Starts offboardUser(userId) and parks it after it locked the user row and set 'grace' (its
   * uncommitted state), on the account lock of `parkOn`, an account the user owns.
   */
  async function parkOffboarding(
    userId: string,
    parkOn: number,
  ): Promise<{ offboarding: Promise<unknown> }> {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1::int4, $2::int4)', [
      ACCOUNT_LOCK_CLASS,
      parkOn,
    ]);
    const offboarding = offboardUser(t.db, { userId, reason: 'left_guild', graceDays: 30 });
    const flag = settledFlag(offboarding);
    await waitUntil(async () => flag.settled || (await lockWaiters()) >= 1);
    expect(flag.settled).toBe(false);
    // Wrapped: an async function returning the promise itself would wait for it.
    return { offboarding };
  }

  async function runWhileParked(
    offboarding: Promise<unknown>,
    mutation: Promise<void>,
  ): Promise<PromiseSettledResult<void>> {
    const flag = settledFlag(mutation);
    await waitUntil(async () => flag.settled || (await lockWaiters()) >= 2);
    await holder.query('COMMIT');
    await offboarding;
    const [outcome] = await Promise.allSettled([mutation]);
    return outcome as PromiseSettledResult<void>;
  }

  async function user(name: string): Promise<string> {
    const id = `${name}-${newHash().slice(0, 8)}`;
    await t.db.insert(users).values({ id, name, email: `${id}@discord.invalid` });
    return id;
  }

  it("doesn't make a user whose offboarding is committing the new owner", async () => {
    const owner = await user('owner');
    const leaving = await user('leaving');
    const account = await seedAccount(t.db, { owner, contributors: [leaving] });
    const theirs = await seedAccount(t.db, { owner: leaving });

    const { offboarding } = await parkOffboarding(leaving, theirs.id);
    const outcome = await runWhileParked(
      offboarding,
      transferOwnership(t.db, viewerOf(owner), account.publicId, leaving),
    );

    expect(outcome.status).toBe('rejected');
    const reason = (outcome as PromiseRejectedResult).reason as unknown;
    expect(reason).toBeInstanceOf(SharingError);
    expect((reason as SharingError).code).toBe('invalid');
    const [row] = await t.db
      .select({ ownerUserId: osrsAccounts.ownerUserId, status: osrsAccounts.status })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.id, account.id));
    expect(row).toEqual({ ownerUserId: owner, status: 'active' });
  });

  it("doesn't let a user whose offboarding is committing claim an account", async () => {
    const leaving = await user('claimer');
    const account = await seedAccount(t.db, { owner: null });
    await seedLink(t.db, account.id, leaving);
    const theirs = await seedAccount(t.db, { owner: leaving });

    const { offboarding } = await parkOffboarding(leaving, theirs.id);
    const outcome = await runWhileParked(
      offboarding,
      claimOwnership(t.db, viewerOf(leaving), account.publicId),
    );

    expect(outcome.status).toBe('rejected');
    expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: 'forbidden' });
    const [row] = await t.db
      .select({ ownerUserId: osrsAccounts.ownerUserId })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.id, account.id));
    expect(row?.ownerUserId).toBeNull();
  });
});
