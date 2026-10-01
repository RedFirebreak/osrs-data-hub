/**
 * Pure helpers for the admin pages (handoff §12 Admin): labels, API paths, the error text of a failed
 * admin request, and the query strings of the devices filter and the raw payload viewer. No React, no
 * browser APIs; unit-tested in admin-model.test.ts.
 *
 * Only `import type` from @hub/server and @hub/db: the admin client components import this module,
 * and a value import would pull the server packages into the browser bundle (NEXT-12).
 */
import type { OffboardReason, UserStatus } from '@hub/db';
import type { DeviceStatus, IngestMeta } from '@hub/server';
import type { FailureOptions } from '@/lib/api-client';
import { isUuidLike } from '@/lib/guards';

const DAY_MS = 24 * 60 * 60 * 1000;

// --- Navigation --------------------------------------------------------------------------------

/** Whether the admin tab `href` is the current page: exact for /admin (Users), else the prefix. */
export function isAdminTabActive(pathname: string | null, href: string): boolean {
  if (pathname === null) return false;
  if (href === '/admin') return pathname === '/admin';
  return pathname === href || pathname.startsWith(`${href}/`);
}

// --- Dates -------------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "29 Sep 2026" / "29 Sep 2026, 08:32 UTC" in UTC, built by hand: the text a server render and the
 * hydrating browser must agree on, so it can't depend on either side's Intl/CLDR data (month
 * abbreviations and separators differ between versions). Null for an invalid time.
 */
export function utcDateText(ms: number, withTime: boolean): string | null {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return null;
  const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (!withTime) return date;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

// --- Users -------------------------------------------------------------------------------------

/** Why a user is in grace, as the Users table says it. */
const OFFBOARD_REASON_LABELS: Readonly<Record<OffboardReason, string>> = {
  left_guild: 'Left the Discord server',
  lost_role: 'Lost the required role',
  admin: 'Offboarded by an admin',
  self_delete: 'Deleted their data',
};

/** The reason's label; "Unknown reason" for null or a value this version doesn't know. */
export function offboardReasonLabel(reason: string | null | undefined): string {
  if (reason && Object.hasOwn(OFFBOARD_REASON_LABELS, reason)) {
    return OFFBOARD_REASON_LABELS[reason as OffboardReason];
  }
  return 'Unknown reason';
}

export const USER_STATUS_LABELS: Readonly<Record<UserStatus, string>> = {
  active: 'Active',
  grace: 'Grace',
};

/**
 * Whole days until `graceUntil` (rounded up, so "ends in 3 hours" is 1 day), 0 once it has passed,
 * null without a date.
 */
export function graceDaysLeft(graceUntil: Date | string | null, now: Date): number | null {
  if (graceUntil === null) return null;
  const end = typeof graceUntil === 'string' ? Date.parse(graceUntil) : graceUntil.getTime();
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.ceil((end - now.getTime()) / DAY_MS));
}

/** "1 day" / "12 days". */
export function pluralDays(n: number): string {
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

/**
 * Which actions the Users table offers for a row. Nobody offboards themselves (the server refuses it
 * too). A user in grace can be restored; one in grace for a membership reason can also be offboarded
 * by an admin, which makes it stick when they log in again (D-35).
 */
export function userActions(row: {
  status: UserStatus;
  offboardReason: OffboardReason | null;
  isSelf: boolean;
}): { offboard: boolean; restore: boolean } {
  return {
    offboard: !row.isSelf && !(row.status === 'grace' && row.offboardReason === 'admin'),
    restore: row.status === 'grace',
  };
}

// --- Devices -----------------------------------------------------------------------------------

export type DeviceFilter = 'all' | DeviceStatus;

export const DEVICE_FILTERS: readonly { value: DeviceFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'outdated', label: 'Outdated' },
  { value: 'revoked', label: 'Revoked' },
];

/** `?show=` of the admin Devices page; anything unknown is 'all'. */
export function parseDeviceFilter(value: string | string[] | undefined): DeviceFilter {
  const v = Array.isArray(value) ? value[0] : value;
  return DEVICE_FILTERS.some((f) => f.value === v) ? (v as DeviceFilter) : 'all';
}

/** Why a device was revoked, from an admin's point of view. */
export function adminRevokedText(reason: string | null): string {
  switch (reason) {
    case 'user':
      return 'Revoked by its owner';
    case 'admin':
      return 'Revoked by an admin';
    case 'offboarding':
      return 'Revoked when its owner was offboarded';
    default:
      return 'Revoked';
  }
}

/**
 * The last 8 hex digits of a uuid, for tables ("f544a072"). Not the first 8: ids are uuidv7 (D-27),
 * whose leading digits are the creation time, so devices paired the same hour showed the same prefix.
 */
export function shortId(id: string): string {
  return id.replace(/-/g, '').slice(-8);
}

// --- Ingest ------------------------------------------------------------------------------------

/** What each HTTP status of an archived payload means (handoff §7.7). */
const HTTP_STATUS_LABELS: Readonly<Record<string, string>> = {
  '200': 'Accepted',
  '400': 'Bad request',
  '401': 'Unauthorized',
  '410': 'Decommissioned',
  '413': 'Too large',
  '429': 'Rate limited',
  '500': 'Server error',
  '503': 'Unavailable',
  pending: 'No status yet',
};

/** Label of a status key of getIngestHealth ('200', '503', …, 'pending'). */
export function httpStatusLabel(key: string): string {
  const known = HTTP_STATUS_LABELS[key];
  if (known) return known;
  if (/^2\d\d$/.test(key)) return 'Success';
  if (/^4\d\d$/.test(key)) return 'Client error';
  if (/^5\d\d$/.test(key)) return 'Server error';
  return 'Other';
}

export type StatusTone = 'ok' | 'client' | 'server' | 'pending';

/** The badge tone of a status key: 2xx ok, 4xx client, 5xx server, anything else pending. */
export function httpStatusTone(key: string): StatusTone {
  if (/^2\d\d$/.test(key)) return 'ok';
  if (/^4\d\d$/.test(key)) return 'client';
  if (/^5\d\d$/.test(key)) return 'server';
  return 'pending';
}

/** Status keys in numeric order, 'pending' (and anything non-numeric) last. */
export function sortStatusKeys(keys: Iterable<string>): string[] {
  return [...new Set(keys)].sort((a, b) => {
    const na = /^\d+$/.test(a) ? Number(a) : Number.POSITIVE_INFINITY;
    const nb = /^\d+$/.test(b) ? Number(b) : Number.POSITIVE_INFINITY;
    return na - nb || a.localeCompare(b);
  });
}

/**
 * A prom-client counter's values summed per value of `label`, e.g. hub_ingest_payloads_total by
 * `status` → `{ '200': 812, '401': 3 }`. Series without the label or with no count are left out.
 */
export function countsByLabel(
  values: readonly {
    value: number;
    labels: Readonly<Partial<Record<string, string | number>>>;
  }[],
  label: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { value, labels } of values) {
    const key = labels[label];
    if (key === undefined || !Number.isFinite(value) || value <= 0) continue;
    out[String(key)] = (out[String(key)] ?? 0) + value;
  }
  return out;
}

/** Sum of a StatusCounts record. */
export function sumCounts(counts: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const n of Object.values(counts)) total += n;
  return total;
}

/** 812 → "812 B", 12_345 → "12.1 KB", 3_500_000 → "3.3 MB" (1 KB = 1024 B). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** raw_payloads.meta.ignored in words (IgnoredReason, @hub/server; D-29). */
const IGNORED_REASONS: Readonly<Record<string, string>> = {
  no_identity: 'no player in it (login screen, client start)',
  blocked: 'player blocked from this account',
};

/**
 * A short description of an archived payload's outcome (raw_payloads.meta): what was stored, what was
 * skipped, and why it was ignored or failed. Unknown or malformed fields are left out.
 */
export function describeIngestMeta(meta: IngestMeta | null | undefined): string[] {
  if (!meta || typeof meta !== 'object') return [];
  const out: string[] = [];
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  const inserted = num(meta.inserted);
  if (inserted !== null) out.push(plural(inserted, 'event stored', 'events stored'));
  const duplicates = num(meta.duplicates);
  if (duplicates !== null) out.push(plural(duplicates, 'duplicate', 'duplicates'));
  if (Array.isArray(meta.skippedSections) && meta.skippedSections.length > 0) {
    out.push(plural(meta.skippedSections.length, 'section skipped', 'sections skipped'));
  }
  const skippedEvents = num(meta.skippedEvents);
  if (skippedEvents !== null) out.push(plural(skippedEvents, 'event skipped', 'events skipped'));
  if (meta.stale === true) out.push('stale snapshot');
  if (meta.special === true) out.push('special world');
  if (typeof meta.xpGuard === 'string') out.push(`XP drop in ${meta.xpGuard}`);
  if (typeof meta.ignored === 'string') {
    out.push(`ignored: ${IGNORED_REASONS[meta.ignored] ?? meta.ignored}`);
  }
  if (typeof meta.error === 'string') out.push(`error: ${meta.error}`);
  return out;
}

// --- Raw payload viewer ------------------------------------------------------------------------

/** Rows per page of the raw payload viewer. */
export const RAW_PAYLOAD_PAGE_SIZE = 50;

/** Statuses offered by the viewer's status filter. */
export const RAW_PAYLOAD_STATUS_OPTIONS: readonly string[] = [
  '200',
  '400',
  '401',
  '500',
  '503',
  'pending',
];

export interface RawPayloadQuery {
  deviceId?: string;
  status?: number | 'pending';
  /** Keyset cursor: rows older than this one. */
  before?: { receivedAt: Date; id: string };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The viewer's `?device=&status=&before=&beforeId=` (a page's searchParams). A value that isn't
 * well-formed is ignored rather than refused: it's a filter the admin can change on the page.
 * `before` needs both an ISO time and the row's uuid.
 */
export function parseRawPayloadQuery(
  params: Readonly<Record<string, string | string[] | undefined>>,
): RawPayloadQuery {
  const query: RawPayloadQuery = {};
  const device = first(params.device);
  if (device && isUuidLike(device)) query.deviceId = device.toLowerCase();
  const status = first(params.status);
  if (status === 'pending') query.status = 'pending';
  else if (status && /^[1-5]\d\d$/.test(status)) query.status = Number(status);
  const before = first(params.before);
  const beforeId = first(params.beforeId);
  if (before && beforeId && isUuidLike(beforeId)) {
    const at = new Date(before);
    if (Number.isFinite(at.getTime())) query.before = { receivedAt: at, id: beforeId };
  }
  return query;
}

/** The viewer's URL for these filters (and cursor), e.g. `/admin/payloads?status=503`. */
export function rawPayloadsHref(query: RawPayloadQuery): string {
  const params = new URLSearchParams();
  if (query.deviceId) params.set('device', query.deviceId);
  if (query.status !== undefined) params.set('status', String(query.status));
  if (query.before) {
    params.set('before', query.before.receivedAt.toISOString());
    params.set('beforeId', query.before.id);
  }
  const qs = params.toString();
  return qs ? `/admin/payloads?${qs}` : '/admin/payloads';
}

/**
 * The body of an archived payload for display: pretty-printed JSON (which also decodes Gson's
 * `'`-style escapes, PLUGIN-7), or the text as stored when it isn't valid JSON.
 */
export function prettyPayload(body: string): { text: string; json: boolean } {
  try {
    return { text: JSON.stringify(JSON.parse(body) as unknown, null, 2), json: true };
  } catch {
    return { text: body, json: false };
  }
}

// --- Audit log ---------------------------------------------------------------------------------

/** Entries per "load more" of the audit log. */
export const AUDIT_PAGE_SIZE = 50;

export { auditActionLabel } from './audit-labels';

const META_VALUE_MAX = 80;

function metaText(value: unknown): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (value === undefined) text = 'undefined';
  else text = JSON.stringify(value) ?? String(value);
  return text.length > META_VALUE_MAX ? `${text.slice(0, META_VALUE_MAX - 1)}…` : text;
}

/**
 * An audit entry's meta as `[key, text]` pairs for display: an object's entries (nested values as
 * JSON), each cut to 80 characters; any other non-null value as one `value` pair.
 */
export function auditMetaEntries(meta: unknown): [string, string][] {
  if (meta === null || meta === undefined) return [];
  if (typeof meta === 'object' && !Array.isArray(meta)) {
    return Object.entries(meta as Record<string, unknown>).map(([k, v]) => [k, metaText(v)]);
  }
  return [['value', metaText(meta)]];
}

// --- API ---------------------------------------------------------------------------------------

/** POST path of an admin user action. */
export function adminUserActionPath(userId: string, action: 'offboard' | 'restore'): string {
  return `/api/app/admin/users/${encodeURIComponent(userId)}/${action}`;
}

/** The admin API path of one service key (D-88). */
export function adminServiceKeyPath(keyId: string): string {
  return `/api/app/admin/service-keys/${encodeURIComponent(keyId)}`;
}

/** DELETE path that revokes any device. */
export function adminDevicePath(deviceId: string): string {
  return `/api/app/admin/devices/${encodeURIComponent(deviceId)}`;
}

/** GET path of one archived body (its primary key is id + received_at). */
export function rawPayloadApiPath(id: string, receivedAt: string): string {
  return `/api/app/admin/raw-payloads/${encodeURIComponent(id)}?receivedAt=${encodeURIComponent(receivedAt)}`;
}

/** GET path of an older page of the audit log. */
export function auditLogApiPath(before: number, limit = AUDIT_PAGE_SIZE): string {
  return `/api/app/admin/audit-log?before=${before}&limit=${limit}`;
}

export const DECOMMISSION_API_PATH = '/api/app/admin/decommission';

export const GUILD_FEED_API_PATH = '/api/app/admin/guild-feed';

/**
 * Whether the text typed into the decommission confirmation is the hub name. Both sides are
 * trimmed: HUB_NAME is cut to 64 characters after trimming, and that cut can end on a space nobody
 * types (the page shows the name without it).
 */
export function decommissionConfirmMatches(typed: string | undefined, hubName: string): boolean {
  const expected = hubName.trim();
  return typed !== undefined && expected !== '' && typed.trim() === expected;
}

/**
 * How a failed admin request is told (failureMessage, lib/api-client.ts): `fallback` when the hub
 * gives no better text, and the admin pages' wording for 403 and 404.
 */
export function adminFailure(fallback: string): FailureOptions {
  return {
    fallback,
    forbidden: 'Only admins can do this.',
    notFound: 'It no longer exists. Reload the page.',
  };
}
