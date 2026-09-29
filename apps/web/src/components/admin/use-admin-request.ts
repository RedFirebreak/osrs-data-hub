'use client';
/**
 * One admin mutation (POST/PUT/DELETE under /api/app/admin/*) with its pending flag and the error
 * text to show (adminFailureMessage). `send` resolves the parsed JSON body on success and null on
 * failure; a 401 also refreshes the page, which sends a signed-out admin to /login. The browser adds
 * the Origin header the route checks (D-36).
 */
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { adminFailureMessage } from './admin-model';

export interface AdminRequest {
  pending: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  send: (
    path: string,
    init: { method: 'POST' | 'PUT' | 'DELETE'; json?: unknown },
    fallback: string,
  ) => Promise<unknown>;
}

export function useAdminRequest(): AdminRequest {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback<AdminRequest['send']>(
    async (path, init, fallback) => {
      setPending(true);
      setError(null);
      try {
        const res = await fetch(path, {
          method: init.method,
          credentials: 'same-origin',
          headers: init.json === undefined ? undefined : { 'content-type': 'application/json' },
          body: init.json === undefined ? undefined : JSON.stringify(init.json),
        });
        const body: unknown = await res.json().catch(() => null);
        if (res.ok) return body ?? {};
        setError(adminFailureMessage(res.status, body, fallback));
        if (res.status === 401) router.refresh();
        return null;
      } catch {
        setError("Couldn't reach the hub. Check your connection and try again.");
        return null;
      } finally {
        setPending(false);
      }
    },
    [router],
  );

  return { pending, error, setError, send };
}
