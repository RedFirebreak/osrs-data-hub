/**
 * Client IP behind `trustHops` reverse proxies: the X-Forwarded-For entry `trustHops` positions from
 * the right (1 = the last entry, appended by our proxy). With fewer entries than hops, the leftmost.
 * 0 hops or no header → null (the caller keys limits on "unknown"). Entries are trimmed and empty ones
 * ignored (like Express's proxy-addr); several X-Forwarded-For headers count as one list (Headers.get
 * joins them with ", "). An IPv6 "[::1]:123" / IPv4 "1.2.3.4:5" port suffix and IPv6 brackets are
 * removed, and IPv6 is lowercased. Entries that aren't an IPv4 or IPv6 address (e.g. "unknown") → null.
 */
export function clientIpFromHeaders(headers: Headers, trustHops: number): string | null {
  if (!(trustHops >= 1)) return null;
  const header = headers.get('x-forwarded-for');
  if (header === null) return null;
  const entries = header
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  const entry = entries[Math.max(0, entries.length - Math.floor(trustHops))];
  return entry === undefined ? null : normalizeIp(entry);
}

function normalizeIp(entry: string): string | null {
  if (entry.startsWith('[')) {
    const m = /^\[([^\]]+)\](?::[0-9]{1,5})?$/.exec(entry);
    return m?.[1] !== undefined && isIPv6(m[1]) ? m[1].toLowerCase() : null;
  }
  const colon = entry.indexOf(':');
  if (colon !== -1 && colon === entry.lastIndexOf(':')) {
    // Exactly one colon: only "IPv4:port" is valid (IPv6 always has at least two).
    const host = entry.slice(0, colon);
    return /^[0-9]{1,5}$/.test(entry.slice(colon + 1)) && isIPv4(host) ? host : null;
  }
  if (isIPv4(entry)) return entry;
  return isIPv6(entry) ? entry.toLowerCase() : null;
}

function isIPv4(s: string): boolean {
  const parts = s.split('.');
  return parts.length === 4 && parts.every((p) => /^(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/.test(p));
}

const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;

function isIPv6(s: string): boolean {
  let addr = s;
  const zone = addr.indexOf('%');
  if (zone !== -1) {
    if (!/^[0-9A-Za-z._~-]+$/.test(addr.slice(zone + 1))) return false;
    addr = addr.slice(0, zone);
  }
  if (addr.includes('.')) {
    // Embedded IPv4 ("::ffff:1.2.3.4") stands for the last two groups.
    const last = addr.lastIndexOf(':');
    if (last === -1 || !isIPv4(addr.slice(last + 1))) return false;
    addr = `${addr.slice(0, last + 1)}0:0`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return false;
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  if (halves.length === 2) {
    const all = [...groups(halves[0] ?? ''), ...groups(halves[1] ?? '')];
    return all.length <= 7 && all.every((g) => HEX_GROUP.test(g));
  }
  const all = addr.split(':');
  return all.length === 8 && all.every((g) => HEX_GROUP.test(g));
}
