/**
 * GET /api/app/accounts/[publicId]/sessions?from=ISO&to=ISO → 200 `{ from, to, sessions }`: play
 * sessions overlapping the range, newest first (@hub/server getSessions; special worlds included,
 * D-45). `activity` category; 404 otherwise (see ../../history.ts). Defaults: the last 30 days.
 */
import { getSessions } from '@hub/server';
import { historyResponse } from '../../history';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/app/accounts/[publicId]/sessions'>,
): Promise<Response> {
  return historyResponse(request, ctx.params, 'sessions', getSessions);
}
