/**
 * GET /api/v1/me (handoff §13): the key behind the request (name, prefix, categories, scope, expiry),
 * its creator's name and how many accounts it can see right now (D-70).
 */
import { apiMe } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { v1Ok } from '@/lib/api-v1/respond';
import { wireMe } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';

export async function GET(request: Request): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => v1Ok(wireMe(await apiMe(db, principal))));
}

export const OPTIONS = preflight;
