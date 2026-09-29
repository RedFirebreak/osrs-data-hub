/**
 * Admin → Ingest health (handoff §12): payloads per minute by status, totals, skipped sections and
 * events, plugin versions and noisy devices, all from raw_payloads (kept RAW_PAYLOAD_RETENTION_HOURS)
 * and devices.
 *
 * raw_payloads only holds bodies that got past auth, the version gate, the size cap and the rate
 * limit, so rejected 401/400-version/413/429 requests are not in these numbers: the Prometheus
 * counters (hub_ingest_payloads_total by status) have them, and the per-minute series takes them
 * from the process's in-memory count (`rejected`, D-83) when the caller hands it over.
 */
import { compareVersions, parsePluginVersion } from '@hub/core';
import { devices, users, type Db } from '@hub/db';
import { eq, inArray, isNull, sql } from 'drizzle-orm';
import type { RecentMinuteCounts } from '../recent-counts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Minutes in the per-minute series (the current, partial minute is the last one). */
export const HEALTH_MINUTES = 60;
const NOISY_DEVICES = 10;
const TOP_SKIPPED_SECTIONS = 10;

/** Payload counts keyed by the HTTP status returned ('200', '400', '503', …); 'pending' = no status yet. */
export type StatusCounts = Record<string, number>;

export interface MinuteCounts {
  /** Start of the minute. */
  minute: Date;
  /** Archived payloads (raw_payloads). */
  total: number;
  byStatus: StatusCounts;
  /**
   * Responses whose body was never archived (401, 410, 413, 429, …), by status, from this process's
   * in-memory count (D-83): empty before the web process started, and without `rejected` handed in.
   */
  rejected: StatusCounts;
}

export interface SkippedTotals {
  /** Sections dropped by lenient parsing. */
  sections: number;
  /** Malformed or over-cap events dropped. */
  events: number;
  /** Payloads that had anything skipped. */
  payloads: number;
}

export interface NoisyDevice {
  deviceId: string;
  /** Archived payloads in the last hour. */
  payloads: number;
  /** Of those, answered with a status other than 200. */
  errors: number;
  label: string | null;
  pluginVersion: string | null;
  revokedAt: Date | null;
  /** Null when the device no longer exists (its user was deleted). */
  user: { id: string; name: string } | null;
}

export interface IngestHealth {
  now: Date;
  /** HEALTH_MINUTES entries, oldest first, zero-filled. */
  perMinute: MinuteCounts[];
  lastHour: StatusCounts;
  last24h: StatusCounts;
  skipped: { lastHour: SkippedTotals; last24h: SkippedTotals };
  /** The section paths skipped most often in the last 24 h. */
  topSkippedSections: { path: string; count: number }[];
  /** Non-revoked devices per reported plugin version, newest version first (null = never sent). */
  pluginVersions: { version: string | null; devices: number }[];
  /** The top devices by payloads in the last hour. */
  noisyDevices: NoisyDevice[];
}

/**
 * The ingest health page's numbers at `now`: the last HEALTH_MINUTES minutes per minute and status
 * (windows end at `now`), status totals for the last hour and 24 h, skipped sections/events from
 * raw_payloads.meta (skippedSections, skippedEvents), plugin versions of non-revoked devices, and
 * the ten devices that sent the most payloads in the last hour.
 */
export async function getIngestHealth(
  db: Db,
  opts: { now?: Date; rejected?: RecentMinuteCounts } = {},
): Promise<IngestHealth> {
  const now = opts.now ?? new Date();
  const [perMinute, totals, skipped, topSkippedSections, pluginVersions, noisyDevices] =
    await Promise.all([
      loadPerMinute(db, now, opts.rejected),
      loadStatusTotals(db, now),
      loadSkipped(db, now),
      loadTopSkippedSections(db, now),
      loadPluginVersions(db),
      loadNoisyDevices(db, now),
    ]);
  return { now, perMinute, ...totals, skipped, topSkippedSections, pluginVersions, noisyDevices };
}

const STATUS_KEY = sql`coalesce(status::text, 'pending')`;

function iso(d: Date): string {
  return d.toISOString();
}

async function loadPerMinute(
  db: Db,
  now: Date,
  rejected: RecentMinuteCounts | undefined,
): Promise<MinuteCounts[]> {
  const lastMinute = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  const from = lastMinute - (HEALTH_MINUTES - 1) * MINUTE_MS;
  // Epoch ms, not the timestamp: drizzle hands raw timestamptz values over as strings.
  const res = await db.execute<{ minute_ms: number; status: string; n: number }>(sql`
    SELECT (extract(epoch FROM time_bucket(interval '1 minute', received_at)) * 1000)::bigint
             AS minute_ms,
           ${STATUS_KEY} AS status,
           count(*)::int AS n
    FROM raw_payloads
    WHERE received_at >= ${iso(new Date(from))}::timestamptz
      AND received_at <= ${iso(now)}::timestamptz
    GROUP BY 1, 2`);
  // The same minutes (the last one is the minute of `now`), oldest first.
  const rejectedSeries = rejected?.series(now, HEALTH_MINUTES) ?? [];
  const series: MinuteCounts[] = Array.from({ length: HEALTH_MINUTES }, (_, i) => ({
    minute: new Date(from + i * MINUTE_MS),
    total: 0,
    byStatus: {},
    rejected: rejectedSeries[i]?.byKey ?? {},
  }));
  for (const row of res.rows) {
    const bucket = series[Math.round((row.minute_ms - from) / MINUTE_MS)];
    if (!bucket) continue;
    bucket.total += row.n;
    bucket.byStatus[row.status] = (bucket.byStatus[row.status] ?? 0) + row.n;
  }
  return series;
}

async function loadStatusTotals(
  db: Db,
  now: Date,
): Promise<{ lastHour: StatusCounts; last24h: StatusCounts }> {
  const res = await db.execute<{ status: string; hour: number; day: number }>(sql`
    SELECT ${STATUS_KEY} AS status,
           (count(*) FILTER (WHERE received_at > ${iso(new Date(now.getTime() - HOUR_MS))}::timestamptz))::int AS hour,
           count(*)::int AS day
    FROM raw_payloads
    WHERE received_at > ${iso(new Date(now.getTime() - DAY_MS))}::timestamptz
      AND received_at <= ${iso(now)}::timestamptz
    GROUP BY 1`);
  const lastHour: StatusCounts = {};
  const last24h: StatusCounts = {};
  for (const row of res.rows) {
    if (row.hour > 0) lastHour[row.status] = row.hour;
    last24h[row.status] = row.day;
  }
  return { lastHour, last24h };
}

/** Per-payload skipped counts from meta; anything that isn't the expected JSON type counts as 0. */
const SKIPPED_ROWS = sql`
  SELECT received_at,
         CASE WHEN jsonb_typeof(meta->'skippedSections') = 'array'
              THEN jsonb_array_length(meta->'skippedSections') ELSE 0 END AS sections,
         CASE WHEN jsonb_typeof(meta->'skippedEvents') = 'number'
              THEN (meta->>'skippedEvents')::numeric ELSE 0 END AS events
  FROM raw_payloads`;

async function loadSkipped(
  db: Db,
  now: Date,
): Promise<{ lastHour: SkippedTotals; last24h: SkippedTotals }> {
  const hourAgo = sql`${iso(new Date(now.getTime() - HOUR_MS))}::timestamptz`;
  const res = await db.execute<{
    sh: number;
    eh: number;
    ph: number;
    sd: number;
    ed: number;
    pd: number;
  }>(sql`
    SELECT coalesce(sum(s.sections) FILTER (WHERE s.received_at > ${hourAgo}), 0)::bigint AS sh,
           coalesce(sum(s.events) FILTER (WHERE s.received_at > ${hourAgo}), 0)::bigint AS eh,
           (count(*) FILTER (WHERE s.received_at > ${hourAgo} AND (s.sections > 0 OR s.events > 0)))::int AS ph,
           coalesce(sum(s.sections), 0)::bigint AS sd,
           coalesce(sum(s.events), 0)::bigint AS ed,
           (count(*) FILTER (WHERE s.sections > 0 OR s.events > 0))::int AS pd
    FROM (${SKIPPED_ROWS}
          WHERE meta IS NOT NULL
            AND received_at > ${iso(new Date(now.getTime() - DAY_MS))}::timestamptz
            AND received_at <= ${iso(now)}::timestamptz) AS s`);
  const r = res.rows[0];
  return {
    lastHour: { sections: r?.sh ?? 0, events: r?.eh ?? 0, payloads: r?.ph ?? 0 },
    last24h: { sections: r?.sd ?? 0, events: r?.ed ?? 0, payloads: r?.pd ?? 0 },
  };
}

async function loadTopSkippedSections(
  db: Db,
  now: Date,
): Promise<{ path: string; count: number }[]> {
  const res = await db.execute<{ path: string; count: number }>(sql`
    SELECT p.path, count(*)::int AS count
    FROM raw_payloads,
         LATERAL jsonb_array_elements_text(
           CASE WHEN jsonb_typeof(meta->'skippedSections') = 'array'
                THEN meta->'skippedSections' ELSE '[]'::jsonb END) AS p(path)
    WHERE received_at > ${iso(new Date(now.getTime() - DAY_MS))}::timestamptz
      AND received_at <= ${iso(now)}::timestamptz
    GROUP BY p.path
    ORDER BY count DESC, p.path
    LIMIT ${TOP_SKIPPED_SECTIONS}`);
  return res.rows.map((r) => ({ path: r.path, count: r.count }));
}

async function loadPluginVersions(db: Db): Promise<{ version: string | null; devices: number }[]> {
  const rows = await db
    .select({ version: devices.pluginVersion, devices: sql<number>`count(*)::int` })
    .from(devices)
    .where(isNull(devices.revokedAt))
    .groupBy(devices.pluginVersion);
  return rows.sort(byVersionDesc);
}

/** Newest parsed version first; unparseable versions after them (by text), never-sent (null) last. */
function byVersionDesc(a: { version: string | null }, b: { version: string | null }): number {
  if (a.version === null || b.version === null) {
    return a.version === b.version ? 0 : a.version === null ? 1 : -1;
  }
  const va = parsePluginVersion(a.version);
  const vb = parsePluginVersion(b.version);
  if (va && vb) return compareVersions(vb, va) || a.version.localeCompare(b.version);
  if (va || vb) return va ? -1 : 1;
  return a.version.localeCompare(b.version);
}

async function loadNoisyDevices(db: Db, now: Date): Promise<NoisyDevice[]> {
  const top = await db.execute<{ device_id: string; payloads: number; errors: number }>(sql`
    SELECT device_id, count(*)::int AS payloads,
           (count(*) FILTER (WHERE status IS DISTINCT FROM 200))::int AS errors
    FROM raw_payloads
    WHERE device_id IS NOT NULL
      AND received_at > ${iso(new Date(now.getTime() - HOUR_MS))}::timestamptz
      AND received_at <= ${iso(now)}::timestamptz
    GROUP BY device_id
    ORDER BY payloads DESC, device_id
    LIMIT ${NOISY_DEVICES}`);
  if (top.rows.length === 0) return [];
  // raw_payloads.device_id has no FK: a device (and its user) may be gone.
  const details = await db
    .select({
      id: devices.id,
      label: devices.label,
      pluginVersion: devices.pluginVersion,
      revokedAt: devices.revokedAt,
      userId: users.id,
      userName: users.name,
    })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .where(
      inArray(
        devices.id,
        top.rows.map((r) => r.device_id),
      ),
    );
  const byId = new Map(details.map((d) => [d.id, d]));
  return top.rows.map((r) => {
    const d = byId.get(r.device_id);
    return {
      deviceId: r.device_id,
      payloads: r.payloads,
      errors: r.errors,
      label: d?.label ?? null,
      pluginVersion: d?.pluginVersion ?? null,
      revokedAt: d?.revokedAt ?? null,
      user: d ? { id: d.userId, name: d.userName } : null,
    };
  });
}
