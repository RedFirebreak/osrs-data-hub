/**
 * Pure helpers behind the live stream client (LiveProvider, LiveConnection): message parsing, event
 * de-duplication, presence bookkeeping with client-side expiry, and the "online now" merge. No React
 * and no browser APIs, so everything here is unit-tested in the node test project.
 *
 * Only `import type` from @hub/server: this module is bundled for the browser, and a value import
 * (or `import { type … }` under verbatimModuleSyntax) would pull the server package in (NEXT-12).
 */
import type {
  DeviceMessage,
  FeedEvent,
  LiveEventMessage,
  OnlineEntry,
  PairingMessage,
  PresenceMessage,
} from '@hub/server';

/** Payload of each message name on `GET /api/live/stream` (see @hub/server live/messages.ts). */
export interface LiveMessageMap {
  event: LiveEventMessage;
  presence: PresenceMessage;
  pairing: PairingMessage;
  device: DeviceMessage;
  resync: Record<string, never>;
}

export type LiveMessageType = keyof LiveMessageMap;

/** Every message name the stream sends (the SSE `event:` field). */
export const LIVE_MESSAGE_TYPES: readonly LiveMessageType[] = [
  'event',
  'presence',
  'pairing',
  'device',
  'resync',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFeedEvent(value: unknown): value is FeedEvent {
  if (!isRecord(value)) return false;
  const account = value.account;
  return (
    typeof value.id === 'string' &&
    Number.isSafeInteger(value.seq) &&
    typeof value.type === 'string' &&
    typeof value.line === 'string' &&
    typeof value.icon === 'string' &&
    typeof value.occurredAt === 'string' &&
    isRecord(account) &&
    typeof account.publicId === 'string' &&
    typeof account.name === 'string'
  );
}

/** A LiveEventMessage as the stream and the polling fallback send it, or null. */
export function asEventMessage(value: unknown): LiveEventMessage | null {
  if (!isRecord(value) || !isFeedEvent(value.event)) return null;
  return { event: value.event, toast: value.toast === true };
}

function asPresenceMessage(value: unknown): PresenceMessage | null {
  if (!isRecord(value) || !isRecord(value.account)) return null;
  const { account } = value;
  if (typeof account.publicId !== 'string' || typeof account.name !== 'string') return null;
  if (typeof value.online !== 'boolean' || typeof value.lastSeen !== 'string') return null;
  const onlineForMs =
    typeof value.onlineForMs === 'number' && Number.isFinite(value.onlineForMs)
      ? Math.max(0, value.onlineForMs)
      : 0;
  return {
    account: {
      publicId: account.publicId,
      name: account.name,
      accountType: typeof account.accountType === 'number' ? account.accountType : null,
    },
    online: value.online,
    world: typeof value.world === 'number' ? value.world : null,
    specialWorld: value.specialWorld === true,
    lastSeen: value.lastSeen,
    onlineForMs,
  };
}

/**
 * Parses the `data` of one stream message (JSON) and checks the fields the UI relies on; null for
 * anything malformed, so one bad message never breaks the client. 'pairing' and 'device' are passed
 * through as objects: the wizard reads them and checks their own fields.
 */
export function parseLiveData<T extends LiveMessageType>(
  type: T,
  raw: string,
): LiveMessageMap[T] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  switch (type) {
    case 'event':
      return asEventMessage(value) as LiveMessageMap[T] | null;
    case 'presence':
      return asPresenceMessage(value) as LiveMessageMap[T] | null;
    case 'resync':
      return {} as LiveMessageMap[T];
    default:
      return (isRecord(value) ? value : null) as LiveMessageMap[T] | null;
  }
}

/** A positive safe integer from an SSE `id:` / cursor value, else null. */
export function parseSeq(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d{1,16}$/.test(value.trim()) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Remembers the last `max` event ids. The stream can deliver an event twice (a reconnect replays
 * after Last-Event-ID while live messages keep flowing, and the polling fallback overlaps the stream),
 * so every event is checked here before it is shown or toasted.
 */
export class SeenIds {
  private readonly ids = new Set<string>();

  constructor(private readonly max = 1000) {}

  /** True when `id` is new (and records it); false for a duplicate. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > this.max) {
      // Sets iterate in insertion order: drop the oldest.
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return true;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }
}

/** Presence of one account as the client tracks it. */
export interface LivePresence {
  account: PresenceMessage['account'];
  /** False once `onlineUntil` has passed (LiveProvider flips it with a timer). */
  online: boolean;
  world: number | null;
  specialWorld: boolean;
  /** ISO-8601 UTC, from the server. */
  lastSeen: string;
  /**
   * Client clock (ms) at which `online` turns false without another message: receive time +
   * onlineForMs. Null when offline. Nothing is sent when presence times out (a crash just stops the
   * payloads), so the client has to expire it itself.
   */
  onlineUntil: number | null;
}

/** The LivePresence for a message received at `receivedAt` (client clock, ms). */
export function presenceFromMessage(msg: PresenceMessage, receivedAt: number): LivePresence {
  const online = msg.online && msg.onlineForMs > 0;
  return {
    account: msg.account,
    online,
    world: msg.world,
    specialWorld: msg.specialWorld,
    lastSeen: msg.lastSeen,
    onlineUntil: online ? receivedAt + msg.onlineForMs : null,
  };
}

/** A copy of `map` with the message applied. */
export function applyPresence(
  map: ReadonlyMap<string, LivePresence>,
  msg: PresenceMessage,
  receivedAt: number,
): ReadonlyMap<string, LivePresence> {
  const next = new Map(map);
  next.set(msg.account.publicId, presenceFromMessage(msg, receivedAt));
  return next;
}

/**
 * Marks the account offline when its `onlineUntil` has passed at `now`. Returns `map` itself when
 * nothing changed (a newer message moved `onlineUntil` on), so a React state setter can bail out.
 */
export function expirePresence(
  map: ReadonlyMap<string, LivePresence>,
  publicId: string,
  now: number,
): ReadonlyMap<string, LivePresence> {
  const entry = map.get(publicId);
  if (!entry || !entry.online || entry.onlineUntil === null || entry.onlineUntil > now) return map;
  const next = new Map(map);
  next.set(publicId, { ...entry, online: false, onlineUntil: null });
  return next;
}

function timeOf(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * Whether the live entry is at least as new as a server-rendered state last seen at `serverLastSeen`
 * (the server list was rendered before or after the message; the newer one wins).
 */
export function liveIsNewer(
  live: LivePresence,
  serverLastSeen: string | null | undefined,
): boolean {
  return timeOf(live.lastSeen) >= timeOf(serverLastSeen);
}

/**
 * The "online now" list: the server-rendered entries (getDashboard's onlineNow), updated by the live
 * presence the client received since. For each account the newer of the two wins (by lastSeen); a
 * live entry that is offline (or expired) removes the account, a live entry that is online adds it.
 * Sorted by name, like the server list.
 */
export function mergeOnlineNow(
  initial: readonly OnlineEntry[],
  live: ReadonlyMap<string, LivePresence>,
): OnlineEntry[] {
  const rows = new Map<string, OnlineEntry>();
  for (const entry of initial) {
    const l = live.get(entry.publicId);
    if (l && liveIsNewer(l, entry.lastSeen)) continue;
    rows.set(entry.publicId, entry);
  }
  for (const [publicId, l] of live) {
    if (rows.has(publicId) || !l.online) continue;
    rows.set(publicId, {
      publicId,
      name: l.account.name,
      accountType: l.account.accountType,
      world: l.world,
      specialWorld: l.specialWorld,
      lastSeen: l.lastSeen,
    });
  }
  return [...rows.values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
  );
}

/** How old an event must be before its toast shows the time ("3 min ago"). */
export const TOAST_SHOW_AGE_AFTER_MS = 60_000;

/** True when a toast should show the event's relative time (it is a minute old or older). */
export function toastShowsAge(occurredAt: string, now: number): boolean {
  const t = Date.parse(occurredAt);
  return Number.isFinite(t) && now - t >= TOAST_SHOW_AGE_AFTER_MS;
}
