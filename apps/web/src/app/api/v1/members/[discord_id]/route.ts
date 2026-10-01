/**
 * GET /api/v1/members/{discord_id} (D-100): whether one Discord account is a member of the hub and
 * an admin, for the guild's own services. A service key always gets a 200 verdict (`member: false`
 * for an unknown id and a user in grace alike), or a 400 for an id that can't be one. For a user key
 * the endpoint doesn't exist: the same 404 as an unknown path.
 */
import { apiMember } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { endpointNotFound, v1Ok } from '@/lib/api-v1/respond';
import { wireMember } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/v1/members/[discord_id]'>,
): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    // Not parsed here: the read model answers a user key before it looks at the id.
    const { discord_id: discordId } = await ctx.params;
    const member = await apiMember(db, principal, discordId);
    if (member === null) throw endpointNotFound();
    return v1Ok(wireMember(member));
  });
}

export const OPTIONS = preflight;
