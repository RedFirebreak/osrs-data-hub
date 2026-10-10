/**
 * The quick check before anything streams on the account's pages (NEXT-14): the account if the
 * viewer may know it exists, else null. Shared by generateMetadata and the page within one request,
 * and by the account page and its Metrics pages.
 */
import { getDb } from '@hub/db';
import { isPublicIdLike, loadVisibleAccount } from '@hub/server';
import { cache } from 'react';
import { requireUser } from '@/lib/session';

export const loadVisible = cache(async (publicId: string) => {
  const { viewer } = await requireUser();
  // An id that can't be one (`%00` decodes to a NUL, which Postgres refuses) is just not found.
  return isPublicIdLike(publicId) ? loadVisibleAccount(getDb().db, viewer, publicId) : null;
});
