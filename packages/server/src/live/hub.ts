/**
 * In-memory fan-out of live notifications to the open SSE streams of this process (handoff §11, D-5).
 *
 * The web process holds one LISTEN connection (listener.ts) and one LiveHub; every open
 * `/api/live/stream` is a subscriber. For each notification the hub reads the rows ONCE, then applies
 * the one permission resolver (@hub/core resolveAccess, handoff §10) and the viewer's toast filter
 * per subscriber. Nothing is persisted: a stream that misses messages recovers through
 * `Last-Event-ID` (replayEvents) or a 'resync'.
 */
import {
  isOnline,
  resolveAccess,
  type AccountAccess,
  type Category,
  type ToastFilter,
  type Viewer,
} from '@hub/core';
import { getDb, pgErrorCode, safeDbErrorMessage, type Db } from '@hub/db';
import { loadAccountAccess } from '../accounts/access';
import { toFeedEvent, type EventRowLike, type FeedEvent } from '../feed';
import { getLogger, type Logger } from '../logger';
import { getMetrics, type HubMetrics } from '../metrics';
import type { EventsNotification, PairingNotification, StateNotification } from '../notify';
import {
  loadDeviceAccount,
  loadEventRows,
  loadLiveAccount,
  loadPresence,
  type DeviceAccountRow,
  type LiveAccount,
  type PresenceRow,
} from './load';
import {
  toEventMessage,
  type DeviceMessage,
  type PairingMessage,
  type PresenceMessage,
} from './messages';
import { formatSse } from './sse';

/** One open stream. */
export interface LiveSubscriber {
  /** Captured when the stream opened; a changed status or filter applies from the next stream. */
  viewer: Viewer;
  toast: ToastFilter;
  /**
   * Writes a chunk of SSE text. Must not block; throw when the stream is closed or too far behind:
   * the hub then drops the subscriber (and calls `close`).
   */
  send(chunk: string): void;
  /** Called once when the hub drops the subscriber after a failed send, so the route can end it. */
  close?(): void;
}

export interface LiveHubDeps {
  db: Db;
  logger: Logger;
  metrics: HubMetrics;
  now?: () => Date;
}

interface Entry {
  sub: LiveSubscriber;
  active: boolean;
}

export class LiveHub {
  private readonly entries = new Set<Entry>();
  private readonly db: Db;
  private readonly logger: Logger;
  private readonly metrics: HubMetrics;
  private readonly now: () => Date;
  /** Notifications are handled one at a time, in arrival order (see `serial`). */
  private tail: Promise<void> = Promise.resolve();

  constructor(deps: LiveHubDeps) {
    this.db = deps.db;
    this.logger = deps.logger;
    this.metrics = deps.metrics;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Adds a stream; returns its unsubscribe function (idempotent). Subscribing the same object twice
   * gives two independent subscriptions. Keeps the `hub_sse_connections` gauge equal to size().
   */
  subscribe(sub: LiveSubscriber): () => void {
    const entry: Entry = { sub, active: true };
    this.entries.add(entry);
    this.updateGauge();
    return () => this.remove(entry);
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * New events committed for an account: loads the rows (ascending seq), the account and its
   * AccountAccess once, then sends every subscriber that may read the account's `events` an 'event'
   * message per row, redacted for them (toFeedEvent), with `id: seq` and their toast flag. Never
   * throws: a failed read is logged and the notification dropped (clients recover by replay).
   */
  onEvents(n: EventsNotification): Promise<void> {
    return this.serial('events', () => this.handleEvents(n));
  }

  /**
   * An account's live state changed: sends a 'presence' message to every subscriber that may read
   * the account's `activity`. For the first data from a device (n.firstDataForDevice), also sends a
   * 'device' message to the device owner's streams, whatever their categories: it is their own
   * device, and the wizard waits for it. Never throws.
   */
  onState(n: StateNotification): Promise<void> {
    return this.serial('state', () => this.handleState(n));
  }

  /** Pairing progress: a 'pairing' message to the streams of the user who created the code only. */
  onPairing(n: PairingNotification): void {
    const data: PairingMessage =
      n.kind === 'consumed'
        ? { kind: 'consumed', codeId: n.codeId, deviceId: n.deviceId }
        : { kind: 'outdated_plugin', codeId: n.codeId, version: n.version };
    const chunk = formatSse({ event: 'pairing', data });
    for (const entry of this.snapshot()) {
      if (entry.sub.viewer.userId === n.userId) this.deliver(entry, chunk);
    }
  }

  /**
   * The LISTEN connection was (re-)established: notifications may have been missed while it was
   * down, so every stream gets 'resync' {} (the client refetches and replays).
   */
  onReconnect(): void {
    const chunk = formatSse({ event: 'resync', data: {} });
    for (const entry of this.snapshot()) this.deliver(entry, chunk);
  }

  private async handleEvents(n: EventsNotification): Promise<void> {
    if (this.entries.size === 0 || n.seqs.length === 0) return;
    const [rows, account, accessMap] = await Promise.all([
      loadEventRows(this.db, n.accountId, n.seqs),
      loadLiveAccount(this.db, n.accountId),
      loadAccountAccess(this.db, [n.accountId]),
    ]);
    const access = accessMap.get(n.accountId);
    if (rows.length === 0 || !account || !access) return;
    const now = this.now();
    // toFeedEvent depends only on the categories: build each variant once, not once per stream.
    const feedCache = new Map<string, FeedEvent[]>();
    for (const entry of this.snapshot()) {
      const resolved = resolveAccess(entry.sub.viewer, access);
      if (!resolved.categories.has('events')) continue;
      const feed = cachedFeed(feedCache, rows, account, resolved.categories);
      const chunk = feed
        .map((event) =>
          formatSse({
            event: 'event',
            id: event.seq,
            data: toEventMessage(event, entry.sub.toast, resolved, now),
          }),
        )
        .join('');
      this.deliver(entry, chunk);
    }
  }

  private async handleState(n: StateNotification): Promise<void> {
    if (this.entries.size === 0) return;
    const deviceId = n.firstDataForDevice === true ? n.deviceId : null;
    const [presence, accessMap, device] = await Promise.all([
      loadPresence(this.db, n.accountId),
      loadAccountAccess(this.db, [n.accountId]),
      deviceId ? loadDeviceAccount(this.db, deviceId, n.accountId) : null,
    ]);
    const access = accessMap.get(n.accountId);
    if (!presence || !access) return;
    this.sendPresence(presence, access);
    if (deviceId && device) this.sendDevice(deviceId, presence, device);
  }

  private sendPresence(row: PresenceRow, access: AccountAccess): void {
    const data: PresenceMessage = {
      account: accountRef(row),
      online: isOnline(row, this.now()),
      world: row.world,
      specialWorld: row.specialWorld,
      lastSeen: row.lastSeen.toISOString(),
    };
    const chunk = formatSse({ event: 'presence', data });
    for (const entry of this.snapshot()) {
      if (resolveAccess(entry.sub.viewer, access).categories.has('activity')) {
        this.deliver(entry, chunk);
      }
    }
  }

  private sendDevice(deviceId: string, account: LiveAccount, row: DeviceAccountRow): void {
    const data: DeviceMessage = {
      deviceId,
      account: accountRef(account),
      // owner_user_id is the source of truth; account_links.role mirrors it.
      role: row.ownerUserId === row.deviceUserId ? 'owner' : 'contributor',
      ownerName: row.ownerName,
    };
    const chunk = formatSse({ event: 'device', data });
    for (const entry of this.snapshot()) {
      if (entry.sub.viewer.userId === row.deviceUserId) this.deliver(entry, chunk);
    }
  }

  /**
   * Runs notification handlers one after another in arrival order: messages reach a stream in the
   * order Postgres delivered the notifications (so Last-Event-ID tracks the newest), and a burst of
   * notifications doesn't take every pooled connection at once (DB-5). Errors are logged, never thrown.
   */
  private serial(kind: 'events' | 'state', fn: () => Promise<void>): Promise<void> {
    const run = this.tail.then(fn).catch((err: unknown) => {
      // DB-3: log the code and the parameter-free message, never err.message.
      this.logger.error(
        { kind, pgCode: pgErrorCode(err), error: safeDbErrorMessage(err) },
        'live: notification dropped',
      );
    });
    this.tail = run;
    return run;
  }

  private deliver(entry: Entry, chunk: string): void {
    if (!entry.active) return;
    try {
      entry.sub.send(chunk);
    } catch {
      this.logger.warn({ userId: entry.sub.viewer.userId }, 'live: send failed, stream dropped');
      this.remove(entry);
      try {
        entry.sub.close?.();
      } catch {
        // The stream is being dropped anyway.
      }
    }
  }

  private remove(entry: Entry): void {
    if (!entry.active) return;
    entry.active = false;
    this.entries.delete(entry);
    this.updateGauge();
  }

  /** A copy, so a subscriber added or removed while sending doesn't change the current loop. */
  private snapshot(): Entry[] {
    return [...this.entries];
  }

  private updateGauge(): void {
    this.metrics.sseConnections.set(this.entries.size);
  }
}

function accountRef(a: LiveAccount): PresenceMessage['account'] {
  return { publicId: a.publicId, name: a.name, accountType: a.accountType };
}

function cachedFeed(
  cache: Map<string, FeedEvent[]>,
  rows: readonly EventRowLike[],
  account: LiveAccount,
  categories: ReadonlySet<Category>,
): FeedEvent[] {
  const key = [...categories].sort().join(',');
  let feed = cache.get(key);
  if (!feed) {
    const ref = { publicId: account.publicId, name: account.name };
    feed = rows.map((row) => toFeedEvent(row, ref, categories));
    cache.set(key, feed);
  }
  return feed;
}

const g = globalThis as unknown as { __hubLiveHub?: LiveHub };

/**
 * The process-wide hub, on globalThis: route handlers, RSC and instrumentation are separate module
 * instances in Next, and the stream route and the listener must share one hub (NEXT-3, D-37).
 */
export function getLiveHub(): LiveHub {
  g.__hubLiveHub ??= new LiveHub({ db: getDb().db, logger: getLogger(), metrics: getMetrics() });
  return g.__hubLiveHub;
}
