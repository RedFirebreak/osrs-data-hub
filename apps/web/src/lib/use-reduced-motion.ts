'use client';
/**
 * Whether the person asked their system for less motion (`prefers-reduced-motion: reduce`), for
 * movement that CSS can't switch off itself: a chart's transition, a counting number. False on the
 * server and until the browser answers.
 */
import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
