export type Version = readonly [major: number, minor: number, patch: number];

/** Largest accepted version component; anything bigger is garbage, not a version. */
const MAX_COMPONENT = 1_000_000;

/**
 * Parses X-Osrs-Exporter-Version numerically: "1.5" → [1,5,0], "1.5.1" → [1,5,1],
 * "1.6-SNAPSHOT" → [1,6,0], " 1.5 " → [1,5,0]. Missing parts are 0; anything after the numeric
 * prefix is ignored. Returns null for null/undefined/empty or when it doesn't start with a number
 * (e.g. "abc", "v1.5" → null). Components above 1e6 are rejected (null).
 */
export function parsePluginVersion(header: string | null | undefined): Version | null {
  if (header === null || header === undefined) return null;
  const m = /^([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?/.exec(header.trim());
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].map((p) => (p === undefined ? 0 : Number(p)));
  if (parts.some((p) => p > MAX_COMPONENT)) return null;
  const [major = 0, minor = 0, patch = 0] = parts;
  return [major, minor, patch];
}

export function compareVersions(a: Version, b: Version): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * True when `header` parses and is >= `minimum` (itself a version string like "1.5"). Throws when
 * `minimum` doesn't parse: that is a configuration error (config validates MIN_PLUGIN_VERSION), and
 * silently refusing or accepting every plugin would hide it.
 */
export function meetsMinimumVersion(header: string | null | undefined, minimum: string): boolean {
  const min = parsePluginVersion(minimum);
  if (!min) throw new Error(`invalid minimum plugin version: ${JSON.stringify(minimum)}`);
  const version = parsePluginVersion(header);
  return version !== null && compareVersions(version, min) >= 0;
}

/** "1.5.0" style string for display and storage. */
export function formatVersion(v: Version): string {
  return `${v[0]}.${v[1]}.${v[2]}`;
}
