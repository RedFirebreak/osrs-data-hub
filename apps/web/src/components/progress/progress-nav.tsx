'use client';
/**
 * A Progress page's view lives in its address (lib/progress.ts): the range control and the measure
 * pills read it from here and change it by replacing the URL, so the server renders the new view
 * and a view can be bookmarked or sent. The control a person pressed moves at once (the query here
 * is optimistic); `pending` is true while the new view is on its way, and the chart dims.
 *
 *   <ProgressQueryProvider query={query}>…</ProgressQueryProvider>
 *   const { query, set } = useProgressQuery();
 *   set({ range: '30d' });               // keeps the measure
 */
import type { Route } from 'next';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useOptimistic,
  useTransition,
} from 'react';
import { progressSearch, type ProgressQuery } from '@/lib/progress';

interface ProgressQueryContext {
  query: ProgressQuery;
  set: (patch: Partial<ProgressQuery>) => void;
  pending: boolean;
}

const Context = createContext<ProgressQueryContext | null>(null);

export function ProgressQueryProvider({
  query,
  children,
}: {
  query: ProgressQuery;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(query);
  const set = useCallback(
    (patch: Partial<ProgressQuery>) => {
      startTransition(() => {
        const next = { ...shown, ...patch };
        setShown(next);
        const search = progressSearch(next);
        router.replace((search ? `${pathname}?${search}` : pathname) as Route, { scroll: false });
      });
    },
    [router, pathname, shown, setShown],
  );
  const value = useMemo(() => ({ query: shown, set, pending }), [shown, set, pending]);
  return <Context value={value}>{children}</Context>;
}

export function useProgressQuery(): ProgressQueryContext {
  const ctx = useContext(Context);
  if (!ctx) throw new Error('useProgressQuery outside ProgressQueryProvider');
  return ctx;
}
