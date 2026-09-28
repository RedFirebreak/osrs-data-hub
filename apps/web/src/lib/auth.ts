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
import { getDb, schema, users } from '@hub/db';
import {
  avatarUrl,
  displayName,
  evaluateMembership,
  fetchCurrentUser,
  fetchOwnGuildMember,
  getLogger,
  isAdmin,
  restoreUser,
  type GuildPolicy,
} from '@hub/server';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import type { DiscordProfile } from 'better-auth/social-providers';
import { eq } from 'drizzle-orm';

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

  return betterAuth({
    appName: config.hubName,
    // APP_URL is origin-only (D-26); never derive URLs from request.url (NEXT-2).
    baseURL: config.appOrigin,
    basePath: '/api/auth',
    secret: config.authSecret,
    trustedOrigins: [config.appOrigin],
    database: drizzleAdapter(db, { provider: 'pg', schema, transaction: true }),
    socialProviders: {
      discord: {
        clientId: config.discord.clientId ?? '',
        clientSecret: config.discord.clientSecret ?? '',
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
            const [current] = await db
              .select({ status: users.status, offboardReason: users.offboardReason })
              .from(users)
              .where(eq(users.id, session.userId));
            // Admin offboarding is not undone by logging in (only membership reasons are, handoff §14.4).
            if (current?.status === 'grace' && current.offboardReason === 'admin') {
              throw new APIError('FORBIDDEN', {
                code: 'access_revoked',
                message: 'Your access was removed by an admin.',
              });
            }
            await db
              .update(users)
              .set({
                name: snap.name,
                image: snap.image,
                nickname: snap.nickname,
                roles: snap.roles,
                isAdmin: snap.isAdmin,
                lastVerifiedAt: new Date(),
                verifyFailures: 0,
              })
              .where(eq(users.id, session.userId));
            if (current?.status === 'grace') {
              // Back within the grace period: active again, hidden accounts visible again.
              await restoreUser(db, { userId: session.userId, actorLabel: 'login' });
            }
          },
        },
      },
    },
    disabledPaths: [
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
