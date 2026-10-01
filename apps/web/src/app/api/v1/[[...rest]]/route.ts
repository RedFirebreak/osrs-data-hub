/**
 * Every /api/v1 path no route matches (including /api/v1 itself): 404 `not_found` as JSON with the
 * CORS headers, so API clients never get Next's HTML 404 page. No key needed: an unknown path reveals
 * nothing. OPTIONS answers the preflight like every v1 route, so a browser client sees the 404.
 */
import { connection } from 'next/server';
import { preflight, withCors } from '@/lib/api-v1/cors';
import { measureApiRequest } from '@/lib/api-v1/metrics';
import { endpointNotFound } from '@/lib/api-v1/respond';
import { errorJson } from '@/lib/http';

async function notFound(): Promise<Response> {
  await connection();
  const done = measureApiRequest('unknown');
  const { status, code, message } = endpointNotFound();
  return done(withCors(errorJson(status, code, message)));
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = preflight;
