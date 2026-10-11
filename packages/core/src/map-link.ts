/**
 * The link to the guild's live map (D-115): an admin turns it on and gives the map's address on
 * Admin → Settings, and every signed-in page then shows "Map" in the top bar. The map is its own
 * site (ha-osrs-map) with its own sign-in; the hub only links to it, and tells the map nothing.
 */

export interface MapLink {
  /** Whether the top bar shows the link. Only with an address. */
  enabled: boolean;
  /** The map's address (http or https), or null when none is set. Kept while the link is off. */
  url: string | null;
}

export const DEFAULT_MAP_LINK: MapLink = { enabled: false, url: null };

/** Longest accepted address, as browsers and proxies reliably pass on. */
export const MAX_MAP_URL_LENGTH = 2048;

/**
 * The address `text` as it is stored (trimmed and normalised by the URL parser), or null when it
 * isn't an absolute http or https address of at most MAX_MAP_URL_LENGTH characters. Anything else
 * (javascript:, data:, a bare host) never reaches a link.
 */
export function parseMapUrl(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.length > MAX_MAP_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname === '' || url.username !== '' || url.password !== '') return null;
  return url.href.length > MAX_MAP_URL_LENGTH ? null : url.href;
}

/** Where the top bar's "Map" goes, or null when the link is off or its address unusable. */
export function mapLinkHref(link: MapLink): string | null {
  if (!link.enabled || link.url === null) return null;
  return parseMapUrl(link.url);
}
