'use client';
/**
 * A shared, coarse clock for relative times ("3 min ago") that keeps them current without every
 * component running its own timer: one interval (30 s) for the whole page, started by the first
 * subscriber and stopped with the last.
 *
 * Hydration-safe: during server rendering and hydration useNow returns `serverNow` (the time the
 * server rendered with, passed down as a prop), so the HTML the client hydrates matches; right after
 * hydration it switches to the browser's clock.
 */
import { useSyncExternalStore } from 'react';

/** How often relative times are refreshed. */
export const NOW_TICK_MS = 30_000;

let current = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    // React re-reads the snapshot after subscribing, so a stale value is replaced at once.
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      for (const l of listeners) l();
    }, NOW_TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  if (current === 0) current = Date.now();
  return current;
}

function getServerSnapshot(): number | null {
  return null;
}

/** Milliseconds since the epoch from a Date, an ISO string or a number; null when invalid. */
export function toMillis(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The current time in ms, refreshed every 30 s. On the server and during hydration: `serverNow`
 * (null when not given — pass the render time from the server component to avoid that).
 */
export function useNow(serverNow?: Date | string | number | null): number | null {
  const clientNow = useSyncExternalStore<number | null>(subscribe, getSnapshot, getServerSnapshot);
  return clientNow ?? toMillis(serverNow);
}

const subscribeNothing = (): (() => void) => () => {};

/** False on the server and during hydration, true afterwards (for browser-only rendering). */
export function useHydrated(): boolean {
  return useSyncExternalStore<boolean>(
    subscribeNothing,
    () => true,
    () => false,
  );
}
