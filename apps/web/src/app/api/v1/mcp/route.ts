/**
 * POST /api/v1/mcp (D-128): the hub's MCP server over Streamable HTTP, stateless, with JSON responses
 * (no SSE stream: nothing is pushed, D-3). Behind withApiKey like every v1 route (D-129): the key is
 * the credential, one POST is one request against its limit and in the hub_api_* metrics (D-130,
 * D-135), and each POST gets a server of its own for that key's principal.
 *
 * The body is read here, capped (readJson), and handed to the transport as parsedBody: the request
 * is never copied (NEXT-13). GET (a stream the server would push on) and DELETE (ending a session it
 * never started) answer 405, as the spec asks of a server without them.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { mcpPreflight, withCors } from '@/lib/api-v1/cors';
import { withApiKey } from '@/lib/api-v1/with-api-key';
import { errorJson, readJson } from '@/lib/http';
import { createMcpServer } from '@/lib/mcp/server';

/** Largest JSON-RPC message accepted: a tool call is a few hundred bytes. */
const MCP_MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: Request): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const body = await readJson(request, { maxBytes: MCP_MAX_BODY_BYTES });
    const server = createMcpServer(db, principal);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request, { parsedBody: body });
    } finally {
      await server.close();
    }
  });
}

function methodNotAllowed(): Response {
  return withCors(
    errorJson(
      405,
      'method_not_allowed',
      'The MCP endpoint takes POST only (stateless, no stream).',
      {
        Allow: 'POST, OPTIONS',
      },
    ),
  );
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = mcpPreflight;
