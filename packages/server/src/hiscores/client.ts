/**
 * One lookup on the official hiscores (D-105). Jagex publishes no limit and no terms for
 * `index_lite.json`, so anything that isn't a clean answer counts as being throttled and pauses every
 * lookup (./pause): the hub never retries an account in a loop.
 */
import { parseHiscores, type Hiscores } from '@hub/core';

export type FetchFn = typeof fetch;

/**
 * - `ok`: the player's rows;
 * - `not_found`: 404, the name isn't on that table (renamed, never ranked, or not that mode);
 * - `throttled`: a 429, 403 or 5xx, another status, or a 200 whose body isn't the hiscores (a
 *   Cloudflare challenge page), with the Retry-After when one was sent;
 * - `error`: no answer (network failure, timeout).
 */
export type HiscoreLookup =
  | { kind: 'ok'; hiscores: Hiscores }
  | { kind: 'not_found' }
  | { kind: 'throttled'; status: number; retryAfterMs: number | null }
  | { kind: 'error' };

const USER_AGENT = 'osrs-data-hub (hiscores sync)';
const DEFAULT_TIMEOUT_MS = 10_000;

export async function lookupHiscores(
  url: string,
  opts: { fetchFn?: FetchFn; timeoutMs?: number } = {},
): Promise<HiscoreLookup> {
  const fetchFn = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'error' };
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return { kind: 'not_found' };
  }
  if (res.status === 200) {
    const hiscores = parseHiscores(await res.json().catch(() => null));
    if (hiscores) return { kind: 'ok', hiscores };
    return { kind: 'throttled', status: 200, retryAfterMs: null };
  }
  await res.body?.cancel().catch(() => {});
  return { kind: 'throttled', status: res.status, retryAfterMs: retryAfterMs(res.headers) };
}

/** Retry-After in seconds as ms; null when missing or not a number of seconds. */
function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get('retry-after')?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  return Number(raw) * 1000;
}
