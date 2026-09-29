/**
 * GET /api/app/admin/raw-payloads/[id]?receivedAt=<ISO> → 200 `{ payload: { id, receivedAt, body } }`:
 * one archived ingest body exactly as stored (text; it may not be valid JSON), for the admin raw
 * payload viewer (handoff §12). raw_payloads is a hypertable keyed by (id, received_at), so the list's
 * receivedAt comes along.
 *
 * Bodies can hold coordinates and inventories the player shares with nobody: admins only, every view
 * is audited ('raw_payload.viewed', by getRawPayload), the response is `no-store`, and the body is
 * never logged (handoff §16). No Origin check: a GET changes nothing a foreign page could use, and
 * browsers send no Origin on same-origin GETs.
 *
 * 400 when receivedAt is missing or not an ISO instant; 404 when no such payload exists (or it has
 * aged out after RAW_PAYLOAD_RETENTION_HOURS). Session auth (401), admins only (403).
 */
import { getDb } from '@hub/db';
import { getRawPayload } from '@hub/server';
import { z } from 'zod';
import { ApiError, handleApi, json } from '@/lib/http';
import { requireApiAdmin } from '../../guard';

const querySchema = z.object({
  receivedAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
});

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/app/admin/raw-payloads/[id]'>,
): Promise<Response> {
  return handleApi(async () => {
    const { user } = await requireApiAdmin(request);
    const { id } = await ctx.params;
    const { receivedAt } = querySchema.parse({
      receivedAt: new URL(request.url).searchParams.get('receivedAt') ?? undefined,
    });
    const body = await getRawPayload(getDb().db, { id, receivedAt, actorUserId: user.id });
    if (body === null) throw new ApiError(404, 'not_found', 'Payload not found.');
    return json(200, { payload: { id, receivedAt: receivedAt.toISOString(), body } });
  });
}
