'use client';
/**
 * One request to an /api/app route (lib/api-client.ts) with what every form, dialog and button
 * around it needs: the pending flag, the error text to show (failureMessage, with the caller's
 * wording as FailureOptions) and the refresh after a 401, which sends a signed-out user to /login.
 *
 * `send` resolves the answer as `{ ok, status, body }`, whatever it was, so the caller can read the
 * created thing from a 2xx body or the field errors from a 400's `details`. For an answer that isn't
 * `ok` the error text is already set; a caller that judges a 2xx body unusable sets it itself
 * (`setError(failureMessage(…))`).
 */
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import {
  failureMessage,
  refreshesPage,
  sendJson,
  type ApiRequestInit,
  type ApiResult,
  type FailureOptions,
} from './api-client';

export interface ApiRequest {
  pending: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  /** `failure`: the feature's wording, or just the text when the hub gives no better one. */
  send: (
    path: string,
    init: ApiRequestInit,
    failure: FailureOptions | string,
  ) => Promise<ApiResult>;
}

export function useApiRequest(): ApiRequest {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback<ApiRequest['send']>(
    async (path, init, failure) => {
      setPending(true);
      setError(null);
      const result = await sendJson(path, init);
      if (!result.ok) {
        setError(failureMessage(result.status, result.body, failure));
        if (refreshesPage(result.status, failure)) router.refresh();
      }
      setPending(false);
      return result;
    },
    [router],
  );

  return { pending, error, setError, send };
}
