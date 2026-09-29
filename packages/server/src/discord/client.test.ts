import { describe, expect, it } from 'vitest';
import {
  DISCORD_API,
  fetchCurrentUser,
  fetchGuildMemberAsBot,
  fetchOwnGuildMember,
  type FetchFn,
} from './client';

type Reply =
  { status: number; body?: unknown; raw?: string; headers?: Record<string, string> } | 'network';

/** A fake fetch answering from a queue of replies, recording every request. */
function fakeFetch(...replies: Reply[]) {
  const requests: { url: string; headers: Headers; signal: AbortSignal | null | undefined }[] = [];
  const fetchFn: FetchFn = async (input, init) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      signal: init?.signal,
    });
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected request');
    if (reply === 'network') throw new TypeError('fetch failed');
    const text = reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
    return new Response(text, { status: reply.status, headers: reply.headers });
  };
  return { fetchFn, requests };
}

function recordSleeps() {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) };
}

const MEMBER = {
  user: { id: '222', username: 'zezima', global_name: 'Zezima', avatar: null },
  nick: 'Zez',
  roles: ['r1', 'r2'],
  joined_at: '2020-01-01T00:00:00Z',
};

const bot = (fetchFn: FetchFn, extra: Parameters<typeof fetchGuildMemberAsBot>[3] = {}) =>
  fetchGuildMemberAsBot('bot-token', '111', '222', { fetchFn, ...extra });

describe('fetchGuildMemberAsBot', () => {
  it('returns the member on 200, calling the bot route with the bot token', async () => {
    const { fetchFn, requests } = fakeFetch({ status: 200, body: MEMBER });
    expect(await bot(fetchFn)).toEqual({ kind: 'member', member: MEMBER });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${DISCORD_API}/guilds/111/members/222`);
    expect(requests[0]?.headers.get('authorization')).toBe('Bot bot-token');
    expect(requests[0]?.headers.get('user-agent')).toContain('osrs-data-hub');
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('encodes the path parameters', async () => {
    const { fetchFn, requests } = fakeFetch({ status: 200, body: MEMBER });
    await fetchGuildMemberAsBot('t', '1/2', '3?x', { fetchFn });
    expect(requests[0]?.url).toBe(`${DISCORD_API}/guilds/1%2F2/members/3%3Fx`);
  });

  it('accepts a member without roles when Discord sends an empty list', async () => {
    const { fetchFn } = fakeFetch({ status: 200, body: { nick: null, roles: [] } });
    expect(await bot(fetchFn)).toEqual({ kind: 'member', member: { nick: null, roles: [] } });
  });

  it('treats a 200 without a member object as unavailable, never as membership', async () => {
    // A missing or malformed roles list is not "no roles": that would read as a lost role (D-34).
    for (const reply of [
      { raw: '{"user":' },
      { raw: 'null' },
      { raw: '[]' },
      { raw: '' },
      { raw: '{"nick":null}' },
      { raw: '{"roles":"r1"}' },
      { raw: '{"roles":[1]}' },
    ]) {
      const { fetchFn } = fakeFetch({ status: 200, ...reply });
      expect(await bot(fetchFn)).toEqual({ kind: 'error', status: 200, reason: 'unavailable' });
    }
  });

  it('answers not_member only for 404 with code 10007 (Unknown Member)', async () => {
    const { fetchFn } = fakeFetch({
      status: 404,
      body: { message: 'Unknown Member', code: 10007 },
    });
    expect(await bot(fetchFn)).toEqual({ kind: 'not_member' });
  });

  it('treats 404 Unknown Guild (10004) as a config error, not a departure (DISCORD-1)', async () => {
    const { fetchFn } = fakeFetch({ status: 404, body: { message: 'Unknown Guild', code: 10004 } });
    expect(await bot(fetchFn)).toEqual({
      kind: 'error',
      status: 404,
      code: 10004,
      reason: 'config',
    });
  });

  it('treats a 404 without a code as a config error', async () => {
    const { fetchFn } = fakeFetch({ status: 404, raw: '<html>not found</html>' });
    expect(await bot(fetchFn)).toEqual({
      kind: 'error',
      status: 404,
      code: undefined,
      reason: 'config',
    });
  });

  it('maps 401 and 403 to auth errors', async () => {
    const { fetchFn } = fakeFetch(
      { status: 401, body: { message: '401: Unauthorized', code: 0 } },
      { status: 403, body: { message: 'Missing Access', code: 50001 } },
    );
    expect(await bot(fetchFn)).toEqual({ kind: 'error', status: 401, code: 0, reason: 'auth' });
    expect(await bot(fetchFn)).toEqual({ kind: 'error', status: 403, code: 50001, reason: 'auth' });
  });

  it('maps other statuses and network failures to unavailable', async () => {
    const { fetchFn } = fakeFetch({ status: 500 }, { status: 502, raw: 'bad gateway' }, 'network');
    expect(await bot(fetchFn)).toEqual({
      kind: 'error',
      status: 500,
      code: undefined,
      reason: 'unavailable',
    });
    expect(await bot(fetchFn)).toMatchObject({ kind: 'error', status: 502, reason: 'unavailable' });
    expect(await bot(fetchFn)).toEqual({ kind: 'error', status: 0, reason: 'unavailable' });
  });

  it('sleeps for retry_after on 429 and retries', async () => {
    const { fetchFn, requests } = fakeFetch(
      {
        status: 429,
        body: { message: 'You are being rate limited.', retry_after: 1.234, global: false },
      },
      { status: 200, body: MEMBER },
    );
    const { sleeps, sleep } = recordSleeps();
    expect(await bot(fetchFn, { sleep })).toEqual({ kind: 'member', member: MEMBER });
    expect(sleeps).toEqual([1234]);
    expect(requests).toHaveLength(2);
  });

  it('falls back to the Retry-After header, and clamps the wait to 250 ms … 60 s', async () => {
    const { fetchFn } = fakeFetch(
      { status: 429, raw: '', headers: { 'retry-after': '3' } },
      { status: 429, body: { retry_after: 0.01 } },
      { status: 429, body: { retry_after: 3600 } },
      { status: 200, body: MEMBER },
    );
    const { sleeps, sleep } = recordSleeps();
    expect(await bot(fetchFn, { sleep, maxRetries: 3 })).toMatchObject({ kind: 'member' });
    expect(sleeps).toEqual([3000, 250, 60_000]);
  });

  it('gives up after maxRetries rate-limited answers', async () => {
    const limited = { status: 429, body: { retry_after: 1 } };
    const { fetchFn, requests } = fakeFetch(limited, limited, limited);
    const { sleeps, sleep } = recordSleeps();
    expect(await bot(fetchFn, { sleep })).toEqual({
      kind: 'error',
      status: 429,
      code: undefined,
      reason: 'rate_limited',
    });
    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([1000, 1000]);

    const once = fakeFetch(limited);
    const none = recordSleeps();
    expect(await bot(once.fetchFn, { sleep: none.sleep, maxRetries: 0 })).toMatchObject({
      reason: 'rate_limited',
    });
    expect(none.sleeps).toEqual([]);
  });

  it('passes a caller signal through', async () => {
    const { fetchFn, requests } = fakeFetch({ status: 200, body: MEMBER });
    const controller = new AbortController();
    await bot(fetchFn, { signal: controller.signal });
    expect(requests[0]?.signal).toBe(controller.signal);
  });
});

describe('fetchOwnGuildMember', () => {
  it("calls the user route with the user's token", async () => {
    const { fetchFn, requests } = fakeFetch({ status: 200, body: MEMBER });
    expect(await fetchOwnGuildMember('user-token', '111', { fetchFn })).toEqual({
      kind: 'member',
      member: MEMBER,
    });
    expect(requests[0]?.url).toBe(`${DISCORD_API}/users/@me/guilds/111/member`);
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer user-token');
  });

  it('treats any 404 on the user route as not a member', async () => {
    const { fetchFn } = fakeFetch(
      { status: 404, body: { message: 'Unknown Guild', code: 10004 } },
      { status: 404 },
    );
    expect(await fetchOwnGuildMember('t', '111', { fetchFn })).toEqual({ kind: 'not_member' });
    expect(await fetchOwnGuildMember('t', '111', { fetchFn })).toEqual({ kind: 'not_member' });
  });

  it('fails with auth on a rejected token', async () => {
    const { fetchFn } = fakeFetch({ status: 401, body: { code: 0 } });
    expect(await fetchOwnGuildMember('t', '111', { fetchFn })).toMatchObject({
      kind: 'error',
      reason: 'auth',
    });
  });
});

describe('fetchCurrentUser', () => {
  it('returns the user on 200 and null otherwise', async () => {
    const user = { id: '222', username: 'zezima' };
    const { fetchFn, requests } = fakeFetch(
      { status: 200, body: user },
      { status: 401 },
      'network',
    );
    expect(await fetchCurrentUser('tok', fetchFn)).toEqual(user);
    expect(requests[0]?.url).toBe(`${DISCORD_API}/users/@me`);
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer tok');
    expect(await fetchCurrentUser('tok', fetchFn)).toBeNull();
    expect(await fetchCurrentUser('tok', fetchFn)).toBeNull();
  });

  it('returns null for a 200 that is not a user object', async () => {
    const { fetchFn } = fakeFetch(
      { status: 200, raw: '{}' },
      { status: 200, raw: 'null' },
      { status: 200, raw: '{"id":222,"username":"zezima"}' },
      { status: 200, raw: '<html>' },
    );
    for (let i = 0; i < 4; i++) expect(await fetchCurrentUser('tok', fetchFn)).toBeNull();
  });
});
