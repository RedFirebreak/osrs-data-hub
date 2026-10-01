/**
 * The browser side of the live stream (handoff §11, ARCHITECTURE §10), without React: one
 * EventSource on `GET /api/live/stream`, reopened with a backoff when the server refuses it, plus the
 * polling fallback `GET /api/live/events?after=<seq>` every 10 s while the stream is not open.
 * LiveProvider owns one instance per signed-in page tree.
 *
 * - Every event is de-duplicated by id before `onMessage` sees it: a reconnect replays after
 *   Last-Event-ID while live messages keep flowing, and polling overlaps the stream.
 * - The cursor is the newest seq seen (SSE `id:` or the poll's `cursor`). A reopened stream carries it
 *   as `?lastEventId=` (the browser's own reconnects send the Last-Event-ID header), so nothing is
 *   lost across `reconnect()`.
 * - The first poll carries no cursor: it returns no events and the current cursor, so a page never
 *   toasts minutes-old events (the server's contract too). A hub without events answers cursor 0,
 *   which is a real cursor from then on (`after=0`, `lastEventId=0`), so its first events arrive.
 * - A 401 from the poll means the session is gone (signed out elsewhere, offboarded): the connection
 *   stops and calls `onUnauthorized`.
 */
import {
  LIVE_MESSAGE_TYPES,
  SeenIds,
  asEventMessage,
  parseLiveData,
  parseSeq,
  type LiveMessageMap,
  type LiveMessageType,
} from './live-state';
import type { LiveEventMessage } from '@hub/server';

/** The part of the browser's EventSource this class uses (tests pass a fake). */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void;
  close(): void;
}

/** EventSource.readyState values. */
export const EVENT_SOURCE_OPEN = 1;
export const EVENT_SOURCE_CLOSED = 2;

const LIVE_STREAM_URL = '/api/live/stream';
const LIVE_POLL_URL = '/api/live/events';
/** Handoff §11: poll every 10 s while the stream is down. */
const LIVE_POLL_INTERVAL_MS = 10_000;
/**
 * Delays before reopening a stream the browser gave up on (a non-200 answer such as 401, 503 or the
 * 429 for a user's sixth stream, D-80: EventSource can read neither the status nor Retry-After; plain
 * network errors are retried by the browser itself after the server's `retry: 5000`). Polling carries
 * the events meanwhile, so the last delay repeats: at most one attempt a minute.
 */
const LIVE_RECONNECT_DELAYS_MS: readonly number[] = [5_000, 10_000, 30_000, 60_000];

/**
 * - `connecting`: the stream is being opened for the first time (or after `reconnect()`);
 * - `open`: the stream is delivering messages;
 * - `polling`: the stream is down or retrying; the polling fallback delivers events meanwhile.
 */
export type LiveConnectionState = 'connecting' | 'open' | 'polling';

export interface LiveConnectionOptions {
  onState(state: LiveConnectionState): void;
  /** Every stream message; 'event' messages arrive de-duplicated (and also from the polling fallback). */
  onMessage<T extends LiveMessageType>(type: T, data: LiveMessageMap[T]): void;
  /** The poll got 401: the session is gone. The connection has stopped itself. */
  onUnauthorized?(): void;
  createEventSource?: (url: string) => EventSourceLike;
  fetchFn?: typeof fetch;
}

export class LiveConnection {
  private readonly opts: LiveConnectionOptions;
  private readonly createEventSource: (url: string) => EventSourceLike;
  private readonly fetchFn: typeof fetch;
  private readonly seen = new SeenIds(1000);

  private es: EventSourceLike | null = null;
  /** Newest seq seen; null until the stream or the first poll told us one. */
  private cursor: number | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private running = false;
  private pollInFlight = false;
  private state: LiveConnectionState | null = null;

  constructor(opts: LiveConnectionOptions) {
    this.opts = opts;
    this.createEventSource = opts.createEventSource ?? ((url) => new EventSource(url));
    // Bound: calling an unbound window.fetch throws "Illegal invocation" in browsers.
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  }

  /** Opens the stream and starts the polling timer (idempotent). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.openStream();
    this.pollTimer = setInterval(() => void this.pollIfDown(), LIVE_POLL_INTERVAL_MS);
  }

  /** Closes everything; the instance can be started again. */
  stop(): void {
    this.running = false;
    this.closeStream();
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.pollTimer = null;
    this.reconnectTimer = null;
  }

  /**
   * Closes the stream and opens a new one at once, replaying after the newest seq seen. The server
   * captures the viewer's toast filter when a stream opens, so the Settings page calls this after
   * saving a new filter.
   */
  reconnect(): void {
    if (!this.running) return;
    this.closeStream();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.attempt = 0;
    this.openStream();
  }

  /** The newest event seq seen (stream or poll), or null. */
  get lastSeq(): number | null {
    return this.cursor;
  }

  /** Whether the stream is open right now. */
  get isOpen(): boolean {
    return this.es !== null && this.es.readyState === EVENT_SOURCE_OPEN;
  }

  private setState(state: LiveConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onState(state);
  }

  private openStream(): void {
    // 0 is a real cursor (a hub without events yet), so it is sent too.
    const url =
      this.cursor !== null ? `${LIVE_STREAM_URL}?lastEventId=${this.cursor}` : LIVE_STREAM_URL;
    let es: EventSourceLike;
    try {
      es = this.createEventSource(url);
    } catch {
      this.setState('polling');
      this.scheduleReopen();
      return;
    }
    this.es = es;
    if (this.state !== 'polling') this.setState('connecting');
    es.onopen = () => {
      if (this.es !== es) return;
      this.attempt = 0;
      this.setState('open');
    };
    es.onerror = () => {
      if (this.es !== es) return;
      if (es.readyState === EVENT_SOURCE_CLOSED) {
        // The browser gave up (HTTP error such as 401/503): reopen ourselves, with a backoff.
        this.closeStream();
        this.scheduleReopen();
      }
      // Otherwise the browser is retrying on its own (`retry: 5000`); poll meanwhile.
      this.setState('polling');
    };
    for (const type of LIVE_MESSAGE_TYPES) {
      es.addEventListener(type, (ev) => {
        if (this.es === es) this.receive(type, ev.data, ev.lastEventId);
      });
    }
  }

  private closeStream(): void {
    const es = this.es;
    this.es = null;
    if (!es) return;
    es.onopen = null;
    es.onerror = null;
    es.close();
  }

  private scheduleReopen(): void {
    if (!this.running || this.reconnectTimer !== null) return;
    const delays = LIVE_RECONNECT_DELAYS_MS;
    const delay = delays[Math.min(this.attempt, delays.length - 1)] ?? LIVE_POLL_INTERVAL_MS;
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running && this.es === null) this.openStream();
    }, delay);
  }

  private receive(type: LiveMessageType, raw: string, lastEventId: string): void {
    // The seq counts even for a message we can't read: the browser's Last-Event-ID moves on too.
    const seq = type === 'event' ? parseSeq(lastEventId) : null;
    if (seq !== null) this.advance(seq);
    const data = parseLiveData(type, raw);
    if (data === null) return;
    if (type === 'event') {
      this.deliverEvent(data as LiveEventMessage);
      return;
    }
    this.opts.onMessage(type, data as LiveMessageMap[typeof type]);
  }

  private deliverEvent(msg: LiveEventMessage): void {
    this.advance(msg.event.seq);
    if (!this.seen.add(msg.event.id)) return;
    this.opts.onMessage('event', msg);
  }

  private advance(seq: number): void {
    if (Number.isSafeInteger(seq) && seq >= 0) this.cursor = Math.max(this.cursor ?? 0, seq);
  }

  /** One poll, when the stream isn't open and no poll is running. Exposed for tests. */
  async pollIfDown(): Promise<void> {
    if (!this.running || this.pollInFlight || this.isOpen) return;
    this.pollInFlight = true;
    try {
      await this.poll();
    } catch {
      // Network error: the next tick tries again.
    } finally {
      this.pollInFlight = false;
    }
  }

  private async poll(): Promise<void> {
    // Only a client without any cursor asks for one; `after=0` replays a new hub's first events.
    const after = this.cursor;
    const url = after === null ? LIVE_POLL_URL : `${LIVE_POLL_URL}?after=${after}`;
    const res = await this.fetchFn(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (!this.running) return;
    if (res.status === 401) {
      this.stop();
      this.opts.onUnauthorized?.();
      return;
    }
    if (!res.ok) return;
    const body = (await res.json()) as unknown;
    if (!this.running || typeof body !== 'object' || body === null) return;
    const { events, cursor } = body as { events?: unknown; cursor?: unknown };
    // Without a cursor the server answers with no events: this poll only learns where to start.
    if (after !== null && Array.isArray(events)) {
      for (const raw of events) {
        const msg = asEventMessage(raw);
        if (msg) this.deliverEvent(msg);
      }
    }
    if (typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor >= 0) {
      this.advance(cursor);
    }
  }
}
