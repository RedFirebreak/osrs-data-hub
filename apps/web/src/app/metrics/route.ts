/**
 * GET /metrics — Prometheus scrape endpoint (handoff §16, D-14). Off (404) unless METRICS_TOKEN is
 * set; then only `Authorization: Bearer <METRICS_TOKEN>` gets the registry (compared in constant
 * time), anything else 401. Outside /api on purpose: that's where Prometheus looks by default.
 */
import { constantTimeEqual, getConfig } from '@hub/core';
import { getMetrics } from '@hub/server';
import { connection } from 'next/server';

export async function GET(request: Request): Promise<Response> {
  await connection();
  const token = getConfig().metricsToken;
  if (!token) return text(404, 'Not Found');
  const presented = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(request.headers.get('authorization') ?? '');
  if (!presented?.[1] || !constantTimeEqual(presented[1], token)) {
    return text(401, 'Unauthorized', { 'www-authenticate': 'Bearer realm="metrics"' });
  }
  const { registry } = getMetrics();
  return new Response(await registry.metrics(), {
    status: 200,
    headers: { 'content-type': registry.contentType, 'cache-control': 'no-store' },
  });
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}
