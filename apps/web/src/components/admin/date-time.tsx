'use client';
/**
 * `<time>` showing an absolute date (and time): in UTC on the server and during hydration (the
 * server doesn't know the admin's time zone; utcDateText, which doesn't depend on Intl data), in the
 * browser's locale and zone right after. Use RelativeTime for "3 min ago".
 */
import { toMillis, useHydrated } from '@/components/live/use-now';
import { utcDateText } from './admin-model';

export function DateTime({
  date,
  withTime = false,
  className,
}: {
  date: string | Date;
  /** Include hours and minutes. */
  withTime?: boolean;
  className?: string;
}) {
  const hydrated = useHydrated();
  const at = toMillis(date);
  if (at === null) return null;
  const d = new Date(at);
  const text = hydrated
    ? withTime
      ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : d.toLocaleDateString(undefined, { dateStyle: 'medium' })
    : utcDateText(at, withTime);
  return (
    <time dateTime={d.toISOString()} className={className}>
      {text}
    </time>
  );
}
