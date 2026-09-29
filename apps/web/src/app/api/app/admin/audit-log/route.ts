/**
 * GET /api/app/admin/audit-log?before=<id>&limit=<1…200> → 200 `{ entries, nextBefore }`: the audit
 * log, newest first (handoff §12 Admin), for the page's "Load more". `before` is the id of the last
 * entry shown; `nextBefore` is the id to pass for the next page, or null when this page came back
 * short (nothing older). Default limit AUDIT_PAGE_SIZE (50).
 *
 * 400 for a malformed query (strict, D-10). Session auth (401), admins only (403).
 */
import { getDb } from '@hub/db';
import { listAuditLog } from '@hub/server';
import { z } from 'zod';
import { AUDIT_PAGE_SIZE } from '@/components/admin/admin-model';
import { handleApi, json } from '@/lib/http';
import { requireApiAdmin } from '../guard';

const AUDIT_LOG_MAX_LIMIT = 200;

const positiveInt = z
  .string()
  .regex(/^\d{1,15}$/, 'must be a positive whole number')
  .transform(Number)
  .refine((n) => n >= 1, 'must be at least 1');

const querySchema = z.object({
  before: positiveInt.optional(),
  limit: positiveInt
    .refine((n) => n <= AUDIT_LOG_MAX_LIMIT, `must be at most ${AUDIT_LOG_MAX_LIMIT}`)
    .optional(),
});

export async function GET(request: Request): Promise<Response> {
  return handleApi(async () => {
    await requireApiAdmin(request);
    const params = new URL(request.url).searchParams;
    const query = querySchema.parse({
      before: params.get('before') ?? undefined,
      limit: params.get('limit') ?? undefined,
    });
    const limit = query.limit ?? AUDIT_PAGE_SIZE;
    const entries = await listAuditLog(getDb().db, { limit, before: query.before });
    const last = entries.at(-1);
    return json(200, { entries, nextBefore: entries.length >= limit && last ? last.id : null });
  });
}
