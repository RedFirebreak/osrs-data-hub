/**
 * GET /api/app/admin/raw-payloads/[id]?receivedAt=<ISO> → 200 `{ payload: { id, receivedAt, body } }`:
 * one archived ingest body exactly as stored (text; it may not be valid JSON), for the admin raw
 * payload viewer (handoff §12). raw_payloads is a hypertable keyed by (id, received_at), so the list's
 * receivedAt comes along.
 *
 * Bodies can hold coordinates and inventories the player shares with nobody: admins only, every view
 * is audited ('raw_payload.viewed', by getRawPayload), the response is `no-store`, and the body is
 * never logged (handoff §16).
 *
 * Same origin only (D-80), checked before anything is read or audited: a GET, but one that writes
 * an audit entry, so a foreign page must not be able to fire it with the admin's cookie (an <img> or
 * a link would). The viewer's same-origin fetch sends no Origin on a GET, but `Sec-Fetch-Site:
 * same-origin`, which isSameOrigin accepts; a cross-site request gets 403 `bad_origin`.
 *
 * 400 when receivedAt is missing or not an ISO instant; 404 when no such payload exists (or it has
 * aged out after RAW_PAYLOAD_RETENTION_HOURS). Session auth (401), admins only (403).
 */
import { getDb } from '@hub/db';
import { getRawPayload } from '@hub/server';
import { z } from 'zod';
import { ApiError, assertSameOrigin, handleApi, json } from '@/lib/http';
import { isoInstant, parseQuery } from '@/lib/query';
import { requireApiAdmin } from '../../guard';

const querySchema = z.object({ receivedAt: isoInstant });

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/app/admin/raw-payloads/[id]'>,
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { user } = await requireApiAdmin(request);
    const { id } = await ctx.params;
    const { receivedAt } = parseQuery(request, querySchema);
    const body = await getRawPayload(getDb().db, { id, receivedAt, actorUserId: user.id });
    if (body === null) throw new ApiError(404, 'not_found', 'Payload not found.');
    return json(200, { payload: { id, receivedAt: receivedAt.toISOString(), body } });
  });
}
