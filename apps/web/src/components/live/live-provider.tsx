'use client';
/**
 * LiveProvider: the one live connection of a signed-in page tree (mounted by app/(app)/layout.tsx),
 * shared by toasts, the dashboard's "Online now" strip, account pages and the pairing wizard.
 *
 * It runs a LiveConnection (live-connection.ts): EventSource on /api/live/stream with reconnects, the
 * 10 s polling fallback on /api/live/events while the stream is down, and de-duplication of events.
 * On top of that it:
 * - shows a toast for every event message with `toast: true` (the server already applied the
 *   permission check and the viewer's toast filter; handoff §11);
 * - keeps a presence map from 'presence' messages and expires "online" client-side after the
 *   message's `onlineForMs` (nothing is sent when a client crashes or presence times out);
 * - on 'resync' (the server's LISTEN connection was re-established, or a replay failed) refreshes the
 *   server components and — at most once a minute — reopens the stream to replay what was missed;
 * - on a 401 from the polling fallback (signed out elsewhere, offboarded) refreshes, so the layout's
 *   requireUser() sends the browser to /login.
 *
 * Reading it:
 *   const { connected, state, lastEvent, presence, subscribe, reconnect } = useLive();
 *   useLiveSubscription('pairing', (msg) => { … });   // any message type; handler may change freely
 *   const p = useLivePresence(publicId);              // LivePresence | undefined
 * Outside a LiveProvider every hook returns an idle value (nothing connected, subscribe is a no-op),
 * so shared components can use them on public pages too.
 */
import type { FeedEvent, LiveEventMessage, PresenceMessage } from '@hub/server';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react';
import { showEventToast } from './event-toast';
import { LiveConnection, type LiveConnectionState } from './live-connection';
import {
  applyPresence,
  expirePresence,
  type LiveMessageMap,
  type LiveMessageType,
  type LivePresence,
} from './live-state';

export type { LiveConnectionState } from './live-connection';
export type { LiveMessageMap, LiveMessageType, LivePresence } from './live-state';

export type LiveHandler<T extends LiveMessageType> = (data: LiveMessageMap[T]) => void;

/** Subscribes `handler` to one message type; returns the unsubscribe function. */
export type LiveSubscribe = <T extends LiveMessageType>(
  type: T,
  handler: LiveHandler<T>,
) => () => void;

interface LiveControls {
  subscribe: LiveSubscribe;
  /** Reopens the stream now (replaying after the newest seq seen), e.g. after the toast filter changed. */
  reconnect(): void;
}

interface LiveStatus {
  /** 'offline' only outside a LiveProvider. */
  state: LiveConnectionState | 'offline';
  /** The newest event received (toasted or not), or null. */
  lastEvent: FeedEvent | null;
}

export interface LiveContextValue extends LiveControls, LiveStatus {
  /** The stream is open (messages arrive at once; otherwise the 10 s polling fallback runs). */
  connected: boolean;
  /** Presence by account public id, from 'presence' messages since the page loaded. */
  presence: ReadonlyMap<string, LivePresence>;
}

const EMPTY_PRESENCE: ReadonlyMap<string, LivePresence> = new Map();
const IDLE_CONTROLS: LiveControls = { subscribe: () => () => {}, reconnect: () => {} };
const IDLE_STATUS: LiveStatus = { state: 'offline', lastEvent: null };

// Three contexts, so a component that only needs presence doesn't re-render for every event.
const ControlsContext = createContext<LiveControls>(IDLE_CONTROLS);
const StatusContext = createContext<LiveStatus>(IDLE_STATUS);
const PresenceContext = createContext<ReadonlyMap<string, LivePresence>>(EMPTY_PRESENCE);

/** How often a 'resync' may reopen the stream (a failing replay also sends 'resync'). */
const RESYNC_RECONNECT_MIN_INTERVAL_MS = 60_000;
/** Margin after `onlineForMs` before marking an account offline. */
const EXPIRY_MARGIN_MS = 100;

export interface LiveProviderProps {
  children: React.ReactNode;
  /** Show toasts for events flagged `toast` (default true). */
  toasts?: boolean;
}

export function LiveProvider({ children, toasts = true }: LiveProviderProps) {
  const router = useRouter();
  const [state, setState] = useState<LiveConnectionState>('connecting');
  const [lastEvent, setLastEvent] = useState<FeedEvent | null>(null);
  const [presence, setPresence] = useState<ReadonlyMap<string, LivePresence>>(EMPTY_PRESENCE);
  const handlers = useRef(new Map<LiveMessageType, Set<(data: unknown) => void>>());
  const connection = useRef<LiveConnection | null>(null);
  const expiryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const lastResyncReconnect = useRef(0);

  const scheduleExpiry = useCallback((publicId: string, onlineForMs: number) => {
    const timers = expiryTimers.current;
    const existing = timers.get(publicId);
    if (existing !== undefined) clearTimeout(existing);
    timers.delete(publicId);
    if (onlineForMs <= 0) return;
    timers.set(
      publicId,
      setTimeout(() => {
        timers.delete(publicId);
        setPresence((map) => expirePresence(map, publicId, Date.now()));
      }, onlineForMs + EXPIRY_MARGIN_MS),
    );
  }, []);

  const onMessage = useEffectEvent((type: LiveMessageType, data: unknown) => {
    switch (type) {
      case 'event': {
        const msg = data as LiveEventMessage;
        setLastEvent(msg.event);
        if (msg.toast && toasts) showEventToast(msg.event);
        break;
      }
      case 'presence': {
        const msg = data as PresenceMessage;
        const receivedAt = Date.now();
        setPresence((map) => applyPresence(map, msg, receivedAt));
        scheduleExpiry(msg.account.publicId, msg.online ? msg.onlineForMs : 0);
        break;
      }
      case 'resync': {
        router.refresh();
        const now = Date.now();
        if (now - lastResyncReconnect.current >= RESYNC_RECONNECT_MIN_INTERVAL_MS) {
          lastResyncReconnect.current = now;
          connection.current?.reconnect();
        }
        break;
      }
      default:
        break;
    }
    for (const handler of handlers.current.get(type) ?? []) {
      try {
        handler(data);
      } catch (err) {
        console.error(`live: a '${type}' subscriber failed`, err);
      }
    }
  });

  const onUnauthorized = useEffectEvent(() => {
    // The layout's requireUser() redirects to /login once the session is gone.
    router.refresh();
  });

  useEffect(() => {
    const conn = new LiveConnection({
      onState: (s) => setState(s),
      onMessage: (type, data) => onMessage(type, data),
      onUnauthorized: () => onUnauthorized(),
    });
    connection.current = conn;
    conn.start();
    const timers = expiryTimers.current;
    return () => {
      conn.stop();
      connection.current = null;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const subscribe = useCallback<LiveSubscribe>((type, handler) => {
    let set = handlers.current.get(type);
    if (!set) {
      set = new Set();
      handlers.current.set(type, set);
    }
    const entry = handler as (data: unknown) => void;
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  }, []);

  const reconnect = useCallback(() => connection.current?.reconnect(), []);

  const controls = useMemo<LiveControls>(() => ({ subscribe, reconnect }), [subscribe, reconnect]);
  const status = useMemo<LiveStatus>(() => ({ state, lastEvent }), [state, lastEvent]);

  return (
    <ControlsContext value={controls}>
      <StatusContext value={status}>
        <PresenceContext value={presence}>{children}</PresenceContext>
      </StatusContext>
    </ControlsContext>
  );
}

/** Everything at once (re-renders on every live change; prefer the narrower hooks below). */
export function useLive(): LiveContextValue {
  const controls = useContext(ControlsContext);
  const status = useContext(StatusContext);
  const presence = useContext(PresenceContext);
  return { ...controls, ...status, connected: status.state === 'open', presence };
}

/** subscribe + reconnect only (stable; never re-renders). */
export function useLiveControls(): LiveControls {
  return useContext(ControlsContext);
}

/** Connection state and the newest event. */
export function useLiveStatus(): LiveStatus & { connected: boolean } {
  const status = useContext(StatusContext);
  return { ...status, connected: status.state === 'open' };
}

/** The whole presence map (by public id). */
export function useLivePresenceMap(): ReadonlyMap<string, LivePresence> {
  return useContext(PresenceContext);
}

/** Live presence of one account, or undefined when no message arrived for it yet. */
export function useLivePresence(publicId: string): LivePresence | undefined {
  return useContext(PresenceContext).get(publicId);
}

/**
 * Calls `handler` for every message of `type` while the component is mounted. The handler always
 * sees current props and state (it doesn't need to be memoized).
 */
export function useLiveSubscription<T extends LiveMessageType>(
  type: T,
  handler: LiveHandler<T>,
): void {
  const { subscribe } = useContext(ControlsContext);
  const onData = useEffectEvent((data: LiveMessageMap[T]) => handler(data));
  useEffect(() => subscribe(type, (data) => onData(data)), [subscribe, type]);
}
