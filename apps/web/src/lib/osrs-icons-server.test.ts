import { parseConfig, setConfigForTests } from '@hub/core';
import { silentLogger } from '@hub/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STACKS_RETRY_MS,
  loadIconConfig,
  loadIconStacks,
  parseStacks,
  resetIconStacksForTests,
} from './osrs-icons-server';

const BASE = 'https://icons.example';
const STACKS = {
  995: [
    [2, 996],
    [10000, 1004],
  ],
};

function ok(body: unknown): typeof fetch {
  return vi.fn(() => Promise.resolve(Response.json(body))) as unknown as typeof fetch;
}

beforeEach(() => {
  resetIconStacksForTests();
  (globalThis as unknown as { __hubLogger?: unknown }).__hubLogger = silentLogger();
});
afterEach(() => {
  setConfigForTests(undefined);
  vi.unstubAllGlobals();
});

describe('parseStacks', () => {
  it('keeps well-formed tables and drops the rest', () => {
    expect(
      parseStacks({
        995: [
          [2, 996],
          [3, 'x'],
        ],
        abc: [[2, 3]],
        4151: 'nope',
        617: [],
      }),
    ).toEqual({ 995: [[2, 996]] });
    expect(parseStacks(null)).toEqual({});
    expect(parseStacks([1, 2])).toEqual({});
  });
});

describe('loadIconStacks', () => {
  it('fetches stacks.json from the base with a timeout and a day of caching', async () => {
    const fetchImpl = ok(STACKS);
    expect(await loadIconStacks(BASE, { fetchImpl })).toEqual(STACKS);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe(`${BASE}/data/stacks.json`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.next).toEqual({ revalidate: 86_400 });
  });

  it('shares one fetch between concurrent renders', async () => {
    const fetchImpl = ok(STACKS);
    const [a, b] = await Promise.all([
      loadIconStacks(BASE, { fetchImpl }),
      loadIconStacks(BASE, { fetchImpl }),
    ]);
    expect(a).toEqual(STACKS);
    expect(b).toEqual(STACKS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('answers {} on failure and waits before trying again', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('timeout'))) as unknown as typeof fetch;
    expect(await loadIconStacks(BASE, { fetchImpl: failing, now: 0 })).toEqual({});
    const notFound = vi.fn(() =>
      Promise.resolve(new Response('', { status: 404 })),
    ) as unknown as typeof fetch;
    expect(await loadIconStacks(BASE, { fetchImpl: notFound, now: 1_000 })).toEqual({});
    expect(notFound).not.toHaveBeenCalled();
    const fetchImpl = ok(STACKS);
    expect(await loadIconStacks(BASE, { fetchImpl, now: STACKS_RETRY_MS })).toEqual(STACKS);
    // A 404 counts as a failure too.
    resetIconStacksForTests();
    expect(await loadIconStacks(BASE, { fetchImpl: notFound, now: 0 })).toEqual({});
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});

describe('loadIconConfig', () => {
  it('turns icons off without fetching when OSRS_ICONS_URL is empty', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    setConfigForTests(parseConfig({ APP_URL: 'https://hub.example.com', OSRS_ICONS_URL: '' }));
    expect(await loadIconConfig()).toEqual({ base: null, stacks: {} });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads the base URL from the runtime configuration', async () => {
    vi.stubGlobal('fetch', ok(STACKS));
    setConfigForTests(
      parseConfig({ APP_URL: 'https://hub.example.com', OSRS_ICONS_URL: 'http://localhost:8765/' }),
    );
    expect(await loadIconConfig()).toEqual({ base: 'http://localhost:8765', stacks: STACKS });
  });
});
