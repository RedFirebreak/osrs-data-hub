/**
 * The web process's one LISTEN connection (D-5): a dedicated pg.Client (LISTEN can't use a pooled
 * connection, which goes back to the pool after each query) that forwards the notifications of
 * hub_events, hub_state and hub_pairing to the LiveHub. Ingest and pairing call pg_notify inside
 * their transactions, so a notification arrives only after its data committed (D-32).
 */
import { safeDbErrorMessage, pgErrorCode } from '@hub/db';
import pg from 'pg';
import { z } from 'zod';
import { getLogger, type Logger } from '../logger';
import {
  CHANNELS,
  type EventsNotification,
  type PairingNotification,
  type StateNotification,
} from '../notify';
import { getLiveHub, type LiveHub } from './hub';

/** What the listener forwards to: a LiveHub, or a fake in tests. */
export type LiveSink = Pick<LiveHub, 'onEvents' | 'onState' | 'onPairing' | 'onReconnect'>;

export interface LiveListener {
  /** Ends the connection and stops reconnecting. */
  stop(): Promise<void>;
  /** True while LISTEN is active. */
  connected(): boolean;
}

export interface LiveListenerOptions {
  connectionString: string;
  hub: LiveSink;
  logger: Logger;
}

/** Shown in pg_stat_activity, so operators (and tests) can find the connection. */
export const LIVE_LISTENER_APPLICATION_NAME = 'hub-live-listener';
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/**
 * The backoff starts over only after a connection stayed up this long: every successful LISTEN
 * broadcasts 'resync' (every client refetches), so a connection lost right after it came back must
 * not be retried, and resynced, every second.
 */
const STABLE_CONNECTION_MS = 60_000;
/** A silently dead TCP connection would never emit an error; a periodic query finds it. */
const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;

/** 1 s, 2 s, 4 s, … capped at 30 s, for the n-th consecutive failure (0-based). */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_INITIAL_MS * 2 ** Math.min(attempt, 16));
}

/**
 * Starts listening (asynchronously; `connected()` turns true once LISTEN succeeded). On an error or
 * the end of the connection it reconnects with backoff (reconnectDelayMs; it starts over at 1 s only
 * once a connection stayed up for STABLE_CONNECTION_MS), and after every successful
 * LISTEN it calls hub.onReconnect(): notifications sent while nobody listened are lost, so open
 * streams must resync. That includes the first LISTEN, when a stream may already have opened (a
 * no-op for a hub without subscribers). Malformed notification payloads are logged and ignored.
 */
export function startLiveListener(opts: LiveListenerOptions): LiveListener {
  const listener = new Listener(opts);
  listener.start();
  return listener;
}

class Listener implements LiveListener {
  private client: pg.Client | null = null;
  private listening = false;
  private stopped = false;
  private attempt = 0;
  /** When the current connection's LISTEN succeeded (performance.now()); null while down. */
  private listeningSince: number | null = null;
  private everListened = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: LiveListenerOptions) {}

  start(): void {
    void this.connect();
  }

  connected(): boolean {
    return this.listening;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    const client = this.client;
    this.client = null;
    this.listening = false;
    if (client) await client.end().catch(() => {});
  }

  private async connect(): Promise<void> {
    this.retryTimer = null;
    if (this.stopped) return;
    const client = new pg.Client({
      connectionString: this.opts.connectionString,
      application_name: LIVE_LISTENER_APPLICATION_NAME,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      keepAlive: true,
    });
    this.client = client;
    // Without an 'error' listener, a dropped connection would crash the process.
    client.on('error', (err) => this.fail(client, err));
    client.on('end', () => this.fail(client, new Error('Connection terminated')));
    client.on('notification', (msg) => {
      if (client === this.client) this.dispatch(msg.channel, msg.payload);
    });
    try {
      await client.connect();
      await client.query(
        `LISTEN ${CHANNELS.events}; LISTEN ${CHANNELS.state}; LISTEN ${CHANNELS.pairing}`,
      );
    } catch (err) {
      this.fail(client, err);
      return;
    }
    if (client !== this.client) return; // stopped (or failed) meanwhile; fail() ended it
    this.listening = true;
    this.listeningSince = performance.now();
    const reconnected = this.everListened;
    this.everListened = true;
    this.pingTimer = setInterval(() => void this.ping(client), PING_INTERVAL_MS);
    this.pingTimer.unref();
    this.opts.logger.info({ reconnected }, 'live: listening');
    this.safely('onReconnect', () => this.opts.hub.onReconnect());
  }

  /** Handles the first failure of `client` (error, end, failed connect or ping); later ones are ignored. */
  private fail(client: pg.Client, err: unknown): void {
    if (client !== this.client) return;
    this.client = null;
    this.listening = false;
    this.clearTimers();
    client.end().catch(() => {});
    if (this.stopped) return;
    if (
      this.listeningSince !== null &&
      performance.now() - this.listeningSince >= STABLE_CONNECTION_MS
    ) {
      this.attempt = 0;
    }
    this.listeningSince = null;
    const delayMs = reconnectDelayMs(this.attempt++);
    // DB-3: the code and the parameter-free message only.
    this.opts.logger.warn(
      { pgCode: pgErrorCode(err), error: safeDbErrorMessage(err), attempt: this.attempt, delayMs },
      'live: LISTEN connection lost, reconnecting',
    );
    this.retryTimer = setTimeout(() => void this.connect(), delayMs);
    this.retryTimer.unref();
  }

  private async ping(client: pg.Client): Promise<void> {
    const timeout = setTimeout(
      () => this.fail(client, new Error('ping timed out')),
      PING_TIMEOUT_MS,
    );
    timeout.unref();
    try {
      await client.query('SELECT 1');
    } catch (err) {
      this.fail(client, err);
    } finally {
      clearTimeout(timeout);
    }
  }

  private dispatch(channel: string, payload: string | undefined): void {
    const n = parseLiveNotification(channel, payload);
    if (!n) {
      this.opts.logger.warn({ channel }, 'live: malformed notification ignored');
      return;
    }
    const { hub } = this.opts;
    switch (n.channel) {
      case 'events':
        void hub.onEvents(n.payload).catch((err: unknown) => this.logHubError('onEvents', err));
        return;
      case 'state':
        void hub.onState(n.payload).catch((err: unknown) => this.logHubError('onState', err));
        return;
      case 'pairing':
        this.safely('onPairing', () => hub.onPairing(n.payload));
        return;
    }
  }

  private safely(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.logHubError(what, err);
    }
  }

  private logHubError(what: string, err: unknown): void {
    this.opts.logger.error(
      { what, pgCode: pgErrorCode(err), error: safeDbErrorMessage(err) },
      'live: hub failed',
    );
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
  }
}

const EventsSchema = z.object({
  accountId: z.number().int().positive(),
  seqs: z.array(z.number().int().positive()).min(1),
});

const StateSchema = z.object({
  accountId: z.number().int().positive(),
  deviceId: z.guid().nullable().default(null),
  firstDataForDevice: z.boolean().optional(),
});

const PairingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('consumed'),
    userId: z.string().min(1),
    codeId: z.guid(),
    deviceId: z.guid(),
  }),
  z.object({
    kind: z.literal('outdated_plugin'),
    userId: z.string().min(1),
    codeId: z.guid(),
    version: z.string().nullable(),
  }),
]);

/** A notification the hub understands, tagged by channel. */
export type LiveNotification =
  | { channel: 'events'; payload: EventsNotification }
  | { channel: 'state'; payload: StateNotification }
  | { channel: 'pairing'; payload: PairingNotification };

/**
 * Parses a notification defensively: null for an unknown channel, a missing payload, invalid JSON or a
 * shape that doesn't match notify.ts (anyone with database access can NOTIFY these channels).
 */
export function parseLiveNotification(
  channel: string,
  payload: string | undefined,
): LiveNotification | null {
  if (!payload) return null;
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  switch (channel) {
    case CHANNELS.events: {
      const r = EventsSchema.safeParse(json);
      return r.success ? { channel: 'events', payload: r.data } : null;
    }
    case CHANNELS.state: {
      const r = StateSchema.safeParse(json);
      return r.success ? { channel: 'state', payload: r.data } : null;
    }
    case CHANNELS.pairing: {
      const r = PairingSchema.safeParse(json);
      return r.success ? { channel: 'pairing', payload: r.data } : null;
    }
    default:
      return null;
  }
}

const g = globalThis as unknown as { __hubLiveListener?: LiveListener };

/**
 * The process's listener, started once (globalThis, NEXT-3/D-37) from DATABASE_URL and forwarding to
 * getLiveHub(). Called by Next's instrumentation at boot and lazily by the stream route. Throws when
 * DATABASE_URL is not set; a database that is down is not an error (it keeps reconnecting).
 */
export function ensureLiveListener(): LiveListener {
  if (!g.__hubLiveListener) {
    // From the environment, as getDb() reads it (not getConfig()): the LISTEN connection and the
    // pool then always name the same database, and instrumentation checks this variable before us.
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    g.__hubLiveListener = startLiveListener({
      connectionString,
      hub: getLiveHub(),
      logger: getLogger(),
    });
  }
  return g.__hubLiveListener;
}
