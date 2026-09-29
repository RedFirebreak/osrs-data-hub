'use client';
/**
 * Re-renders the page's server components (router.refresh()) every `everyMs` while the tab is
 * visible, and when the tab becomes visible again after at least that long. Client state (the live
 * connection, form input) is kept. Used where server-rendered numbers go stale on their own, such as
 * the dashboard's gains and a server-rendered "online" that may have timed out without a message.
 */
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export function AutoRefresh({ everyMs = 60_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      // 0.9: interval ticks may fire a little early.
      if (document.visibilityState !== 'visible' || Date.now() - last < everyMs * 0.9) return;
      last = Date.now();
      router.refresh();
    };
    const timer = setInterval(refresh, Math.max(everyMs, 5_000));
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [router, everyMs]);
  return null;
}
