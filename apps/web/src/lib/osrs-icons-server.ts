/**
 * The icon configuration for a page render (D-95): the base URL from OSRS_ICONS_URL, read on the
 * server at request time (never NEXT_PUBLIC_*: that is baked into the prebuilt image at build time,
 * NEXT-17), and the CDN's stack tables (`/data/stacks.json`), which pick the picture for a quantity
 * (a pile of coins). The (app) layout passes the result to IconConfigProvider.
 *
 * The stack tables never hold up or break a page: the fetch gives up after STACKS_TIMEOUT_MS, and any
 * failure means no tables (every item shows its base picture) for STACKS_RETRY_MS before the next try,
 * so an unreachable CDN costs one slow render per retry period rather than every render. A successful
 * response is cached for a day by Next's data cache, the lifetime the CDN's README asks for.
 */
import { getConfig } from '@hub/core';
import { getLogger } from '@hub/server';
import type { IconConfig, IconStacks } from './osrs-icons';

export const STACKS_TIMEOUT_MS = 1_500;
export const STACKS_RETRY_MS = 5 * 60_000;
const STACKS_REVALIDATE_S = 86_400;

interface StacksState {
  /** A failed fetch for this base: no retry before `retryAt`. */
  failed?: { base: string; retryAt: number };
  /** The fetch in progress for this base, shared by concurrent renders. */
  inflight?: { base: string; promise: Promise<IconStacks> };
}

// On globalThis: RSC and route handlers are separate module instances in Next (NEXT-3).
const g = globalThis as unknown as { __hubIconStacks?: StacksState };

function state(): StacksState {
  g.__hubIconStacks ??= {};
  return g.__hubIconStacks;
}

/** Test hook: forget failures and in-flight fetches. */
export function resetIconStacksForTests(): void {
  g.__hubIconStacks = undefined;
}

/** A parsed stacks.json, keeping only well-formed tables ([[breakpoint, id], …] of integers). */
export function parseStacks(json: unknown): IconStacks {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return {};
  const out: Record<string, (readonly [number, number])[]> = {};
  for (const [id, table] of Object.entries(json)) {
    if (!/^\d+$/.test(id) || !Array.isArray(table)) continue;
    const rows = table.filter(
      (row): row is [number, number] =>
        Array.isArray(row) &&
        row.length === 2 &&
        Number.isInteger(row[0]) &&
        Number.isInteger(row[1]),
    );
    if (rows.length > 0) out[id] = rows.map(([q, v]) => [q, v] as const);
  }
  return out;
}

async function fetchStacks(base: string, fetchImpl: typeof fetch): Promise<IconStacks> {
  const res = await fetchImpl(`${base}/data/stacks.json`, {
    signal: AbortSignal.timeout(STACKS_TIMEOUT_MS),
    next: { revalidate: STACKS_REVALIDATE_S },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseStacks(await res.json());
}

/** The stack tables for `base`, or {} when they can't be had right now (see the file comment). */
export async function loadIconStacks(
  base: string,
  { fetchImpl = fetch, now = Date.now() }: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<IconStacks> {
  const s = state();
  if (s.failed?.base === base && now < s.failed.retryAt) return {};
  if (s.inflight?.base === base) return s.inflight.promise;
  const promise = fetchStacks(base, fetchImpl)
    .then((stacks) => {
      if (s.failed?.base === base) s.failed = undefined;
      return stacks;
    })
    .catch((err: unknown) => {
      s.failed = { base, retryAt: now + STACKS_RETRY_MS };
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), base },
        'icon stack tables unavailable; items show their base picture',
      );
      return {};
    })
    .finally(() => {
      if (s.inflight?.promise === promise) s.inflight = undefined;
    });
  s.inflight = { base, promise };
  return promise;
}

/** The icon configuration for this render: icons off (base null) when OSRS_ICONS_URL is empty. */
export async function loadIconConfig(): Promise<IconConfig> {
  const base = getConfig().osrsIconsUrl;
  if (!base) return { base: null, stacks: {} };
  return { base, stacks: await loadIconStacks(base) };
}
