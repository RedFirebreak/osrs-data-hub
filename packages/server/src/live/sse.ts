/**
 * Server-Sent Events wire format of `GET /api/live/stream` (handoff §11). Every message is one
 * `event:` name plus one `data:` line of JSON; `event` messages also carry their `seq` as `id:`, which
 * the browser sends back as `Last-Event-ID` on reconnect (replayed by replayEvents).
 */

/** Message names on the live stream. */
export type SseEventName = 'event' | 'presence' | 'pairing' | 'device' | 'resync';

/** Server-Sent Events message; `data` is JSON-serialized. */
export interface SseMessage {
  event: SseEventName;
  /** Only event messages carry one (their seq). */
  id?: number;
  data: unknown;
}

/** Reconnect delay the browser is told to use (`retry:`). */
export const SSE_RETRY_MS = 5000;
/** How often the stream route writes SSE_HEARTBEAT, so proxies don't close an idle stream. */
export const SSE_HEARTBEAT_MS = 25_000;
/** A comment line: ignored by EventSource, but it keeps the connection busy. */
export const SSE_HEARTBEAT = ': ping\n\n';

/**
 * "id: …\nevent: …\ndata: <json>\n\n". The data is ONE line: JSON.stringify without indentation
 * escapes CR and LF inside strings, and SSE only treats CR/LF as line ends, so the payload can't end
 * the field early or inject another field. `id` is written only for a safe integer (a seq); undefined
 * data is sent as `null`.
 */
export function formatSse(msg: SseMessage): string {
  const json = JSON.stringify(msg.data ?? null) ?? 'null';
  const id = msg.id !== undefined && Number.isSafeInteger(msg.id) ? `id: ${msg.id}\n` : '';
  return `${id}event: ${msg.event}\ndata: ${json}\n\n`;
}

/** The first chunk of every stream: the reconnect hint plus a comment the client can see arrive. */
export function sseHello(): string {
  return `retry: ${SSE_RETRY_MS}\n: connected\n\n`;
}
