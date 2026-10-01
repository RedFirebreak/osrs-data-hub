/**
 * Creating one of the signed-in user's API keys (handoff §13, D-69, D-76); the API keys page lists
 * them on the server (listApiKeys).
 *
 * POST `{ name, categories, accountScope: 'all_visible' | 'list', accountPublicIds?, expiresInDays? }`
 * → 201 `{ key, info }`. `key` (`ohub_<prefix>_<secret>`) is in this response only: the hub keeps
 * just sha256(secret), so it can never be shown again. The body is validated by createApiKey
 * (CreateApiKeySchema; 400 `invalid_request` with `details`), at most 10 active keys (409 `limit`),
 * and a 'list' scope may only name accounts the user can see right now (400). Audited.
 *
 * The Origin check first (403, D-36), then session auth (401); the body is capped at 64 KiB (413).
 */
import { getDb } from '@hub/db';
import { createApiKey } from '@hub/server';
import { assertSameOrigin, handleApi, json, readJson } from '@/lib/http';
import { requireApiUser } from '@/lib/session';

export async function POST(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { user } = await requireApiUser(request);
    const body = await readJson(request);
    const created = await createApiKey(getDb().db, user.id, body);
    // no-store (json's default): the one response that ever carries the secret.
    return json(201, { key: created.key, info: created.info });
  });
}
