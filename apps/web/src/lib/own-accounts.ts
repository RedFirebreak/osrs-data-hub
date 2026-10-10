/**
 * The signed-in viewer's own characters for this request (@hub/server listOwnAccounts: owned or
 * contributed, most recently played first), read once however many parts of a page ask: the layout's
 * navigation, Home, the character pickers. Server only.
 */
import { getDb } from '@hub/db';
import { listOwnAccounts } from '@hub/server';
import { cache } from 'react';
import { requireUser } from './session';

export const loadOwnAccounts = cache(async () => {
  const { viewer } = await requireUser();
  return listOwnAccounts(getDb().db, viewer);
});
