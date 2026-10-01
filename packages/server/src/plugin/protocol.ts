/**
 * What the plugin's two endpoints share (pairing: POST /api/osrs-data/pair, ingest:
 * POST /api/osrs-data/events): the response shape, the Retry-After of a transient failure, and how the
 * version header is stored.
 */

/** Plugin endpoint response (route handlers turn it into a Response). */
export interface PluginResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

/**
 * Retry-After for transient database failures (D-19, D-30): ingest's plugin queues events meanwhile,
 * pairing's player presses Submit again.
 */
export const TRANSIENT_RETRY_AFTER_SECONDS = 30;

/** The version header is free text from the client: it is stored cut to this many characters. */
export const MAX_VERSION_TEXT = 32;

/**
 * X-Osrs-Exporter-Version as stored and shown (devices.plugin_version, raw_payloads.plugin_version,
 * pairing_codes.last_outdated_version): control characters removed (a text column rejects NUL, DB-1,
 * and the others have no place in a version), trimmed, at most MAX_VERSION_TEXT characters; null
 * when missing or blank.
 */
export function storedVersionText(header: string | null): string | null {
  if (header === null) return null;
  const text = header
    .replace(/\p{Cc}/gu, '')
    .trim()
    .slice(0, MAX_VERSION_TEXT);
  return text === '' ? null : text;
}
