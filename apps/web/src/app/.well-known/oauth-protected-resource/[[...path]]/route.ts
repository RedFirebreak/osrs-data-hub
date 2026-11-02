/**
 * The MCP endpoint's protected resource metadata (RFC 9728, D-137): which authorization server hands
 * out its tokens. An MCP client reads it from the URL in the endpoint's 401 (`resource_metadata`),
 * or, without that, at `/.well-known/oauth-protected-resource` + the endpoint's path; both are served,
 * and the bare root too. Public, read by browsers and servers alike, so CORS `*`.
 */
import { getConfig } from '@hub/core';
import { getAuth } from '@/lib/auth';
import { mcpResourceMetadata } from '@/lib/mcp/oauth';

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=3600',
};

export async function GET(
  _request: Request,
  ctx: RouteContext<'/.well-known/oauth-protected-resource/[[...path]]'>,
): Promise<Response> {
  const { path } = await ctx.params;
  const suffix = (path ?? []).join('/');
  // The only protected resource is the MCP endpoint (D-131: /api/v1 itself takes keys only).
  if (suffix !== '' && suffix !== 'api/v1/mcp') {
    return Response.json({ error: 'not_found' }, { status: 404, headers: HEADERS });
  }
  const { issuer } = await getAuth().api.getOAuthServerConfig({ headers: new Headers() });
  return Response.json(mcpResourceMetadata(getConfig(), issuer), { headers: HEADERS });
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...HEADERS,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Mcp-Protocol-Version',
    },
  });
}
