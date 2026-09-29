import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_SOURCE_CLOSED,
  EVENT_SOURCE_OPEN,
  LiveConnection,
  type EventSourceLike,
  type LiveConnectionState,
} from './live-connection';
import type { LiveMessageMap, LiveMessageType } from './live-state';
import { feedEvent } from './test-fixtures';

class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((ev: MessageEvent<string>) => void)[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.readyState = EVENT_SOURCE_CLOSED;
    this.closed = true;
  }

  open(): void {
    this.readyState = EVENT_SOURCE_OPEN;
    this.onopen?.(new Event('open'));
  }

  /** An error; `gaveUp` = the browser closed it (HTTP error), else it retries on its own. */
  fail(gaveUp: boolean): void {
    this.readyState = gaveUp ? EVENT_SOURCE_CLOSED : 0;
    this.onerror?.(new Event('error'));
  }

  emit(type: string, data: unknown, id = ''): void {
    const ev = { data: typeof data === 'string' ? data : JSON.stringify(data), lastEventId: id };
    for (const l of this.listeners.get(type) ?? []) l(ev as MessageEvent<string>);
  }
}

interface Received {
  type: LiveMessageType;
  data: unknown;
}

let sources: FakeEventSource[];
let received: Received[];
let states: LiveConnectionState[];
let fetchFn: ReturnType<typeof vi.fn>;
let unauthorized: number;
let conn: LiveConnection;

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function latest(): FakeEventSource {
  const es = sources.at(-1);
  if (!es) throw new Error('no EventSource');
  return es;
}

function eventIds(): string[] {
  return received
    .filter((r) => r.type === 'event')
    .map((r) => (r.data as LiveMessageMap['event']).event.id);
}

beforeEach(() => {
  vi.useFakeTimers();
  sources = [];
  received = [];
  states = [];
  unauthorized = 0;
  fetchFn = vi.fn(async () => respond(200, { events: [], cursor: 0 }));
  conn = new LiveConnection({
    onState: (s) => states.push(s),
    onMessage: (type, data) => received.push({ type, data }),
    onUnauthorized: () => {
      unauthorized += 1;
    },
    createEventSource: (url) => {
      const es = new FakeEventSource(url);
      sources.push(es);
      return es;
    },
    fetchFn: fetchFn as unknown as typeof fetch,
  });
});

afterEach(() => {
  conn.stop();
  vi.useRealTimers();
});

describe('LiveConnection stream', () => {
  it('opens the stream without a cursor and reports connecting → open', () => {
    conn.start();
    expect(sources).toHaveLength(1);
    expect(latest().url).toBe('/api/live/stream');
    expect(states).toEqual(['connecting']);
    latest().open();
    expect(states).toEqual(['connecting', 'open']);
    expect(conn.isOpen).toBe(true);
  });

  it('delivers messages, de-duplicates events by id and tracks the newest seq', () => {
    conn.start();
    const es = latest();
    es.open();
    const a = feedEvent({ id: 'a', seq: 11 });
    es.emit('event', { event: a, toast: true }, '11');
    es.emit('event', { event: a, toast: true }, '11'); // replayed after a reconnect
    es.emit('event', { event: feedEvent({ id: 'b', seq: 12 }), toast: false }, '12');
    es.emit('event', '{"broken":', '13');
    es.emit('presence', {
      account: { publicId: 'p', name: 'P', accountType: null },
      online: true,
      world: 301,
      specialWorld: false,
      lastSeen: '2026-09-29T10:00:00.000Z',
      onlineForMs: 1000,
    });
    es.emit('pairing', { kind: 'consumed', codeId: 'c', deviceId: 'd' });
    expect(eventIds()).toEqual(['a', 'b']);
    expect(received.map((r) => r.type)).toEqual(['event', 'event', 'presence', 'pairing']);
    // The malformed message's id still counts: the stream did deliver it.
    expect(conn.lastSeq).toBe(13);
  });

  it('reconnect() reopens with ?lastEventId= and ignores the old source', () => {
    conn.start();
    const first = latest();
    first.open();
    first.emit('event', { event: feedEvent({ id: 'a', seq: 40 }), toast: true }, '40');
    conn.reconnect();
    expect(first.closed).toBe(true);
    expect(sources).toHaveLength(2);
    expect(latest().url).toBe('/api/live/stream?lastEventId=40');
    first.emit('event', { event: feedEvent({ id: 'late', seq: 41 }), toast: true }, '41');
    expect(eventIds()).toEqual(['a']);
  });

  it('reopens a stream the browser gave up on, with a growing backoff', async () => {
    conn.start();
    latest().fail(true);
    expect(states.at(-1)).toBe('polling');
    expect(sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources).toHaveLength(2);
    latest().fail(true);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(sources).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources).toHaveLength(3);
    // Success resets the backoff.
    latest().open();
    expect(states.at(-1)).toBe('open');
    latest().fail(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sources).toHaveLength(4);
  });

  it('a stream the hub keeps refusing (429, too many streams: D-80) is tried at most once a minute, while polling carries the events', async () => {
    // Every poll after the first brings a new event.
    let polls = 0;
    conn.stop();
    conn = new LiveConnection({
      onState: (s) => states.push(s),
      onMessage: (type, data) => received.push({ type, data }),
      createEventSource: (url) => {
        const es = new FakeEventSource(url);
        sources.push(es);
        return es;
      },
      fetchFn: async (input) => {
        polls += 1;
        const events = String(input).includes('after=')
          ? [{ event: feedEvent({ id: `e${polls}`, seq: 100 + polls }), toast: true }]
          : [];
        return respond(200, { events, cursor: 100 + polls });
      },
    });
    conn.start();
    // EventSource can't read the status or Retry-After: any non-200 answer closes it for good.
    const refuse = () => latest().fail(true);
    refuse();
    const opened: number[] = [];
    for (let minute = 0; minute < 10; minute++) {
      const before = sources.length;
      for (let s = 0; s < 60; s++) {
        await vi.advanceTimersByTimeAsync(1_000);
        if (latest().readyState !== EVENT_SOURCE_CLOSED) refuse();
      }
      opened.push(sources.length - before);
    }
    // 5 s, 10 s, 30 s, then every 60 s: never more than one attempt a minute once backed off.
    expect(opened.slice(0, 2).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(4);
    expect(opened.slice(2).every((n) => n <= 1)).toBe(true);
    expect(sources).toHaveLength(1 + opened.reduce((a, b) => a + b, 0));
    expect(states.at(-1)).toBe('polling');
    // Polling every 10 s delivered meanwhile (the first poll only learns the cursor).
    expect(polls).toBe(60);
    expect(eventIds()).toHaveLength(59);
  });

  it("leaves the browser's own retries alone but reports polling meanwhile", async () => {
    conn.start();
    latest().open();
    latest().fail(false);
    expect(states.at(-1)).toBe('polling');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sources).toHaveLength(1);
    latest().open();
    expect(states.at(-1)).toBe('open');
  });
});

describe('LiveConnection polling fallback', () => {
  it("doesn't poll while the stream is open", async () => {
    conn.start();
    latest().open();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('first learns the cursor without events, then polls after it and de-duplicates', async () => {
    fetchFn
      .mockResolvedValueOnce(
        // A first poll never carries events; if it did, they'd be minutes old: not delivered.
        respond(200, {
          events: [{ event: feedEvent({ id: 'old', seq: 90 }), toast: true }],
          cursor: 100,
        }),
      )
      .mockResolvedValueOnce(
        respond(200, {
          events: [
            { event: feedEvent({ id: 'n1', seq: 101 }), toast: true },
            { event: feedEvent({ id: 'n2', seq: 102 }), toast: false },
          ],
          cursor: 102,
        }),
      )
      .mockResolvedValueOnce(
        respond(200, {
          events: [{ event: feedEvent({ id: 'n2', seq: 102 }), toast: false }],
          cursor: 102,
        }),
      );
    conn.start();
    latest().fail(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchFn).toHaveBeenLastCalledWith(
      '/api/live/events',
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }),
    );
    expect(eventIds()).toEqual([]);
    expect(conn.lastSeq).toBe(100);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchFn).toHaveBeenLastCalledWith('/api/live/events?after=100', expect.anything());
    expect(eventIds()).toEqual(['n1', 'n2']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchFn).toHaveBeenLastCalledWith('/api/live/events?after=102', expect.anything());
    expect(eventIds()).toEqual(['n1', 'n2']);
  });

  it('on a hub without events, cursor 0 is kept and sent, so the first events still arrive', async () => {
    fetchFn.mockResolvedValueOnce(respond(200, { events: [], cursor: 0 })).mockResolvedValueOnce(
      respond(200, {
        events: [{ event: feedEvent({ id: 'first', seq: 1 }), toast: true }],
        cursor: 1,
      }),
    );
    conn.start();
    latest().fail(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchFn).toHaveBeenLastCalledWith('/api/live/events', expect.anything());
    expect(conn.lastSeq).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchFn).toHaveBeenLastCalledWith('/api/live/events?after=0', expect.anything());
    expect(eventIds()).toEqual(['first']);
  });

  it('reopens the stream with lastEventId=0 once a poll said the hub had no events', async () => {
    conn.start();
    latest().fail(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(conn.lastSeq).toBe(0);
    conn.reconnect();
    expect(latest().url).toBe('/api/live/stream?lastEventId=0');
  });

  it('continues after the newest seq the stream delivered', async () => {
    fetchFn.mockResolvedValue(respond(200, { events: [], cursor: 57 }));
    conn.start();
    latest().open();
    latest().emit('event', { event: feedEvent({ id: 'a', seq: 57 }), toast: true }, '57');
    latest().fail(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchFn).toHaveBeenCalledWith('/api/live/events?after=57', expect.anything());
    // The reopened stream replays after the same seq.
    expect(sources.at(-1)?.url).toBe('/api/live/stream?lastEventId=57');
  });

  it('stops everything on 401 and reports it', async () => {
    fetchFn.mockResolvedValue(respond(401, { error: { code: 'unauthorized' } }));
    conn.start();
    latest().fail(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(unauthorized).toBe(1);
    const count = sources.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sources).toHaveLength(count);
  });

  it('ignores failed and malformed polls and tries again next tick', async () => {
    fetchFn
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(respond(503, { error: { code: 'unavailable' } }))
      .mockResolvedValueOnce(new Response('not json', { status: 200 }))
      .mockResolvedValueOnce(respond(200, { events: [], cursor: 5 }));
    conn.start();
    latest().fail(false);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(conn.lastSeq).toBe(5);
  });
});
