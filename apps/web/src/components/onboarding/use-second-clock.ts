'use client';
/**
 * A one-second clock for the pairing wizard's countdowns (code expiry, the "I pressed Submit" wait).
 * One interval for the page, running only while some component asks for it with `active`; the
 * coarser 30 s clock for relative times is components/live/use-now.ts.
 *
 * Hydration-safe: null during server rendering and hydration, the browser's time afterwards.
 */
import { useSyncExternalStore } from 'react';

const TICK_MS = 1_000;

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
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const subscribeNothing = (): (() => void) => () => {};

function getSnapshot(): number {
  if (current === 0) current = Date.now();
  return current;
}

function getServerSnapshot(): number | null {
  return null;
}

/**
 * The current time in ms, updated every second while `active`; while inactive the value is the last
 * one seen (read Date.now() in event handlers instead). Null on the server and during hydration.
 */
export function useSecondClock(active: boolean): number | null {
  return useSyncExternalStore<number | null>(
    active ? subscribe : subscribeNothing,
    getSnapshot,
    getServerSnapshot,
  );
}
