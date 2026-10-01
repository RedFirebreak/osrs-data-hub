/**
 * The decommission switch (handoff §3.2, §7.7, §12 Admin, D-19).
 *
 * - PUT `{ decommissioned: true, confirm: "<HUB_NAME>" }` turns it on: from then on ingest (and
 *   /pair, D-56) answers 410, and every plugin that gets it disables its connection for good.
 *   `confirm` must be the hub name exactly (surrounding spaces ignored on both sides,
 *   decommissionConfirmMatches), as typed in the page's confirmation; otherwise 400
 *   `confirmation_mismatch` and nothing changes.
 * - PUT `{ decommissioned: false }` turns it off again. Connections that already received 410 stay
 *   disabled in the plugin until their players turn them on again (the tokens still work).
 *
 * → 200 `{ decommissioned }`. Audited as 'hub.decommissioned' (setDecommissioned), which also clears
 * this process's cached switch so ingest sees it at once. Session auth (401), admins only (403), and
 * an Origin check (403 `bad_origin`, D-36).
 */
import { getConfig } from '@hub/core';
import { getDb } from '@hub/db';
import { setDecommissioned } from '@hub/server';
import { z } from 'zod';
import { decommissionConfirmMatches } from '@/lib/admin-rules';
import { ApiError, assertSameOrigin, handleApi, json, readJson } from '@/lib/http';
import { requireApiAdmin } from '../guard';

const bodySchema = z.strictObject({
  decommissioned: z.boolean(),
  confirm: z.string().max(256).optional(),
});

export async function PUT(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { user } = await requireApiAdmin(request);
    const body = bodySchema.parse(await readJson(request));
    if (body.decommissioned && !decommissionConfirmMatches(body.confirm, getConfig().hubName)) {
      throw new ApiError(
        400,
        'confirmation_mismatch',
        'Type the hub name exactly as shown to confirm.',
      );
    }
    await setDecommissioned(getDb().db, { value: body.decommissioned, actorUserId: user.id });
    return json(200, { decommissioned: body.decommissioned });
  });
}
