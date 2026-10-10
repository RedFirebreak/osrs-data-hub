/**
 * Metrics goals of an account (D-109).
 *
 * - POST `{ kind: 'level' | 'xp' | 'kc', target, value }` → 200 `{ goal }`: sets the goal (@hub/server
 *   setGoal); a goal of the same kind and target is replaced. Only the owner sets goals: 404 for an
 *   account the viewer can't see, 403 forbidden for anyone else, 400 invalid for an unknown skill or
 *   a value out of range, 409 limit past MAX_GOALS. A malformed body → 400 `invalid_request`.
 *
 * Session auth (401) and the Origin check (CSRF, 403 `bad_origin`, D-36).
 */
import { GOAL_KINDS, isPublicIdLike, setGoal } from '@hub/server';
import { getDb } from '@hub/db';
import { z } from 'zod';
import { accountNotFound, assertSameOrigin, handleApi, json, readJson } from '@/lib/http';
import { requireApiUser } from '@/lib/session';

const goalSchema = z.strictObject({
  kind: z.enum(GOAL_KINDS),
  target: z.string().trim().min(1).max(64),
  value: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/app/accounts/[publicId]/goals'>,
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { viewer } = await requireApiUser(request);
    const { publicId } = await ctx.params;
    if (!isPublicIdLike(publicId)) throw accountNotFound();
    const input = goalSchema.parse(await readJson(request));
    const goal = await setGoal(getDb().db, viewer, publicId, input);
    return json(200, { goal });
  });
}
