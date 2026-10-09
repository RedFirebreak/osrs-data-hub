'use client';
/**
 * The Metrics view's filters live in the URL (D-106): every control reads the parsed query from here
 * and changes it by replacing the URL, so the server renders the new view and a view can be
 * bookmarked or sent. `pending` is true while that render is on its way, and the charts dim.
 *
 *   <MetricsQueryProvider query={query}>…</MetricsQueryProvider>
 *   const { query, set } = useMetricsQuery();
 *   set({ measure: 'gp' });              // keeps every other filter
 */
import { metricsSearch, type MetricsQuery } from '@hub/core';
import type { Route } from 'next';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo, useTransition } from 'react';

interface MetricsQueryContext {
  query: MetricsQuery;
  /**
   * Replaces the URL with the query changed by `patch`; with `anchor`, the page then scrolls to the
   * element with that id (a chosen session's timeline), else it stays where it is.
   */
  set: (patch: Partial<MetricsQuery>, opts?: { anchor?: string }) => void;
  /** The URL of the query changed by `patch`, for a link. */
  href: (patch: Partial<MetricsQuery>) => Route;
  pending: boolean;
}

const Context = createContext<MetricsQueryContext | null>(null);

export function MetricsQueryProvider({
  query,
  children,
}: {
  query: MetricsQuery;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const href = useCallback(
    (patch: Partial<MetricsQuery>) => {
      const search = metricsSearch({ ...query, ...patch });
      return (search ? `${pathname}?${search}` : pathname) as Route;
    },
    [pathname, query],
  );
  const set = useCallback(
    (patch: Partial<MetricsQuery>, opts: { anchor?: string } = {}) => {
      startTransition(() =>
        opts.anchor
          ? router.replace(`${href(patch)}#${opts.anchor}` as Route)
          : router.replace(href(patch), { scroll: false }),
      );
    },
    [router, href],
  );
  const value = useMemo(() => ({ query, set, href, pending }), [query, set, href, pending]);
  return <Context value={value}>{children}</Context>;
}

export function useMetricsQuery(): MetricsQueryContext {
  const ctx = useContext(Context);
  if (!ctx) throw new Error('useMetricsQuery outside MetricsQueryProvider');
  return ctx;
}
