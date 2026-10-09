import { describe, expect, it } from 'vitest';
import { lookupHiscores, type FetchFn } from './client';
import { HiscorePause } from './pause';

const URL_ = 'http://hiscores.test/m=hiscore_oldschool/index_lite.json?player=a';
const reply =
  (status: number, body = '', headers: Record<string, string> = {}): FetchFn =>
  async () =>
    new Response(body, { status, headers });

describe('lookupHiscores', () => {
  it('reads a 200 with the hiscores, and sends a user agent and a timeout', async () => {
    let init: RequestInit | undefined;
    const fetchFn: FetchFn = async (_url, i) => {
      init = i;
      return new Response(
        JSON.stringify({ skills: [{ name: 'Overall', rank: 1, level: 3, xp: 4 }], activities: [] }),
      );
    };
    expect(await lookupHiscores(URL_, { fetchFn })).toEqual({
      kind: 'ok',
      hiscores: { skills: [{ name: 'Overall', rank: 1, level: 3, xp: 4 }], activities: [] },
    });
    expect(new Headers(init?.headers).get('user-agent')).toBe('osrs-data-hub (hiscores sync)');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('tells a 404 from a push-back', async () => {
    expect(await lookupHiscores(URL_, { fetchFn: reply(404) })).toEqual({ kind: 'not_found' });
    for (const status of [403, 429, 500, 503, 400]) {
      expect(await lookupHiscores(URL_, { fetchFn: reply(status) })).toEqual({
        kind: 'throttled',
        status,
        retryAfterMs: null,
      });
    }
    expect(
      await lookupHiscores(URL_, { fetchFn: reply(429, '', { 'retry-after': '120' }) }),
    ).toEqual({ kind: 'throttled', status: 429, retryAfterMs: 120_000 });
  });

  it('counts a 200 that is not the hiscores as a push-back, and no answer as an error', async () => {
    expect(await lookupHiscores(URL_, { fetchFn: reply(200, '<html>') })).toEqual({
      kind: 'throttled',
      status: 200,
      retryAfterMs: null,
    });
    const failing: FetchFn = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await lookupHiscores(URL_, { fetchFn: failing })).toEqual({ kind: 'error' });
  });
});

describe('HiscorePause', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  const plus = (ms: number) => new Date(now.getTime() + ms);

  it('pauses a minute, doubles up to an hour, honours a longer Retry-After, and resets', () => {
    const pause = new HiscorePause();
    expect(pause.pausedUntil(now)).toBeNull();
    expect(pause.trip(now, null)).toEqual(plus(60_000));
    expect(pause.pausedUntil(plus(59_999))).toEqual(plus(60_000));
    expect(pause.pausedUntil(plus(60_000))).toBeNull();
    expect(pause.trip(now, null)).toEqual(plus(120_000));
    expect(pause.trip(now, 600_000)).toEqual(plus(600_000));
    for (let i = 0; i < 10; i++) pause.trip(now, null);
    expect(pause.trip(now, null)).toEqual(plus(3_600_000));
    expect(pause.trip(now, 10 * 3_600_000)).toEqual(plus(3_600_000));
    pause.reset();
    expect(pause.trip(now, null)).toEqual(plus(60_000));
  });
});
