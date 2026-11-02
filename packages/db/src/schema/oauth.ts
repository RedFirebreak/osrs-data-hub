/**
 * The tables of Better Auth's OAuth provider plugin (`@better-auth/oauth-provider` 1.7.15, D-137):
 * the hub as the authorization server of its MCP endpoint, so Claude.ai and other MCP clients can
 * connect by signing in. Written by hand after the plugin's schema (getAuthTables), the way auth.ts is:
 *  - every timestamp is timestamptz (AUTH-2);
 *  - the drizzle property names are the plugin's field names (the adapter maps by them), the SQL
 *    names snake_case;
 *  - a user's rows go with the user (cascade), so offboarding's hard delete is never blocked; a
 *    session's tokens outlive it (set null), as the plugin declares.
 * Keep in step with the plugin's options in apps/web/src/lib/auth.ts: Better Auth validates the
 * schema at runtime (AUTH-1).
 *
 * Access and refresh tokens are stored hashed (`storeTokens` in auth.ts, the same hash
 * authenticateApiKey uses to find an access token's row).
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { session, users } from './auth';

const tstz = (name: string) => timestamp(name, { withTimezone: true });

export const oauthClient = pgTable(
  'oauth_client',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull().unique('oauth_client_client_id_key'),
    clientSecret: text('client_secret'),
    clientDiscoveryId: text('client_discovery_id'),
    disabled: boolean('disabled').default(false),
    skipConsent: boolean('skip_consent'),
    enableEndSession: boolean('enable_end_session'),
    subjectType: text('subject_type'),
    scopes: text('scopes').array(),
    clientCredentialsScopes: text('client_credentials_scopes').array(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    createdAt: tstz('created_at'),
    updatedAt: tstz('updated_at'),
    name: text('name'),
    uri: text('uri'),
    icon: text('icon'),
    contacts: text('contacts').array(),
    tos: text('tos'),
    policy: text('policy'),
    softwareId: text('software_id'),
    softwareVersion: text('software_version'),
    softwareStatement: text('software_statement'),
    redirectUris: text('redirect_uris').array().notNull(),
    postLogoutRedirectUris: text('post_logout_redirect_uris').array(),
    backchannelLogoutUri: text('backchannel_logout_uri'),
    backchannelLogoutSessionRequired: boolean('backchannel_logout_session_required'),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method'),
    applicationType: text('application_type'),
    jwks: text('jwks'),
    jwksUri: text('jwks_uri'),
    grantTypes: text('grant_types').array(),
    responseTypes: text('response_types').array(),
    requirePKCE: boolean('require_pkce'),
    dpopBoundAccessTokens: boolean('dpop_bound_access_tokens').default(false),
    referenceId: text('reference_id'),
    metadata: jsonb('metadata'),
  },
  (t) => [index('oauth_client_user_idx').on(t.userId)],
);

export const oauthResource = pgTable('oauth_resource', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull().unique('oauth_resource_identifier_key'),
  name: text('name').notNull(),
  accessTokenTtl: integer('access_token_ttl'),
  refreshTokenTtl: integer('refresh_token_ttl'),
  signingAlgorithm: text('signing_algorithm'),
  signingKeyId: text('signing_key_id'),
  allowedScopes: text('allowed_scopes').array(),
  customClaims: jsonb('custom_claims'),
  dpopBoundAccessTokensRequired: boolean('dpop_bound_access_tokens_required').default(false),
  disabled: boolean('disabled').default(false),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
  policyVersion: integer('policy_version').default(0),
  metadata: jsonb('metadata'),
});

export const oauthClientResource = pgTable(
  'oauth_client_resource',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    resourceId: text('resource_id')
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: 'cascade' }),
    metadata: jsonb('metadata'),
    createdAt: tstz('created_at'),
  },
  (t) => [
    uniqueIndex('oauth_client_resource_uidx').on(t.clientId, t.resourceId),
    index('oauth_client_resource_resource_idx').on(t.resourceId),
  ],
);

export const oauthRefreshToken = pgTable(
  'oauth_refresh_token',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => session.id, { onDelete: 'set null' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    expiresAt: tstz('expires_at'),
    createdAt: tstz('created_at'),
    revoked: tstz('revoked'),
    rotatedAt: tstz('rotated_at'),
    rotationReplayResponse: text('rotation_replay_response'),
    rotationReplayExpiresAt: tstz('rotation_replay_expires_at'),
    authTime: tstz('auth_time'),
    confirmation: jsonb('confirmation'),
    scopes: text('scopes').array().notNull(),
  },
  (t) => [
    uniqueIndex('oauth_refresh_token_token_uidx').on(t.token),
    index('oauth_refresh_token_client_idx').on(t.clientId),
    index('oauth_refresh_token_session_idx').on(t.sessionId),
    index('oauth_refresh_token_user_idx').on(t.userId),
    index('oauth_refresh_token_code_idx').on(t.authorizationCodeId),
  ],
);

export const oauthAccessToken = pgTable(
  'oauth_access_token',
  {
    id: text('id').primaryKey(),
    token: text('token'),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => session.id, { onDelete: 'set null' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    refreshId: text('refresh_id').references(() => oauthRefreshToken.id, { onDelete: 'cascade' }),
    expiresAt: tstz('expires_at'),
    createdAt: tstz('created_at'),
    revoked: tstz('revoked'),
    confirmation: jsonb('confirmation'),
    scopes: text('scopes').array().notNull(),
  },
  (t) => [
    uniqueIndex('oauth_access_token_token_uidx').on(t.token),
    index('oauth_access_token_client_idx').on(t.clientId),
    index('oauth_access_token_session_idx').on(t.sessionId),
    index('oauth_access_token_user_idx').on(t.userId),
    index('oauth_access_token_code_idx').on(t.authorizationCodeId),
    index('oauth_access_token_refresh_idx').on(t.refreshId),
  ],
);

export const oauthConsent = pgTable(
  'oauth_consent',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    scopes: text('scopes').array().notNull(),
    createdAt: tstz('created_at'),
    updatedAt: tstz('updated_at'),
  },
  (t) => [
    index('oauth_consent_client_idx').on(t.clientId),
    index('oauth_consent_user_idx').on(t.userId),
  ],
);

/** Single-use `jti` of `private_key_jwt` client assertions (the plugin's replay check). */
export const oauthClientAssertion = pgTable(
  'oauth_client_assertion',
  {
    id: text('id').primaryKey(),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [index('oauth_client_assertion_expires_idx').on(t.expiresAt)],
);
