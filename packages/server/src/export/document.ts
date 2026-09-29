/**
 * "Download my data" (handoff §14, §16, D-79): one JSON document with everything the hub keeps about
 * a user that the user may see, streamed in batches.
 */
import type { Viewer } from '@hub/core';
import { skills, type Db } from '@hub/db';
import { loadVisibleAccounts, type AccountWithAccess } from '../accounts/load';
import { audit } from '../audit';
import { accountDocument, type AccountExportContext } from './accounts';
import { jsonArray, jsonElements, jsonObject, streamed, type Field } from './json';
import {
  apiKeysSection,
  auditPages,
  devicesSection,
  loadUserRow,
  settingsSection,
  sharingSection,
  signInSessionsSection,
  auditIds,
  wireAuditFor,
  wireUser,
  type UserRow,
} from './profile';

/** `format` of the document. */
export const EXPORT_FORMAT = 'osrs-data-hub-export';
/** `version` of the document; additive changes keep it. */
export const EXPORT_VERSION = 1;
/** Rows per query of a history: large enough to be fast, small enough to stream. */
export const EXPORT_BATCH_SIZE = 5000;

/** What the document says it leaves out, and how to read it. */
export const EXPORT_NOTES: readonly string[] = [
  'Times are ISO-8601 in UTC. Keys are snake_case, named like the hub API (/docs/api); an event\'s "data" is the event exactly as your plugin sent it.',
  'Accounts: every account you own or play on (as a contributor, not blocked) that you can see today, with only the sharing categories you can see today (listed per account in "categories"). Accounts hidden while their owner is away are only included for admins.',
  'XP: "xp_samples" is the 5-minute detail the hub still keeps; "xp_daily" is the last XP of each UTC day before that.',
  'Not included: the raw plugin messages the hub keeps for a few days for troubleshooting (admins only), and anything about other people beyond the names the hub shows you. In "audit", other people\'s ids are replaced by "[redacted]"; the name of whoever acted is kept.',
  'Data that arrives while the export runs may or may not be in it.',
];

export interface ExportOptions {
  /** The time the document is made at (presence, key status, `generated_at`). Default: now. */
  now?: Date;
  /** Rows per history query (default EXPORT_BATCH_SIZE). */
  batchSize?: number;
  /** Written as `hub`: the hub's name and its APP_URL origin. Left out when not given. */
  hub?: { name: string; url: string };
}

/** What the audit entry records: counts only. */
export interface ExportSummary {
  accounts: number;
}

/**
 * The user's data export (D-79) as JSON text pieces; concatenated, they are one valid JSON document:
 * `format`, `version`, `generated_at`, `hub`, `notes`, `user`, `settings`, `devices`, `api_keys`,
 * `sign_in_sessions`, `sharing`, `audit` and `accounts` (see accounts.ts and profile.ts). Nothing is
 * read before the first piece is asked for, and every history is read in keyset-paginated batches of
 * `batchSize` rows when the consumer reaches it, so neither a table nor an account's history is ever
 * held in memory whole, and a consumer that stops (a cancelled download: `return()`) stops the
 * queries. No transaction spans the export: a long download must not hold one open (it would block
 * the retention jobs' chunk drops, and everyone behind them).
 *
 * Before the first piece it audits `user.exported` (actor and target: the user; meta: counts only).
 * Accounts are those the user owns or contributes to (a non-blocked link) and can see today
 * (loadVisibleAccounts: resolveAccess, as the UI), by name. Throws when the user doesn't exist.
 */
export async function* exportUserData(
  db: Db,
  userId: string,
  opts: ExportOptions = {},
): AsyncGenerator<string, void, undefined> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? EXPORT_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError('exportUserData: batchSize must be a positive integer');
  }
  const user = await loadUserRow(db, userId);
  if (!user) throw new Error('exportUserData: unknown user');
  const viewer: Viewer = { userId, status: user.status, isAdmin: user.isAdmin };
  const accounts = await exportedAccounts(db, viewer);
  const summary: ExportSummary = { accounts: accounts.length };
  await audit(db, {
    actorUserId: userId,
    action: 'user.exported',
    targetType: 'user',
    targetId: userId,
    meta: { ...summary },
  });
  const ctx: AccountExportContext = {
    db,
    userId,
    now,
    batchSize,
    skillNames: await loadSkillNames(db),
  };
  yield* jsonObject(documentFields(ctx, { user, viewer, accounts, hub: opts.hub }));
}

/** The document's fields in order; each section is read when the writer reaches it. */
async function* documentFields(
  ctx: AccountExportContext,
  d: {
    user: UserRow;
    viewer: Viewer;
    accounts: readonly AccountWithAccess[];
    hub: ExportOptions['hub'];
  },
): AsyncGenerator<Field> {
  const { db, userId, now, batchSize } = ctx;
  yield ['format', EXPORT_FORMAT];
  yield ['version', EXPORT_VERSION];
  yield ['generated_at', now.toISOString()];
  yield ['hub', d.hub ? { name: d.hub.name, url: d.hub.url } : undefined];
  yield ['notes', EXPORT_NOTES];
  yield ['user', wireUser(d.user)];
  yield ['settings', await settingsSection(db, userId)];
  yield ['devices', await devicesSection(db, userId)];
  yield ['api_keys', await apiKeysSection(db, userId, now)];
  yield ['sign_in_sessions', await signInSessionsSection(db, userId)];
  yield ['sharing', await sharingSection(db, userId, d.viewer, d.accounts)];
  const ids = await auditIds(db, userId);
  yield [
    'audit',
    streamed(() => jsonArray(auditPages(db, userId, batchSize), wireAuditFor(userId, ids))),
  ];
  yield ['accounts', streamed(() => jsonElements(d.accounts, (e) => accountDocument(ctx, e)))];
}

/** The accounts in the export: visible to the user today, and theirs (owner or contributor). */
async function exportedAccounts(db: Db, viewer: Viewer): Promise<AccountWithAccess[]> {
  const visible = await loadVisibleAccounts(db, viewer);
  return visible
    .filter((e) => e.access.relation === 'owner' || e.access.relation === 'contributor')
    .sort(
      (a, b) =>
        a.account.name.localeCompare(b.account.name, 'en', { sensitivity: 'base' }) ||
        a.account.publicId.localeCompare(b.account.publicId),
    );
}

async function loadSkillNames(db: Db): Promise<Map<number, string>> {
  const rows = await db.select({ id: skills.id, name: skills.name }).from(skills);
  return new Map(rows.map((r) => [r.id, r.name]));
}
