/**
 * The shared body of the history routes (sessions, equipment, wealth, locations; handoff §12, M2):
 * session auth (401), `?from&to` (parseHistoryRange, 400 when malformed), then the read model, which
 * returns null when the account isn't visible or the viewer lacks the category (→ 404, so existence
 * never leaks; so is an id that can't be one, isPublicIdShape). The result is sent as
 * `{ [key]: rows }`.
 */
import type { Viewer } from '@hub/core';
import { getDb, type Db } from '@hub/db';
import type { HistoryRange } from '@hub/server';
import { ApiError, handleApi, json } from '@/lib/http';
import { requireApiUser } from '@/lib/session';
import { isPublicIdShape, parseHistoryRange } from './query';

export type HistoryLoader<T> = (
  db: Db,
  viewer: Viewer,
  publicId: string,
  range: HistoryRange,
) => Promise<T[] | null>;

export async function historyResponse<T>(
  request: Request,
  params: Promise<{ publicId: string }>,
  key: string,
  load: HistoryLoader<T>,
): Promise<Response> {
  return handleApi(async () => {
    const { viewer } = await requireApiUser(request);
    const { publicId } = await params;
    if (!isPublicIdShape(publicId)) throw accountNotFound();
    const range = parseHistoryRange(request.url, new Date());
    const rows = await load(getDb().db, viewer, publicId, range);
    if (rows === null) throw accountNotFound();
    return json(200, {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      [key]: rows,
    });
  });
}

/** The one 404 of the account routes: unknown, invisible and impossible ids look the same. */
export function accountNotFound(): ApiError {
  return new ApiError(404, 'not_found', 'Account not found.');
}
