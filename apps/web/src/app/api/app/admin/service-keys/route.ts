/**
 * Service keys, the hub's integration keys (D-88), managed on Admin → Integrations:
 *
 * - GET → 200 `{ keys: ServiceKeyInfo[] }` (listServiceKeys): every service key, newest first,
 *   revoked and expired ones included with their status and who created each; never a secret.
 * - POST `{ name, categories, expiresInDays?, rateLimitPerMinute? }` → 201 `{ key, info }`. `key`
 *   (`ohub_<prefix>_<secret>`) is in this response only: the hub keeps just sha256(secret). The body
 *   is validated by createServiceKey (CreateServiceKeySchema; 400 `invalid_request` with `details`).
 *   The key belongs to no user and reads what the guild audience sees (D-89). Audited.
 *
 * Session auth (401), admins only (403); POST also checks the Origin (403 `bad_origin`, D-36) and
 * caps the body at 64 KiB (413).
 */
import { getDb } from '@hub/db';
import { createServiceKey, listServiceKeys } from '@hub/server';
import { assertSameOrigin, handleApi, json, readJson } from '@/lib/http';
import { requireApiAdmin } from '../guard';

export async function GET(request: Request): Promise<Response> {
  return handleApi(async () => {
    await requireApiAdmin(request);
    return json(200, { keys: await listServiceKeys(getDb().db) });
  });
}

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
