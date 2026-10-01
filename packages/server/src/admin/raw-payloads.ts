/**
 * Admin → raw payload viewer (handoff §12): archived ingest bodies, kept RAW_PAYLOAD_RETENTION_HOURS.
 * The list never carries bodies (they can hold coordinates and inventories); one body is fetched on
 * demand and the view can be audited.
 */
import { rawPayloads, type Db } from '@hub/db';
import { and, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { audit } from '../audit';
import type { IngestMeta } from '../ingest/types';
import { clampLimit } from '../paging';
import { isUuid } from '../uuid';
import { AdminError } from './errors';

export const RAW_PAYLOAD_PAGE_MAX = 200;

export interface RawPayloadRow {
  id: string;
  receivedAt: Date;
  deviceId: string | null;
  accountId: number | null;
  /** HTTP status returned; null while processing (or when recording it failed). */
  status: number | null;
  pluginVersion: string | null;
  meta: IngestMeta | null;
  /** Body size in bytes. */
  size: number;
}

/** Keyset position: rows strictly older than this (received_at, then id, descending). */
export interface RawPayloadCursor {
  receivedAt: Date;
  id: string;
}

/**
 * Archived payloads, newest first, without bodies. Filters: a device, and a status (a number, or
 * 'pending' for rows without one). `before` pages: pass the last row's { receivedAt, id } (an
 * invalid date, or an id that isn't a uuid, throws AdminError 'invalid'). `limit` is clamped to
 * 1…RAW_PAYLOAD_PAGE_MAX. A malformed device id matches nothing.
 */
export async function listRawPayloads(
  db: Db,
  opts: {
    deviceId?: string;
    status?: number | 'pending';
    limit: number;
    before?: RawPayloadCursor;
  },
): Promise<RawPayloadRow[]> {
  if (opts.deviceId !== undefined && !isUuid(opts.deviceId)) return [];
  const rows = await db
    .select({
      id: rawPayloads.id,
      receivedAt: rawPayloads.receivedAt,
      deviceId: rawPayloads.deviceId,
      accountId: rawPayloads.accountId,
      status: rawPayloads.status,
      pluginVersion: rawPayloads.pluginVersion,
      meta: rawPayloads.meta,
      size: sql<number>`octet_length(${rawPayloads.body})`,
    })
    .from(rawPayloads)
    .where(
      and(
        opts.deviceId !== undefined ? eq(rawPayloads.deviceId, opts.deviceId) : undefined,
        statusFilter(opts.status),
        beforeFilter(opts.before),
      ),
    )
    .orderBy(desc(rawPayloads.receivedAt), desc(rawPayloads.id))
    .limit(clampLimit(opts.limit, RAW_PAYLOAD_PAGE_MAX, RAW_PAYLOAD_PAGE_MAX));
  return rows.map((r) => ({ ...r, meta: (r.meta ?? null) as IngestMeta | null }));
}

/**
 * One archived body as stored (text, possibly invalid JSON), or null when it doesn't exist (or has
 * aged out). Every body returned is audited as 'raw_payload.viewed' by `actorUserId`: bodies can
 * hold data the player shares with nobody (locations, inventories).
 */
export async function getRawPayload(
  db: Db,
  opts: { id: string; receivedAt: Date; actorUserId: string },
): Promise<string | null> {
  if (!isUuid(opts.id) || Number.isNaN(opts.receivedAt.getTime())) return null;
  const [row] = await db
    .select({ body: rawPayloads.body, deviceId: rawPayloads.deviceId })
    .from(rawPayloads)
    .where(and(eq(rawPayloads.id, opts.id), eq(rawPayloads.receivedAt, opts.receivedAt)));
  if (!row) return null;
  await audit(db, {
    actorUserId: opts.actorUserId,
    action: 'raw_payload.viewed',
    targetType: 'raw_payload',
    targetId: opts.id,
    meta: { deviceId: row.deviceId, receivedAt: opts.receivedAt.toISOString() },
  });
  return row.body;
}

function statusFilter(status: number | 'pending' | undefined): SQL | undefined {
  if (status === undefined) return undefined;
  if (status === 'pending') return isNull(rawPayloads.status);
  // Not a status the column can hold: match nothing instead of a 22P02/22003 from Postgres.
  if (!Number.isInteger(status) || status < 0 || status > 32767) return sql`false`;
  return eq(rawPayloads.status, status);
}

function beforeFilter(before: RawPayloadCursor | undefined): SQL | undefined {
  if (before === undefined) return undefined;
  // An unparseable date or id (a tampered `?before=`) is the caller's error, not a 500 from
  // toISOString or a 22P02 from Postgres.
  if (Number.isNaN(before.receivedAt.getTime()) || !isUuid(before.id)) {
    throw new AdminError('invalid', 'invalid cursor');
  }
  return or(
    lt(rawPayloads.receivedAt, before.receivedAt),
    and(eq(rawPayloads.receivedAt, before.receivedAt), lt(rawPayloads.id, before.id)),
  );
}
