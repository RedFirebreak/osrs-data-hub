/**
 * drizzle-orm 0.45 wraps pg errors in DrizzleQueryError: the SQLSTATE is on `err.cause.code`, and
 * `err.message` contains every bound parameter (tokens, coordinates). Never log `err.message` of a
 * database error; log `pgErrorCode(err)` and `safeDbErrorMessage(err)` instead (DB-3).
 */
export function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The Postgres message without the query or its parameters. */
export function safeDbErrorMessage(err: unknown): string {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      const msg = (cur as { message?: unknown }).message;
      return typeof msg === 'string' ? msg : code;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  if (err instanceof Error && !('cause' in err && err.cause)) {
    // Not a query error (e.g. a pool/connection error): its message carries no parameters.
    return err.message.split('\n')[0] ?? err.name;
  }
  return 'database error';
}

/**
 * Errors worth a retry: the plugin gets 503 + Retry-After and resends (events are idempotent).
 * Connection failures, shutdowns, lock timeouts, serialization failures, deadlocks, and too many
 * connections.
 */
export function isTransientDbError(err: unknown): boolean {
  const code = pgErrorCode(err);
  if (code) {
    return (
      code.startsWith('08') || // connection exception
      code === '57P01' || // admin_shutdown
      code === '57P02' || // crash_shutdown
      code === '57P03' || // cannot_connect_now
      code === '55P03' || // lock_not_available (lock_timeout)
      code === '57014' || // query_canceled (statement_timeout)
      code === '40001' || // serialization_failure
      code === '40P01' || // deadlock_detected
      code === '53300' || // too_many_connections
      code === '53400' || // configuration_limit_exceeded
      code === '23505' // unique_violation from a concurrent insert race: a retry resolves it
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  const errno = (err as { code?: unknown })?.code;
  return (
    errno === 'ECONNREFUSED' ||
    errno === 'ECONNRESET' ||
    errno === 'ETIMEDOUT' ||
    errno === 'EPIPE' ||
    errno === 'ENOTFOUND' ||
    /timeout exceeded when trying to connect|Connection terminated|Client has encountered a connection error/i.test(
      msg,
    )
  );
}

/** Errors caused by the payload itself (bad data): answer 400 so the plugin drops it (PLUGIN-3). */
export function isDataDbError(err: unknown): boolean {
  const code = pgErrorCode(err);
  return !!code && (code.startsWith('22') || (code.startsWith('23') && code !== '23505'));
}
