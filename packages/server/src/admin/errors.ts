import type { Viewer } from '@hub/core';

export type AdminErrorCode = 'forbidden' | 'not_found' | 'invalid';

/**
 * A refused admin action. Routes map the code to a status: forbidden → 403 (the actor isn't an
 * active admin), not_found → 404, invalid → 400 (e.g. an admin offboarding themselves). The message
 * is safe to show.
 */
export class AdminError extends Error {
  override name = 'AdminError';

  constructor(
    readonly code: AdminErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

/**
 * Only an active admin may act: AdminError 'forbidden' otherwise. The routes check too; this is the
 * second lock, inside every admin action.
 */
export function assertAdmin(actor: Viewer): void {
  if (actor.isAdmin !== true || actor.status !== 'active') {
    throw new AdminError('forbidden', 'admins only');
  }
}
