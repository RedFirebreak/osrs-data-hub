/**
 * The addresses of the hub's sign-in for MCP clients (D-137), shared by the OAuth provider's
 * configuration (lib/auth.ts), the MCP route's 401 and the discovery documents under /.well-known.
 */
import type { HubConfig } from '@hub/core';

/**
 * The scopes the hub's OAuth provider knows: `mcp` (read the hub through the MCP endpoint, as the
 * key the consent page makes) and `offline_access` (a refresh token, so the connection survives the
 * access token's hour). No `openid`: the hub hands out no ID tokens.
 */
export const OAUTH_SCOPES = ['mcp', 'offline_access'] as const;

/** The website's page on connecting an AI assistant (Claude.ai, Claude Code, Cursor, …). */
export const AI_ASSISTANT_DOCS_URL = 'https://scapekeeper.com/docs/integrations/ai-assistant';

/** The protected resource: the MCP endpoint's URL, the audience of every token (RFC 8707). */
export function mcpResource(config: Pick<HubConfig, 'appOrigin'>): string {
  return `${config.appOrigin}/api/v1/mcp`;
}

/** The protected resource's metadata document (RFC 9728), as named in the MCP route's 401. */
export function mcpResourceMetadataUrl(config: Pick<HubConfig, 'appOrigin'>): string {
  return `${config.appOrigin}/.well-known/oauth-protected-resource/api/v1/mcp`;
}

/**
 * The protected resource's metadata (RFC 9728 §2). `issuer` is the provider's own (its metadata's
 * `issuer`): it is APP_URL + /api/auth, except that the provider insists on https for any host but
 * localhost.
 */
export function mcpResourceMetadata(
  config: Pick<HubConfig, 'appOrigin' | 'hubName'>,
  issuer: string,
) {
  return {
    resource: mcpResource(config),
    authorization_servers: [issuer],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: `${config.hubName} MCP`,
    resource_documentation: AI_ASSISTANT_DOCS_URL,
  };
}
