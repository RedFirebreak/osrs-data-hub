/**
 * Creating a service key, one of the hub's integration keys (D-88), on Admin → Integrations; that
 * page lists them on the server (listServiceKeys).
 *
 * POST `{ name, categories, expiresInDays?, rateLimitPerMinute? }` → 201 `{ key, info }`. `key`
 * (`ohub_<prefix>_<secret>`) is in this response only: the hub keeps just sha256(secret). The body
 * is validated by createServiceKey (CreateServiceKeySchema; 400 `invalid_request` with `details`).
 * The key belongs to no user and reads what the guild audience sees (D-89). Audited.
 *
 * The Origin check first (403 `bad_origin`, D-36), then session auth (401), admins only (403); the
 * body is capped at 64 KiB (413).
 */
import { getDb } from '@hub/db';
import { createServiceKey } from '@hub/server';
import { assertSameOrigin, handleApi, json, readJson } from '@/lib/http';
import { requireApiAdmin } from '../guard';

export async function POST(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { viewer } = await requireApiAdmin(request);
    const input = await readJson(request);
    const created = await createServiceKey(getDb().db, { actor: viewer, input });
    // no-store (json's default): the one response that ever carries the secret.
    return json(201, { key: created.key, info: created.info });
  });
}
