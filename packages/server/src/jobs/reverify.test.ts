import { devices, users } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FetchFn, GuildPolicy } from '../discord';
import { createTestMetrics, type HubMetrics } from '../metrics';
import { captureLogger, seedDevice, seedUser, type LogLine } from '../offboarding/test-support';
import { breakerTrips, reverifyDueMembers, type ReverifyDeps } from './reverify';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase('reverify');
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  // The job picks every due user in the database: start each test from none.
  await t.db.delete(users);
});

const NOW = new Date('2026-09-28T12:00:00Z');
const HOUR = 3_600_000;
const GUILD = '900000000000000001';
const POLICY: GuildPolicy = {
  guildId: GUILD,
  requiredRoleIds: [],
  adminRoleIds: ['role-admin'],
  adminUserIds: ['100000000000000009'],
};

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | 'network';

function member(discordId: string, opts: { roles?: string[]; nick?: string | null } = {}) {
  return {
    status: 200,
    body: {
      user: {
        id: discordId,
        username: `user${discordId.slice(-2)}`,
        global_name: 'Global',
        avatar: 'abc',
      },
      nick: opts.nick ?? null,
      avatar: null,
      roles: opts.roles ?? ['role-member'],
    },
  };
}

const NOT_MEMBER: Reply = { status: 404, body: { message: 'Unknown Member', code: 10007 } };
const UNKNOWN_GUILD: Reply = { status: 404, body: { message: 'Unknown Guild', code: 10004 } };
const OUTAGE: Reply = { status: 502, body: { message: 'Bad Gateway' } };

/** A fake Discord: replies per Discord user id (a list is consumed one reply per call). */
function fakeDiscord(replies: Record<string, Reply | Reply[]>) {
  const calls: { discordId: string; authorization: string | null }[] = [];
  const fetchFn: FetchFn = async (input, init) => {
    const url = String(input);
    expect(url.startsWith(`https://discord.com/api/v10/guilds/${GUILD}/members/`)).toBe(true);
    const discordId = url.split('/').pop() ?? '';
    const headers = new Headers(init?.headers);
    calls.push({ discordId, authorization: headers.get('authorization') });
    const entry = replies[discordId];
    const reply = Array.isArray(entry) ? entry.shift() : entry;
    if (!reply) throw new Error(`no reply for ${discordId}`);
    if (reply === 'network') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  };
  return { fetchFn, calls };
}

let discordSeq = 0;
function nextDiscordId(): string {
  return `1000000000000${String(++discordSeq).padStart(5, '0')}`;
}

async function dueUser(opts: Parameters<typeof seedUser>[1] = {}) {
  const discordId = nextDiscordId();
  const id = await seedUser(t.db, { discordId, ...opts });
  return { id, discordId };
}

async function userRow(id: string) {
  const [row] = await t.db.select().from(users).where(eq(users.id, id));
  return row;
}

function setup(replies: Record<string, Reply | Reply[]>, over: Partial<ReverifyDeps> = {}) {
  const discord = fakeDiscord(replies);
  const { logger, lines } = captureLogger();
  const metrics = createTestMetrics();
  const sleeps: number[] = [];
  const deps: ReverifyDeps = {
    db: t.db,
    botToken: 'bot-secret',
    policy: POLICY,
    graceDays: 30,
    logger,
    metrics,
    now: NOW,
    fetchFn: discord.fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...over,
  };
  return { deps, calls: discord.calls, lines, metrics, sleeps };
}

async function failureCounts(metrics: HubMetrics): Promise<Record<string, number>> {
  const { values } = await metrics.discordVerifyFailures.get();
  return Object.fromEntries(values.map((v) => [String(v.labels.kind), v.value]));
}

const errors = (lines: LogLine[]) => lines.filter((l) => l.level === 50);

describe('breakerTrips', () => {
  it('trips above 20% departures once at least 5 users were checked', () => {
    expect(breakerTrips(4, 4)).toBe(false);
    expect(breakerTrips(5, 1)).toBe(false);
    expect(breakerTrips(5, 2)).toBe(true);
    expect(breakerTrips(10, 2)).toBe(false);
    expect(breakerTrips(10, 3)).toBe(true);
    expect(breakerTrips(25, 5)).toBe(false);
    expect(breakerTrips(25, 6)).toBe(true);
  });
});

describe('reverifyDueMembers', () => {
  it('refreshes members, offboards a definitive departure and fails open on errors', async () => {
    const ok = await Promise.all(
      Array.from({ length: 8 }, (_, i) => dueUser({ verifyFailures: i === 0 ? 3 : 0 })),
    );
    const left = await dueUser();
    const leftDevice = await seedDevice(t.db, left.id);
    const flaky = await dueUser({
      verifyFailures: 1,
      lastVerifiedAt: new Date(NOW.getTime() - 7 * HOUR),
    });
    const replies: Record<string, Reply> = {
      [left.discordId]: NOT_MEMBER,
      [flaky.discordId]: OUTAGE,
    };
    for (const u of ok) replies[u.discordId] = member(u.discordId, { nick: 'Nick' });
    const { deps, calls, metrics } = setup(replies);

    const result = await reverifyDueMembers(deps);

    expect(result).toEqual({ checked: 10, offboarded: 1, failures: 1, aborted: false });
    expect(calls.every((c) => c.authorization === 'Bot bot-secret')).toBe(true);
    const first = ok[0]!;
    expect(await userRow(first.id)).toMatchObject({
      status: 'active',
      name: 'Nick',
      nickname: 'Nick',
      image: `https://cdn.discordapp.com/avatars/${first.discordId}/abc.png`,
      roles: ['role-member'],
      isAdmin: false,
      lastVerifiedAt: NOW,
      verifyFailures: 0,
    });
    expect(await userRow(left.id)).toMatchObject({
      status: 'grace',
      offboardReason: 'left_guild',
      graceUntil: new Date(NOW.getTime() + 30 * 24 * HOUR),
    });
    const [device] = await t.db.select().from(devices).where(eq(devices.id, leftDevice));
    expect(device?.revokedReason).toBe('offboarding');
    expect(await userRow(flaky.id)).toMatchObject({
      status: 'active',
      verifyFailures: 2,
      lastVerifiedAt: new Date(NOW.getTime() - 7 * HOUR),
    });
    expect(await failureCounts(metrics)).toEqual({ unavailable: 1 });
  });

  it("offboards a member missing every required role as 'lost_role'", async () => {
    const keeps = await dueUser();
    const lost = await dueUser();
    const { deps } = setup(
      {
        [keeps.discordId]: member(keeps.discordId, { roles: ['role-b', 'role-x'] }),
        [lost.discordId]: member(lost.discordId, { roles: ['role-x'] }),
      },
      { policy: { ...POLICY, requiredRoleIds: ['role-a', 'role-b'] } },
    );

    expect(await reverifyDueMembers(deps)).toEqual({
      checked: 2,
      offboarded: 1,
      failures: 0,
      aborted: false,
    });
    expect(await userRow(keeps.id)).toMatchObject({
      status: 'active',
      roles: ['role-b', 'role-x'],
    });
    expect(await userRow(lost.id)).toMatchObject({ status: 'grace', offboardReason: 'lost_role' });
  });

  it('computes isAdmin from admin roles and admin user ids', async () => {
    const byRole = await dueUser({ isAdmin: false });
    const demoted = await dueUser({ isAdmin: true });
    const byId = {
      id: await seedUser(t.db, { discordId: '100000000000000009' }),
      discordId: '100000000000000009',
    };
    const { deps } = setup({
      [byRole.discordId]: member(byRole.discordId, { roles: ['role-admin'] }),
      [demoted.discordId]: member(demoted.discordId, { roles: [] }),
      [byId.discordId]: member(byId.discordId, { roles: [] }),
    });

    await reverifyDueMembers(deps);

    expect((await userRow(byRole.id))?.isAdmin).toBe(true);
    expect((await userRow(demoted.id))?.isAdmin).toBe(false);
    expect((await userRow(byId.id))?.isAdmin).toBe(true);
  });

  it('trips the circuit breaker: more than 20% departures in a batch of 5+ offboard nobody', async () => {
    const users5 = await Promise.all(Array.from({ length: 5 }, () => dueUser()));
    const [a, b, ...rest] = users5;
    const replies: Record<string, Reply> = { [a!.discordId]: NOT_MEMBER };
    replies[b!.discordId] = member(b!.discordId, { roles: [] });
    for (const u of rest) replies[u.discordId] = member(u.discordId);
    const { deps, lines } = setup(replies, {
      policy: { ...POLICY, requiredRoleIds: ['role-member'] },
    });

    const result = await reverifyDueMembers(deps);

    expect(result).toEqual({ checked: 5, offboarded: 0, failures: 0, aborted: true });
    expect(await userRow(a!.id)).toMatchObject({ status: 'active', lastVerifiedAt: null });
    expect(await userRow(b!.id)).toMatchObject({ status: 'active', lastVerifiedAt: null });
    // Members that did pass are still refreshed.
    expect((await userRow(rest[0]!.id))?.lastVerifiedAt).toEqual(NOW);
    expect(errors(lines)).toHaveLength(1);
    expect(errors(lines)[0]).toMatchObject({ checked: 5, departures: 2 });
  });

  it('judges the breaker on the users Discord answered for: errors do not dilute it', async () => {
    // A wrong DISCORD_REQUIRED_ROLE_IDS during a partial outage: every answer is "missing role".
    // 2 of 10 checks is exactly 20%, but 2 of the 5 answers is 40%.
    const due = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        dueUser({ lastVerifiedAt: new Date(NOW.getTime() - (20 - i) * HOUR) }),
      ),
    );
    const replies: Record<string, Reply> = {};
    due.forEach((u, i) => {
      replies[u.discordId] =
        i < 5 ? OUTAGE : member(u.discordId, { roles: i < 8 ? ['role-member'] : ['other'] });
    });
    const { deps, lines } = setup(replies, {
      policy: { ...POLICY, requiredRoleIds: ['role-member'] },
    });

    expect(await reverifyDueMembers(deps)).toEqual({
      checked: 10,
      offboarded: 0,
      failures: 5,
      aborted: true,
    });
    for (const u of due) expect((await userRow(u.id))?.status).toBe('active');
    expect(errors(lines)).toEqual([expect.objectContaining({ answered: 5, departures: 2 })]);
  });

  it('offboards departures in a batch too small for the breaker', async () => {
    const a = await dueUser();
    const b = await dueUser();
    const { deps } = setup({ [a.discordId]: NOT_MEMBER, [b.discordId]: NOT_MEMBER });

    expect(await reverifyDueMembers(deps)).toEqual({
      checked: 2,
      offboarded: 2,
      failures: 0,
      aborted: false,
    });
    expect((await userRow(a.id))?.status).toBe('grace');
    expect((await userRow(b.id))?.status).toBe('grace');
  });

  it('stops the batch when the first lookup says the guild is unknown (404 10004)', async () => {
    const first = await dueUser();
    const second = await dueUser({ lastVerifiedAt: new Date(NOW.getTime() - 7 * HOUR) });
    const { deps, calls, lines, metrics } = setup({
      [first.discordId]: UNKNOWN_GUILD,
      [second.discordId]: UNKNOWN_GUILD,
    });

    const result = await reverifyDueMembers(deps);

    expect(result).toEqual({ checked: 1, offboarded: 0, failures: 1, aborted: true });
    expect(calls).toHaveLength(1);
    expect(await userRow(first.id)).toMatchObject({ status: 'active', verifyFailures: 1 });
    expect(await userRow(second.id)).toMatchObject({ status: 'active', verifyFailures: 0 });
    expect(errors(lines)[0]).toMatchObject({ reason: 'config', status: 404, code: 10004 });
    expect(await failureCounts(metrics)).toEqual({ config: 1 });
  });

  it('stops the batch when the bot token is rejected', async () => {
    const first = await dueUser();
    await dueUser({ lastVerifiedAt: new Date(NOW.getTime() - 7 * HOUR) });
    const { deps, calls } = setup({ [first.discordId]: { status: 401, body: { code: 0 } } });

    expect(await reverifyDueMembers(deps)).toMatchObject({
      checked: 1,
      failures: 1,
      aborted: true,
    });
    expect(calls).toHaveLength(1);
  });

  it('never offboards on errors, whatever their kind', async () => {
    const kinds = [
      { status: 404, body: { code: 10004 } },
      { status: 404, body: { code: 10013 } },
      { status: 403, body: { code: 50001 } },
      { status: 500 },
      'network',
      // Last: running out of 429 retries stops the batch.
      { status: 429, body: { retry_after: 0.1 } },
    ] satisfies Reply[];
    // Checked first (never verified), so no run-wide error comes first and stops the batch.
    const found = await dueUser();
    const failing = await Promise.all(
      kinds.map((_, i) => dueUser({ lastVerifiedAt: new Date(NOW.getTime() - (20 - i) * HOUR) })),
    );
    const replies: Record<string, Reply | Reply[]> = { [found.discordId]: member(found.discordId) };
    failing.forEach((u, i) => {
      const reply = kinds[i]!;
      // 429 is retried twice before it counts as a failure.
      replies[u.discordId] =
        reply !== 'network' && reply.status === 429 ? [reply, reply, reply] : reply;
    });
    const { deps, metrics, sleeps } = setup(replies);

    const result = await reverifyDueMembers(deps);

    // Nobody was left after the 429, so nothing was cut short.
    expect(result).toEqual({ checked: 7, offboarded: 0, failures: 6, aborted: false });
    for (const u of failing)
      expect(await userRow(u.id)).toMatchObject({ status: 'active', verifyFailures: 1 });
    expect(await failureCounts(metrics)).toEqual({
      config: 2,
      auth: 1,
      rate_limited: 1,
      unavailable: 2,
    });
    expect(sleeps).toEqual([250, 250]);
  });

  it('honours a 429 retry_after through the injected sleep and then succeeds', async () => {
    const u = await dueUser();
    const { deps, sleeps } = setup({
      [u.discordId]: [
        { status: 429, body: { retry_after: 1.5, global: false } },
        member(u.discordId),
      ],
    });

    expect(await reverifyDueMembers(deps)).toMatchObject({ checked: 1, failures: 0 });
    expect(sleeps).toEqual([1500]);
    expect((await userRow(u.id))?.lastVerifiedAt).toEqual(NOW);
  });

  it('alerts once when a user reaches alertAfterFailures consecutive failures', async () => {
    const u = await dueUser({ verifyFailures: 3 });
    const run = async () => {
      const { deps, lines } = setup({ [u.discordId]: OUTAGE }, { alertAfterFailures: 5 });
      await reverifyDueMembers(deps);
      return lines.filter((l) => l.userId === u.id);
    };

    expect((await run()).map((l) => l.level)).toEqual([40]);
    const atFive = await run();
    expect(atFive).toHaveLength(1);
    expect(atFive[0]).toMatchObject({ level: 50, failures: 5, reason: 'unavailable', status: 502 });
    expect((await run()).map((l) => l.level)).toEqual([40]);
    expect((await userRow(u.id))?.verifyFailures).toBe(6);
  });

  it('resets the failure streak when a check succeeds', async () => {
    const u = await dueUser({ verifyFailures: 4 });
    const { deps } = setup({ [u.discordId]: member(u.discordId) });
    await reverifyDueMembers(deps);
    expect((await userRow(u.id))?.verifyFailures).toBe(0);
  });

  it('checks only active users with a Discord id who are due, oldest first, in batches', async () => {
    const never = await dueUser();
    const oldest = await dueUser({ lastVerifiedAt: new Date(NOW.getTime() - 30 * HOUR) });
    const older = await dueUser({ lastVerifiedAt: new Date(NOW.getTime() - 10 * HOUR) });
    const recent = await dueUser({ lastVerifiedAt: new Date(NOW.getTime() - 5 * HOUR) });
    const inGrace = await dueUser({ status: 'grace', graceUntil: new Date(NOW.getTime() + HOUR) });
    await seedUser(t.db, { discordId: null });
    const replies: Record<string, Reply> = {};
    for (const u of [never, oldest, older, recent, inGrace])
      replies[u.discordId] = member(u.discordId);

    const first = setup(replies, { batchSize: 2 });
    expect(await reverifyDueMembers(first.deps)).toMatchObject({ checked: 2 });
    expect(first.calls.map((c) => c.discordId)).toEqual([never.discordId, oldest.discordId]);

    const second = setup(replies, { batchSize: 2 });
    expect(await reverifyDueMembers(second.deps)).toMatchObject({ checked: 1 });
    expect(second.calls.map((c) => c.discordId)).toEqual([older.discordId]);

    const hourly = setup(replies, { intervalHours: 4 });
    await reverifyDueMembers(hourly.deps);
    expect(hourly.calls.map((c) => c.discordId)).toEqual([recent.discordId]);
  });

  it('keeps going past a per-user 404 that is neither Unknown Member nor Unknown Guild', async () => {
    // 10013 Unknown User (a deleted Discord account) says nothing about the bot or the guild. The
    // user is never verified again, so they stay first in line: stopping on them would stop
    // re-verification for everyone, every run.
    const unknownUser = await dueUser();
    const next = await dueUser({ lastVerifiedAt: new Date(NOW.getTime() - 7 * HOUR) });
    const { deps, calls } = setup({
      [unknownUser.discordId]: { status: 404, body: { message: 'Unknown User', code: 10013 } },
      [next.discordId]: member(next.discordId),
    });

    expect(await reverifyDueMembers(deps)).toEqual({
      checked: 2,
      offboarded: 0,
      failures: 1,
      aborted: false,
    });
    expect(calls.map((c) => c.discordId)).toEqual([unknownUser.discordId, next.discordId]);
    expect(await userRow(unknownUser.id)).toMatchObject({ status: 'active', verifyFailures: 1 });
    expect((await userRow(next.id))?.lastVerifiedAt).toEqual(NOW);
  });

  it('does not let users whose lookups keep failing starve everyone else', async () => {
    const stuck = await dueUser();
    const waiting = await dueUser({ lastVerifiedAt: new Date(NOW.getTime() - 7 * HOUR) });
    const replies = { [stuck.discordId]: OUTAGE, [waiting.discordId]: member(waiting.discordId) };

    const first = setup(replies, { batchSize: 1 });
    await reverifyDueMembers(first.deps);
    expect(first.calls.map((c) => c.discordId)).toEqual([stuck.discordId]);

    const second = setup(replies, { batchSize: 1 });
    await reverifyDueMembers(second.deps);
    expect(second.calls.map((c) => c.discordId)).toEqual([waiting.discordId]);
    expect((await userRow(waiting.id))?.lastVerifiedAt).toEqual(NOW);
  });

  it('treats a 200 without a roles list as an outage, never as a lost role (fail open)', async () => {
    const u = await dueUser();
    const { user } = member(u.discordId).body;
    const { deps, metrics } = setup(
      { [u.discordId]: { status: 200, body: { user, nick: null } } },
      { policy: { ...POLICY, requiredRoleIds: ['role-member'] } },
    );

    expect(await reverifyDueMembers(deps)).toMatchObject({ offboarded: 0, failures: 1 });
    expect(await userRow(u.id)).toMatchObject({
      status: 'active',
      verifyFailures: 1,
      lastVerifiedAt: null,
    });
    expect(await failureCounts(metrics)).toEqual({ unavailable: 1 });
  });

  it('stops the batch once Discord keeps rate-limiting after the retries', async () => {
    const a = await dueUser();
    const limited = await dueUser({ lastVerifiedAt: new Date(NOW.getTime() - 9 * HOUR) });
    const later = await dueUser({ lastVerifiedAt: new Date(NOW.getTime() - 8 * HOUR) });
    const tooMany: Reply = { status: 429, body: { retry_after: 2 } };
    const { deps, calls } = setup({
      [a.discordId]: member(a.discordId),
      [limited.discordId]: [tooMany, tooMany, tooMany],
      [later.discordId]: member(later.discordId),
    });

    expect(await reverifyDueMembers(deps)).toEqual({
      checked: 2,
      offboarded: 0,
      failures: 1,
      aborted: true,
    });
    // The bot's member-lookup bucket is shared by the whole guild: the next lookup would 429 too.
    expect(calls.map((c) => c.discordId)).not.toContain(later.discordId);
    expect(await userRow(later.id)).toMatchObject({ verifyFailures: 0 });
  });

  it("finishes the run when one user's database write fails, logging only the code (DB-3)", async () => {
    const broken = await dueUser({ name: 'Secret Name' });
    const fine = await dueUser({ lastVerifiedAt: new Date(NOW.getTime() - 9 * HOUR) });
    const flaky = await dueUser({ lastVerifiedAt: new Date(NOW.getTime() - 8 * HOUR) });
    const left = await dueUser({ lastVerifiedAt: new Date(NOW.getTime() - 7 * HOUR) });
    // Any update of the broken user's row fails; the message carries the bound nickname.
    await t.db.execute(
      sql.raw(`
        CREATE OR REPLACE FUNCTION test_fail_user_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.id = '${broken.id}' THEN RAISE EXCEPTION 'boom for %', NEW.nickname; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER test_fail_user_update BEFORE UPDATE ON users
          FOR EACH ROW EXECUTE FUNCTION test_fail_user_update();`),
    );
    try {
      const { deps, lines } = setup({
        [broken.discordId]: member(broken.discordId, { nick: 'Secret Nick' }),
        [fine.discordId]: member(fine.discordId),
        [flaky.discordId]: OUTAGE,
        [left.discordId]: NOT_MEMBER,
      });

      expect(await reverifyDueMembers(deps)).toEqual({
        checked: 4,
        offboarded: 1,
        failures: 1,
        aborted: false,
      });
      expect((await userRow(fine.id))?.lastVerifiedAt).toEqual(NOW);
      expect((await userRow(flaky.id))?.verifyFailures).toBe(1);
      expect((await userRow(left.id))?.status).toBe('grace');
      expect(errors(lines)).toEqual([
        expect.objectContaining({ userId: broken.id, pgCode: 'P0001' }),
      ]);
      expect(JSON.stringify(lines)).not.toMatch(/Secret|boom/);
    } finally {
      await t.db.execute(sql`DROP TRIGGER test_fail_user_update ON users`);
      await t.db.execute(sql`DROP FUNCTION test_fail_user_update()`);
    }
  });

  it('returns an empty result when nobody is due', async () => {
    const { deps, calls } = setup({});
    expect(await reverifyDueMembers(deps)).toEqual({
      checked: 0,
      offboarded: 0,
      failures: 0,
      aborted: false,
    });
    expect(calls).toHaveLength(0);
  });
});
