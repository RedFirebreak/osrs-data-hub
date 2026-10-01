'use client';
/**
 * `<time>` showing a relative time ("just now", "3 min ago", "2 h ago") via @hub/core relativeTime,
 * kept current by the shared useNow clock. The full local date and time is in the tooltip (title).
 *
 * Usable from server and client components. When rendered on the server, pass `now` (the render
 * time, e.g. `new Date().toISOString()` from the page) so the server HTML and hydration agree.
 */
import { relativeTime } from '@hub/core';
import { toMillis, useHydrated, useNow } from './use-now';

export interface RelativeTimeProps {
  /** The moment to describe. */
  date: string | Date;
  /** The server's render time (for hydration); ignored once hydrated. */
  now?: string | Date | number;
  /** Text put in front of the relative time, e.g. "last seen". */
  prefix?: string;
  className?: string;
}

export function RelativeTime({ date, now, prefix, className }: RelativeTimeProps) {
  const at = toMillis(date);
  const current = useNow(now);
  const hydrated = useHydrated();
  if (at === null) return null;
  const iso = new Date(at).toISOString();
  // Without any clock (server render without `now`): a stable absolute UTC time.
  const text =
    current === null
      ? `${iso.slice(0, 16).replace('T', ' ')} UTC`
      : relativeTime(new Date(at), new Date(current));
  return (
    <time
      dateTime={iso}
      // The browser's locale and time zone only after hydration (the server's would differ).
      title={hydrated ? new Date(at).toLocaleString() : undefined}
      className={className}
    >
      {prefix ? `${prefix} ${text}` : text}
    </time>
  );
}
