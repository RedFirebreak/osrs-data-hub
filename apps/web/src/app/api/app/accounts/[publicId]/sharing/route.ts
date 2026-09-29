/**
 * An account's sharing settings (handoff §10, the sharing panel of §12).
 *
 * - GET → 200 `{ sharing: SharingSettings }` (@hub/server getSharingSettings): readable by the owner,
 *   non-blocked contributors and admins; 404 for everyone else (members who can see the account's
 *   data included, and viewers who can't see the account at all).
 * - PATCH → one change per request, body discriminated on `action`:
 *     { action: 'audience', category, audience }          setAudience
 *     { action: 'grant' | 'revoke', category, userId }     addGrant / removeGrant
 *     { action: 'transfer', userId }                       transferOwnership
 *     { action: 'claim' }                                  claimOwnership
 *     { action: 'block' | 'unblock' | 'remove', userId }   setContributorBlocked / removeContributor
 *   → 200 `{ sharing }` as it is after the change (null when the actor may no longer read it).
 *   Refusals from the mutation: 404 not_found (invisible), 403 forbidden (not the owner or an
 *   admin; claim: not a contributor), 400 invalid (e.g. blocking the owner, a grantee who isn't an
 *   active member). A malformed body → 400 `invalid_request` with field errors; non-JSON → 400
 *   `invalid_json`.
 *
 * Session auth (401); PATCH also checks the Origin (CSRF, 403 `bad_origin`, D-36).
 */
import type { Viewer } from '@hub/core';
import { getDb, type Db } from '@hub/db';
import {
  addGrant,
  claimOwnership,
  getSharingSettings,
  removeContributor,
  removeGrant,
  setAudience,
  setContributorBlocked,
  transferOwnership,
} from '@hub/server';
import { assertSameOrigin, handleApi, json, readJson } from '@/lib/http';
import { requireApiUser } from '@/lib/session';
import { accountNotFound } from '../../history';
import { isPublicIdShape } from '../../query';
import { sharingChangeSchema, type SharingChange } from '../../sharing-change';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/app/accounts/[publicId]/sharing'>,
): Promise<Response> {
  return handleApi(async () => {
    const { viewer } = await requireApiUser(request);
    const { publicId } = await ctx.params;
    if (!isPublicIdShape(publicId)) throw accountNotFound();
    const sharing = await getSharingSettings(getDb().db, viewer, publicId);
    if (!sharing) throw accountNotFound();
    return json(200, { sharing });
  });
}

export async function PATCH(
  request: Request,
  ctx: RouteContext<'/api/app/accounts/[publicId]/sharing'>,
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { viewer } = await requireApiUser(request);
    const { publicId } = await ctx.params;
    if (!isPublicIdShape(publicId)) throw accountNotFound();
    const change = sharingChangeSchema.parse(await readJson(request));
    const { db } = getDb();
    await applyChange(db, viewer, publicId, change);
    return json(200, { sharing: await getSharingSettings(db, viewer, publicId) });
  });
}

/** Runs the sharing mutation for `change` (each one checks the actor's rights itself). */
async function applyChange(
  db: Db,
  viewer: Viewer,
  publicId: string,
  change: SharingChange,
): Promise<void> {
  switch (change.action) {
    case 'audience':
      return setAudience(db, viewer, publicId, change.category, change.audience);
    case 'grant':
      return addGrant(db, viewer, publicId, change.category, change.userId);
    case 'revoke':
      return removeGrant(db, viewer, publicId, change.category, change.userId);
    case 'transfer':
      return transferOwnership(db, viewer, publicId, change.userId);
    case 'claim':
      return claimOwnership(db, viewer, publicId);
    case 'block':
    case 'unblock':
      return setContributorBlocked(db, viewer, publicId, change.userId, change.action === 'block');
    case 'remove':
      return removeContributor(db, viewer, publicId, change.userId);
  }
}
