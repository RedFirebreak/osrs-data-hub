export type ApiErrorCode = 'invalid' | 'not_found';

/**
 * A request the public API refuses (D-71). The web layer maps the code to a status: `invalid` → 400
 * (a parameter is malformed or out of range; the message says which), `not_found` → 404 (an account
 * named in a list parameter isn't visible to the key, answered exactly like an unknown id, D-70).
 * For the account in the path, read models return null instead, which the web also answers with 404.
 * The message is safe to show: it only repeats what the request itself contained.
 */
export class ApiError extends Error {
  override name = 'ApiError';

  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}
