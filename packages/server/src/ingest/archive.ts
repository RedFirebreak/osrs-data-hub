/**
 * raw_payloads: every body that got past auth, the version gate, the size cap and the rate limit is
 * archived OUTSIDE the ingest transaction (so failures are kept too), and its outcome is recorded
 * afterwards (handoff §7.1.4).
 */
import { pgErrorCode, rawPayloads, type Db } from '@hub/db';
import { and, eq } from 'drizzle-orm';
import type { Logger } from '../logger';
import type { IngestMeta } from './types';

/** Primary key of an archived payload (received_at is the hypertable's partition column). */
export interface ArchiveRef {
  id: string;
  receivedAt: Date;
}

/** How long the response waits for the outcome update before leaving it to finish on its own. */
const FINISH_WAIT_MS = 1_000;

/**
 * The body as storable text. A literal U+0000 fails a text insert (22021, DB-1); it is replaced with
 * U+FFFD rather than dropped, so the archive still shows that something was there. (JSON can't
 * contain a literal NUL, so such a body is invalid JSON anyway; escaped "\u0000" is kept as sent.)
 */
function archivableBody(text: string): string {
  return text.replaceAll('\u0000', '�');
}

/**
 * Inserts the raw body. `status` is null while processing; a payload rejected before processing
 * (invalid JSON) is archived with its final status and meta in one statement. Errors propagate:
 * a transient one becomes 503 like any other.
 */
export async function archivePayload(
  db: Db,
  row: {
    receivedAt: Date;
    deviceId: string;
    pluginVersion: string | null;
    body: string;
    status?: number;
    meta?: IngestMeta;
  },
): Promise<ArchiveRef> {
  const [ref] = await db
    .insert(rawPayloads)
    .values({
      receivedAt: row.receivedAt,
      deviceId: row.deviceId,
      pluginVersion: row.pluginVersion,
      body: archivableBody(row.body),
      status: row.status ?? null,
      meta: row.meta ?? null,
    })
    .returning({ id: rawPayloads.id, receivedAt: rawPayloads.receivedAt });
  if (!ref) throw new Error('raw_payloads insert returned no row');
  return ref;
}

/**
 * Records the status returned, the meta and the account. Best effort: a failure is logged (code
 * only, DB-3) and never changes the response. The caller waits at most FINISH_WAIT_MS, so a database
 * that has just gone away can't hold the plugin's request past its 10 s read timeout (PLUGIN-4).
 */
export async function finishArchive(
  db: Db,
  logger: Logger,
  ref: ArchiveRef,
  outcome: { status: number; meta: IngestMeta; accountId: number | null },
): Promise<void> {
  const update = db
    .update(rawPayloads)
    .set({ status: outcome.status, meta: outcome.meta, accountId: outcome.accountId })
    .where(and(eq(rawPayloads.id, ref.id), eq(rawPayloads.receivedAt, ref.receivedAt)))
    .then(
      () => undefined,
      (err: unknown) => {
        logger.warn(
          { archiveId: ref.id, pgCode: pgErrorCode(err) },
          'ingest: archive update failed',
        );
      },
    );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FINISH_WAIT_MS);
    timer.unref();
  });
  try {
    await Promise.race([update, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
