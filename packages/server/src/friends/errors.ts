export type FriendErrorCode = 'forbidden' | 'not_found' | 'invalid' | 'conflict' | 'limit';

/**
 * A refused friend action (D-117). Routes map the code to a status: forbidden → 403, not_found →
 * 404, invalid → 400, conflict and limit → 409. The message is shown to the user as it is.
 */
export class FriendError extends Error {
  override name = 'FriendError';

  constructor(
    readonly code: FriendErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}
