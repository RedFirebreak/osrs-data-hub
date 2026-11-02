/**
 * The OAuth authorization server metadata (RFC 8414, D-137) of the hub's sign-in for MCP clients.
 * The issuer is `<APP_URL>/api/auth`, so RFC 8414 puts the document at
 * `/.well-known/oauth-authorization-server/api/auth`; some clients look at the bare root instead,
 * which answers the same. Better Auth builds the document (its endpoint is server-only).
 */
import { getAuth } from '@/lib/auth';

const HEADERS = { 'Access-Control-Allow-Origin': '*' };

export async function GET(
  _request: Request,
  ctx: RouteContext<'/.well-known/oauth-authorization-server/[[...path]]'>,
): Promise<Response> {
  const { path } = await ctx.params;
  const suffix = (path ?? []).join('/');
  if (suffix !== '' && suffix !== 'api/auth') {
    return Response.json({ error: 'not_found' }, { status: 404, headers: HEADERS });
  }
  // Never the request itself (NEXT-13); the document depends on APP_URL only.
  const metadata = await getAuth().api.getOAuthServerConfig({ headers: new Headers() });
  return Response.json(metadata, {
    headers: { ...HEADERS, 'Cache-Control': 'public, max-age=3600' },
  });
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
