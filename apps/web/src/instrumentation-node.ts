/**
 * Server start on the Node runtime (imported by instrumentation.ts only):
 * 1. Validate the configuration. An invalid one (e.g. APP_URL with a path, D-26) is logged with the
 *    ConfigError's message, which names the variables but never their values, and in production the
 *    process exits(1) so the container restarts visibly instead of serving a half-working hub.
 * 2. Start the LISTEN connection that feeds the live streams (D-5). It lives on globalThis, so the
 *    stream route's lazy ensureLiveListener() finds this one (NEXT-3). A database that is down at boot
 *    is not fatal: the listener keeps reconnecting.
 * Nothing runs during `next build`, which must work without runtime secrets.
 */
import { ConfigError, getConfig } from '@hub/core';
import { ensureLiveListener, getLogger } from '@hub/server';

export function startNode(): void {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const log = getLogger();
  const production = process.env.NODE_ENV === 'production';

  try {
    const config = getConfig();
    if (production && !config.authSecret) log.error('AUTH_SECRET is not set: sign-in will fail');
  } catch (err) {
    const message = err instanceof ConfigError ? err.message : 'Invalid configuration';
    log.fatal({ error: message }, 'invalid configuration, see .env.example');
    // Also on stderr in plain text: the first thing an operator sees in `docker compose logs`.
    console.error(message);
    if (production) process.exit(1);
    return;
  }

  if (!process.env.DATABASE_URL) {
    log.warn('DATABASE_URL is not set: live updates are off');
    return;
  }
  try {
    ensureLiveListener();
  } catch (err) {
    log.error(
      { errName: err instanceof Error ? err.name : typeof err },
      'live: could not start the LISTEN connection',
    );
  }
}
