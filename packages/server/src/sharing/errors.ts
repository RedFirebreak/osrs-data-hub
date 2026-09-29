export type SharingErrorCode = 'not_found' | 'forbidden' | 'invalid';

/**
 * A refused sharing change. Routes map the code to a status: not_found → 404 (the account doesn't
 * exist or the actor may not know it exists), forbidden → 403 (visible, but the actor may not make
 * this change), invalid → 400 (bad category/audience, or a target user or account state the change
 * doesn't apply to). The message is safe to show: it never contains data.
 */
export class SharingError extends Error {
  override name = 'SharingError';

  constructor(
    readonly code: SharingErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}
