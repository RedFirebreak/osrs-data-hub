/**
 * GET /api/app/export → 200 `application/json` as an attachment, `osrs-data-hub-export-<date>.json`:
 * "Download my data" (Settings, handoff §14 and §16, D-79). The body is exportUserData's document,
 * streamed: a ReadableStream pulls the next piece only when the client reads, and a cancelled
 * download stops the generator (and so its queries).
 *
 * Same origin only (403 `bad_origin`: a download link on our own page sends `Sec-Fetch-Site:
 * same-origin`), session auth (401), one export per user per 10 minutes (429 + integer Retry-After,
 * PLUGIN-5). The first piece is produced before the 200 goes out: by then the user and their accounts
 * are read and `user.exported` is audited (counts only), so an early failure is an ordinary error
 * response. A failure after that can't change the status any more: it is logged (code and
 * parameter-free message only, DB-3) and the stream is errored, so the download visibly breaks
 * instead of ending in a truncated or patched-up document.
 *
 * Every request past the session check counts once in hub_data_exports_total{result}: rate_limited,
 * failed (before or while streaming), cancelled (the client stopped reading) or completed.
 */
import { getConfig } from '@hub/core';
import { getDb, pgErrorCode, safeDbErrorMessage } from '@hub/db';
import { exportUserData, getLogger, getMetrics } from '@hub/server';
import { connection } from 'next/server';
import { ApiError, assertSameOrigin, handleApi } from '@/lib/http';
import { requireApiUser } from '@/lib/session';
import { getExportLimiter } from './limits';

export async function GET(request: Request): Promise<Response> {
  await connection();
  return handleApi(async () => {
    assertSameOrigin(request);
    const { user } = await requireApiUser(request);
    const limit = getExportLimiter().hit(user.id);
    if (!limit.ok) {
      countExport('rate_limited');
      throw new ApiError(
        429,
        'rate_limited',
        'You can download your data once every 10 minutes. Try again later.',
        { 'Retry-After': String(limit.retryAfterSeconds) },
      );
    }
    const config = getConfig();
    const now = new Date();
    const pieces = exportUserData(getDb().db, user.id, {
      now,
      hub: { name: config.hubName, url: config.appOrigin },
    });
    let first: IteratorResult<string, void>;
    try {
      first = await pieces.next();
    } catch (err) {
      countExport('failed');
      throw err;
    }
    const filename = `osrs-data-hub-export-${now.toISOString().slice(0, 10)}.json`;
    return new Response(streamOf(pieces, first, user.id), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });
}

/** The document as bytes: `first`, then one piece per pull. */
function streamOf(
  pieces: AsyncGenerator<string, void, undefined>,
  first: IteratorResult<string, void>,
  userId: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let pending: IteratorResult<string, void> | null = first;
  // A pull still running when the client cancels throws at enqueue once the stream is closed: that
  // is the cancellation, not a failed export (NEXT-16).
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = pending ?? (await pieces.next());
        pending = null;
        if (next.done) {
          countExport('completed');
          controller.close();
        } else {
          controller.enqueue(encoder.encode(next.value));
        }
      } catch (err) {
        if (cancelled) return;
        // The 200 is out; see the file comment. DB-3: code and parameter-free message only.
        getLogger().error(
          { userId, pgCode: pgErrorCode(err), error: safeDbErrorMessage(err) },
          'export: failed while streaming',
        );
        countExport('failed');
        controller.error(new Error('The export failed.'));
      }
    },
    async cancel() {
      cancelled = true;
      countExport('cancelled');
      await pieces.return(undefined);
    },
  });
}

function countExport(result: 'completed' | 'failed' | 'cancelled' | 'rate_limited'): void {
  getMetrics().dataExports.inc({ result });
}
