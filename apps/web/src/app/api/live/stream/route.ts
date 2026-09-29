/**
 * GET /api/live/stream — the live stream (Server-Sent Events) behind toasts, "online now" and the
 * pairing wizard (handoff §11, ARCHITECTURE §10). Session auth; 401 JSON when signed out.
 *
 * The stream subscribes to the process's LiveHub (@hub/server), which applies the permission resolver
 * and the viewer's toast filter per message and drops streams of users who are no longer active. On
 * top of that, every heartbeat (25 s) re-checks the Better Auth session and ends the stream once it is
 * gone (sign-out everywhere, offboarding): the browser's reconnect then gets 401 and stops.
 *
 * A reconnect carrying `Last-Event-ID` (or `?lastEventId=`) first replays the events of the last
 * 5 minutes after that seq; a first connection never replays (it would toast old events). Live
 * messages that arrive during the replay are held back and sent after it, so seqs stay ascending.
 * A replay is at most REPLAY_DEFAULT_LIMIT events; one cut off there ends with 'resync', so the client
 * refetches instead of taking the live events that follow for "caught up".
 *
 * At most LIVE_MAX_STREAMS_PER_USER streams per user in this process (D-80): the next one answers
 * 429 `rate_limited` with an integer Retry-After (PLUGIN-5 style), counted in
 * hub_live_streams_refused_total, and is never subscribed. The
 * browser's EventSource gives up on any non-200 answer; LiveConnection then polls and reopens with its
 * backoff. A slot frees whenever a stream ends (cleanup below unsubscribes it; the hub drops streams
 * whose sends fail or whose user is no longer active).
 */
import { getDb } from '@hub/db';
import {
  LIVE_MAX_STREAMS_PER_USER,
  LIVE_REPLAY_MAX_AGE_MS,
  LIVE_STREAMS_RETRY_AFTER_SECONDS,
  REPLAY_DEFAULT_LIMIT,
  SSE_HEARTBEAT,
  SSE_HEARTBEAT_MS,
  ensureLiveListener,
  formatSse,
  getLiveHub,
  getLogger,
  getMetrics,
  getUserSettings,
  replayEvents,
  sseHello,
} from '@hub/server';
import { ApiError, handleApi } from '@/lib/http';
import { getApiUser, requireApiUser } from '@/lib/session';

const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  // no-transform: keeps compression middleware from buffering the stream.
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  // nginx: don't buffer this response (handoff §11).
  'x-accel-buffering': 'no',
};

/** Bytes queued for a client that doesn't read before the stream is dropped (it reconnects + replays). */
const MAX_QUEUED_BYTES = 1024 * 1024;
/** Live messages held back while the replay runs, before the stream is dropped instead. */
const MAX_HELD_MESSAGES = 1000;

export async function GET(request: Request): Promise<Response> {
  return handleApi(async () => {
    const { user, viewer } = await requireApiUser(request);
    startListener();
    const db = getDb().db;
    const { toast } = await getUserSettings(db, user.id);
    const lastEventId = parseLastEventId(request);
    // Only the cookie is needed to re-check the session on each heartbeat.
    const sessionHeaders = new Headers();
    const cookie = request.headers.get('cookie');
    if (cookie !== null) sessionHeaders.set('cookie', cookie);
    const log = getLogger();
    const encoder = new TextEncoder();

    // No await between this check and the subscribe in start() (ReadableStream runs start() inside
    // its constructor), so two requests can't both take a user's last slot.
    const hub = getLiveHub();
    const open = hub.streamsOf(user.id);
    if (open >= LIVE_MAX_STREAMS_PER_USER) {
      log.info({ userId: user.id, open }, 'live: stream refused, too many open for this user');
      getMetrics().liveStreamsRefused.inc();
      throw new ApiError(
        429,
        'rate_limited',
        `At most ${LIVE_MAX_STREAMS_PER_USER} live connections per person: close a tab, or wait.`,
        { 'Retry-After': String(LIVE_STREAMS_RETRY_AFTER_SECONDS) },
      );
    }

    let cleanup = (): void => {};
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          let closed = false;
          let checking = false;
          /** A heartbeat came while a session check was running: check once more after it. */
          let recheck = false;
          /** Live chunks held back while the replay runs; null once live messages flow directly. */
          let held: string[] | null = lastEventId === null ? null : [];
          let unsubscribe = (): void => {};

          /** Enqueues SSE text; throws when closed or when the client stopped reading. */
          const write = (chunk: string): void => {
            if (closed) throw new Error('stream closed');
            if ((controller.desiredSize ?? 0) <= 0) throw new Error('client too far behind');
            controller.enqueue(encoder.encode(chunk));
          };

          const beat = async (): Promise<void> => {
            if (closed) return;
            try {
              write(SSE_HEARTBEAT);
            } catch {
              cleanup();
              return;
            }
            if (checking) {
              recheck = true;
              return;
            }
            checking = true;
            try {
              do {
                recheck = false;
                try {
                  const still = await getApiUser(sessionHeaders, { disableRefresh: true });
                  if (!still) return cleanup();
                } catch {
                  // The database is unavailable: keep the stream, the next heartbeat checks again.
                  log.warn('live: session re-check failed; keeping the stream');
                }
              } while (recheck && !closed);
            } finally {
              checking = false;
            }
          };

          const heartbeat = setInterval(() => void beat(), SSE_HEARTBEAT_MS);

          // Idempotent: request.signal's abort and the stream's cancel both fire on disconnect.
          cleanup = () => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            unsubscribe();
            held = null;
            try {
              controller.close();
            } catch {
              // Already cancelled by the client.
            }
          };

          const replay = async (afterSeq: number): Promise<void> => {
            let chunks: string[];
            try {
              const messages = await replayEvents(db, viewer, {
                afterSeq,
                maxAgeMs: LIVE_REPLAY_MAX_AGE_MS,
                limit: REPLAY_DEFAULT_LIMIT,
                now: new Date(),
                toast,
              });
              chunks = messages.map((m) => formatSse({ event: 'event', id: m.event.seq, data: m }));
              // Cut off: more events followed that this replay didn't send.
              if (messages.length >= REPLAY_DEFAULT_LIMIT) {
                chunks.push(formatSse({ event: 'resync', data: {} }));
              }
            } catch {
              // A failed read: tell the client to refetch instead of silently missing events.
              log.warn('live: replay failed; sending resync');
              chunks = [formatSse({ event: 'resync', data: {} })];
            }
            if (closed) return;
            const pending = held ?? [];
            held = null;
            try {
              for (const chunk of [...chunks, ...pending]) write(chunk);
            } catch {
              cleanup();
            }
          };

          write(sseHello());
          unsubscribe = hub.subscribe({
            viewer,
            toast,
            send(chunk) {
              if (held === null) return write(chunk);
              if (closed) throw new Error('stream closed');
              if (held.length >= MAX_HELD_MESSAGES) throw new Error('client too far behind');
              held.push(chunk);
            },
            close: () => cleanup(),
          });
          if (lastEventId !== null) void replay(lastEventId);
        },
        cancel() {
          cleanup();
        },
      },
      { highWaterMark: MAX_QUEUED_BYTES, size: (chunk) => chunk.byteLength },
    );

    if (request.signal.aborted) cleanup();
    else request.signal.addEventListener('abort', () => cleanup(), { once: true });
    return new Response(stream, { headers: SSE_HEADERS });
  });
}

/**
 * The seq to replay after: the `Last-Event-ID` header the browser sends on reconnect, or
 * `?lastEventId=` (a client that reopens the stream itself). A non-negative integer counts (0 is the
 * cursor of a hub that had no events yet); anything else (absent, garbage) means "no replay".
 */
function parseLastEventId(request: Request): number | null {
  const raw =
    request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('lastEventId');
  const value = raw?.trim() ?? '';
  if (!/^\d{1,16}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** The LISTEN connection, normally started by instrumentation; started here if it wasn't. */
function startListener(): void {
  try {
    ensureLiveListener();
  } catch {
    getLogger().error('live: the LISTEN connection could not be started (DATABASE_URL unset?)');
  }
}
