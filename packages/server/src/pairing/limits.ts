/**
 * Rate limits on the unauthenticated POST /api/osrs-data/pair (handoff §6.2.7, lesson §3.6.5). The code
 * space is only 100k, so guessing is throttled three ways: per client, globally, and a lockout after
 * repeated invalid codes. In memory in the single web process (D-5); the caller keeps one PairLimits
 * on globalThis (D-37).
 */
import { FailureLockout, WindowLimiter, type Clock } from '@hub/core';

export interface PairLimits {
  perIp: WindowLimiter;
  global: WindowLimiter;
  lockout: FailureLockout;
}

const MINUTE_MS = 60_000;

/**
 * 10 attempts per client per 10 minutes, 60 per minute over all clients, and 20 invalid codes from
 * one client within an hour lock it out for 15 minutes. `clock` is for tests.
 */
export function createPairLimits(opts: { clock?: Clock } = {}): PairLimits {
  const { clock } = opts;
  return {
    perIp: new WindowLimiter({ limit: 10, windowMs: 10 * MINUTE_MS, clock }),
    global: new WindowLimiter({ limit: 60, windowMs: MINUTE_MS, clock }),
    lockout: new FailureLockout({
      maxFailures: 20,
      windowMs: 60 * MINUTE_MS,
      lockMs: 15 * MINUTE_MS,
      clock,
    }),
  };
}

/**
 * The key the per-client limiter and the lockout count under. IPv4 is keyed by the full address. IPv6
 * is keyed by its /64 prefix ("2001:db8:1:2::/64"): one client usually holds a whole /64 and could
 * otherwise rotate addresses inside it to reset its limits. An IPv4-mapped IPv6 address
 * ("::ffff:1.2.3.4", as dual-stack sockets report IPv4 clients) is keyed as the IPv4 address, or every
 * IPv4 client would share the prefix "0:0:0:0::/64". null or empty → 'unknown' (all clients without a
 * known address share one key). A string that isn't an address is used as given (lowercased).
 */
export function pairRateKey(ip: string | null | undefined): string {
  const value = ip?.trim().toLowerCase() ?? '';
  if (value === '') return 'unknown';
  if (!value.includes(':')) return value;
  const groups = parseIPv6(value);
  if (!groups) return value;
  if (isV4Mapped(groups)) return dottedQuad(groups[6] ?? 0, groups[7] ?? 0);
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

const HEX_GROUP = /^[0-9a-f]{1,4}$/;

/** The eight 16-bit groups of an IPv6 address (zone id ignored), or null when it isn't one. */
function parseIPv6(input: string): number[] | null {
  let addr = input;
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  let tail: number[] = [];
  if (addr.includes('.')) {
    // Embedded IPv4 ("::ffff:1.2.3.4") stands for the last two groups.
    const last = addr.lastIndexOf(':');
    const v4 = parseIPv4(addr.slice(last + 1));
    if (last === -1 || !v4) return null;
    tail = [v4[0] * 256 + v4[1], v4[2] * 256 + v4[3]];
    addr = addr.slice(0, last + 1);
    if (!addr.endsWith('::')) addr = addr.slice(0, -1);
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const split = (part: string | undefined) => (part ? part.split(':') : []);
  const head = split(halves[0]);
  const rest = split(halves[1]);
  const wanted = 8 - tail.length;
  let parts: string[];
  if (halves.length === 1) {
    if (head.length !== wanted) return null;
    parts = head;
  } else {
    const missing = wanted - head.length - rest.length;
    if (missing < 1) return null;
    parts = [...head, ...Array<string>(missing).fill('0'), ...rest];
  }
  if (!parts.every((p) => HEX_GROUP.test(p))) return null;
  return [...parts.map((p) => Number.parseInt(p, 16)), ...tail];
}

function parseIPv4(s: string): [number, number, number, number] | null {
  const parts = s.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^[0-9]{1,3}$/.test(p) && Number(p) <= 255)) {
    return null;
  }
  const [a = 0, b = 0, c = 0, d = 0] = parts.map(Number);
  return [a, b, c, d];
}

/** ::ffff:0:0/96 */
function isV4Mapped(groups: readonly number[]): boolean {
  return groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
}

function dottedQuad(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}
