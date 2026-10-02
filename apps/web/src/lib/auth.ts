/**
 * Better Auth: Discord sign-in, database sessions, and the guild gate (handoff §5, D-9).
 *
 * The gate: our `getUserInfo` override is the only step that sees the fresh Discord token, so it
 * fetches the member object there and hands the verdict to `user.validateUserInfo`, which rejects
 * BEFORE any row is written (AUTH-6) and redirects to /login?error=<code>. The member snapshot reaches
 * the database hooks through request state (input:false fields can't come from the provider, AUTH-5).
 *
 * Created lazily: `next build` imports route modules without runtime secrets.
 */
import { defineRequestState } from '@better-auth/core/context';
import { getConfig, type HubConfig } from '@hub/core';
import { getDb, pgErrorCode, safeDbErrorMessage, schema } from '@hub/db';
import {
  avatarUrl,
  displayName,
  evaluateMembership,
  fetchCurrentUser,
  fetchOwnGuildMember,
  getLogger,
  isAdmin,
  recordSignIn,
  type GuildPolicy,
  type Logger,
} from '@hub/server';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import type { DiscordProfile } from 'better-auth/social-providers';

/** Header our route handler sets from X-Forwarded-For (TRUST_PROXY_HOPS) for Better Auth's limiter. */
export const CLIENT_IP_HEADER = 'x-hub-client-ip';

type GuildCheck = 'ok' | 'not_member' | 'missing_role' | 'discord_unavailable';

interface MemberSnapshot {
  discordId: string;
  name: string;
  nickname: string | null;
  image: string;
  roles: string[];
  isAdmin: boolean;
}

/** Request-scoped channel: getUserInfo (has the token) → database hooks (don't). */
const memberSnapshot = defineRequestState<MemberSnapshot | null>(() => null);

const NO_TOKENS = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
};

/**
 * Better Auth's own log lines, through pino: the message, and for each extra argument only what is
 * safe to keep. Its default logger prints raw errors to stderr, and a failed session lookup carries
 * the session token among the query's bound parameters (AUTH-13, DB-3). An error becomes its name,
 * SQLSTATE and Postgres message; anything else only its type (or an object's keys).
 */
export function betterAuthLogger(log: Logger): NonNullable<BetterAuthOptions['logger']> {
  return {
    level: 'warn',
    log(level, message, ...args: unknown[]) {
      log[level]({ source: 'better-auth', details: args.map(describeLogArg) }, message);
    },
  };
}

function describeLogArg(arg: unknown): unknown {
  if (arg instanceof Error) {
    return { name: arg.name, pgCode: pgErrorCode(arg), error: safeDbErrorMessage(arg) };
  }
  if (arg !== null && typeof arg === 'object') return { keys: Object.keys(arg).slice(0, 20) };
  return typeof arg;
}

export function guildPolicy(config: HubConfig): GuildPolicy {
  return {
    guildId: config.discord.guildId ?? '',
    requiredRoleIds: config.discord.requiredRoleIds,
    adminRoleIds: config.discord.adminRoleIds,
    adminUserIds: config.discord.adminUserIds,
  };
}

function createAuth(config: HubConfig) {
  const { db } = getDb(config.databaseUrl);
  const policy = guildPolicy(config);
  const log = getLogger();
  const { authorizeUrl } = config.discord;
  if (authorizeUrl) {
    log.warn(
      { authorizeUrl },
      'sign-in sends the browser to DISCORD_AUTHORIZE_URL instead of Discord: local development only (D-101)',
    );
  }

  return betterAuth({
    appName: config.hubName,
    // APP_URL is origin-only (D-26); never derive URLs from request.url (NEXT-2).
    baseURL: config.appOrigin,
    basePath: '/api/auth',
    secret: config.authSecret,
    trustedOrigins: [config.appOrigin],
    logger: betterAuthLogger(log),
    database: drizzleAdapter(db, { provider: 'pg', schema, transaction: true }),
    socialProviders: {
      discord: {
        clientId: config.discord.clientId ?? '',
        clientSecret: config.discord.clientSecret ?? '',
        // Only the page the browser is sent to (D-101). The token exchange and the membership
        // lookups below still go to discord.com: a stand-in has to answer those inside the
        // process, as e2e/mock-discord.mjs does.
        ...(authorizeUrl ? { authorizationEndpoint: authorizeUrl } : {}),
        // Exactly `identify guilds.members.read`: the provider adds `email` unless told not to (AUTH-3).
        disableDefaultScope: true,
        scope: ['identify', 'guilds.members.read'],
        async getUserInfo(tokens) {
          if (!tokens.accessToken) return null;
          const me = await fetchCurrentUser(tokens.accessToken);
          if (!me) return null;
          const lookup = await fetchOwnGuildMember(tokens.accessToken, policy.guildId);
          const verdict = evaluateMembership(lookup, policy);
          let check: GuildCheck;
          if (verdict.kind === 'ok') {
            const member = verdict.member;
            check = 'ok';
            await memberSnapshot.set({
              discordId: me.id,
              name: displayName(me, member),
              nickname: member.nick ?? null,
              image: avatarUrl(me, policy.guildId, member),
              roles: member.roles,
              isAdmin: isAdmin(me.id, member.roles, policy),
            });
          } else if (verdict.kind === 'error') {
            check = 'discord_unavailable';
            log.warn({ reason: verdict.reason }, 'discord membership check failed at sign-in');
          } else {
            check = verdict.kind;
          }
          return {
            user: {
              name: displayName(me),
              // No email scope; Better Auth requires one (AUTH-3). The .invalid TLD is reserved.
              email: `${me.id}@discord.invalid`,
              emailVerified: false,
              image: avatarUrl(me, policy.guildId),
            },
            // Keep Discord's `id` in data: Better Auth derives the account subject from it.
            data: { ...me, hubGuildCheck: check } as unknown as DiscordProfile,
          };
        },
      },
    },
    user: {
      modelName: 'users',
      // Keep in step with packages/db/src/schema/auth.ts (AUTH-1).
      additionalFields: {
        discordId: { type: 'string', required: false, unique: true, input: false },
        nickname: { type: 'string', required: false, input: false },
        roles: { type: 'string[]', required: true, defaultValue: [], input: false },
        isAdmin: { type: 'boolean', required: true, defaultValue: false, input: false },
        status: { type: ['active', 'grace'], required: true, defaultValue: 'active', input: false },
        graceUntil: { type: 'date', required: false, input: false },
        offboardReason: {
          type: ['left_guild', 'lost_role', 'admin', 'self_delete'],
          required: false,
          input: false,
        },
        lastVerifiedAt: { type: 'date', required: false, input: false },
        verifyFailures: { type: 'number', required: true, defaultValue: 0, input: false },
      },
      validateUserInfo: ({ source }) => {
        if (source.method !== 'oauth' || source.oauth?.providerId !== 'discord') {
          return { error: 'unsupported_sign_in', errorDescription: 'Sign in with Discord.' };
        }
        const check = (source.oauth.profile as { hubGuildCheck?: GuildCheck } | undefined)
          ?.hubGuildCheck;
        switch (check) {
          case 'ok':
            return;
          case 'not_member':
            return {
              error: 'not_guild_member',
              errorDescription: `Not a member of ${config.discord.guildName}`,
            };
          case 'missing_role':
            return {
              error: 'missing_role',
              errorDescription: `Missing a required role in ${config.discord.guildName}`,
            };
          default:
            return {
              error: 'discord_unavailable',
              errorDescription: 'Could not verify guild membership, try again',
            };
        }
      },
    },
    // Database sessions; cookieCache stays OFF so revocation is instant (AUTH-8).
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    account: { accountLinking: { enabled: false } },
    databaseHooks: {
      account: {
        // The hub never needs the user's Discord token after the gate (AUTH-4).
        create: { before: async (acc) => ({ data: { ...acc, ...NO_TOKENS } }) },
        update: { before: async (acc) => ({ data: { ...acc, ...NO_TOKENS } }) },
      },
      user: {
        create: {
          before: async (user) => {
            const snap = await memberSnapshot.get();
            if (!snap)
              throw new APIError('FORBIDDEN', {
                code: 'not_guild_member',
                message: 'Membership not verified',
              });
            return {
              data: {
                ...user,
                name: snap.name,
                image: snap.image,
                discordId: snap.discordId,
                nickname: snap.nickname,
                roles: snap.roles,
                isAdmin: snap.isAdmin,
                status: 'active',
                graceUntil: null,
                offboardReason: null,
                lastVerifiedAt: new Date(),
                verifyFailures: 0,
              },
            };
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const snap = await memberSnapshot.get();
            if (!snap) return;
            // Fresh member data; back within the grace period: active again, hidden accounts
            // visible again. Admin offboarding is not undone by logging in (D-35, handoff §14.4).
            if ((await recordSignIn(db, session.userId, snap)) === 'revoked') {
              throw new APIError('FORBIDDEN', {
                code: 'access_revoked',
                message: 'Your access was removed by an admin.',
              });
            }
          },
        },
      },
    },
    // Endpoints the hub doesn't use. /list-sessions would hand every session token to browser
    // JavaScript.
    disabledPaths: [
      '/list-sessions',
      '/update-user',
      '/change-email',
      '/delete-user',
      '/link-social',
      '/unlink-account',
      '/get-access-token',
      '/refresh-token',
      '/account-info',
      '/sign-up/email',
      '/sign-in/email',
    ],
    onAPIError: { errorURL: `${config.appOrigin}/login` },
    advanced: {
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    plugins: [nextCookies()], // must stay last
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = Auth['$Infer']['Session'];

const g = globalThis as unknown as { __hubAuth?: Auth };

/** Process-wide Better Auth instance (globalThis: route handlers and RSC are separate module instances, NEXT-3). */
export function getAuth(): Auth {
  g.__hubAuth ??= createAuth(getConfig());
  return g.__hubAuth;
}
