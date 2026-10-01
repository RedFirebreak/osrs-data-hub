/**
 * The export's rate limit (D-79): one "Download my data" per user per 10 minutes. In memory in the
 * single web process (D-5), on globalThis: route handlers and RSC are separate module instances in
 * Next, and a module-level limiter would exist once per instance (NEXT-3, D-37).
 */
import { MINUTE_MS, WindowLimiter } from '@hub/core';

export const EXPORT_WINDOW_MS = 10 * MINUTE_MS;

const g = globalThis as unknown as { __hubExportLimiter?: WindowLimiter };

/** The process-wide limiter, keyed by user id. */
export function getExportLimiter(): WindowLimiter {
  g.__hubExportLimiter ??= new WindowLimiter({ limit: 1, windowMs: EXPORT_WINDOW_MS });
  return g.__hubExportLimiter;
}

/** Replaces the limiter (a test clock) or, without one, forgets it (tests). */
export function setExportLimiterForTests(limiter?: WindowLimiter): void {
  if (limiter) g.__hubExportLimiter = limiter;
  else delete g.__hubExportLimiter;
}
