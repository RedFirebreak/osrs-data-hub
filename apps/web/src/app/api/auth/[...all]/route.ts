/**
 * Better Auth's endpoints (Discord sign-in, callback, get-session, sign-out). The client IP for
 * Better Auth's rate limiter comes from our own X-Forwarded-For rule (TRUST_PROXY_HOPS, D-42), handed
 * over in CLIENT_IP_HEADER; whatever a client sent in that header is overwritten or removed first, so
 * it can't pick its own rate-limit bucket (see AUTH-9). An answer that would send the browser to
 * another site with an error goes to /login instead (keepErrorsOnSite, see AUTH-16).
 */
import { getConfig } from '@hub/core';
import { clientIp } from '@/lib/http';
import { CLIENT_IP_HEADER, getAuth } from '@/lib/auth';
import { keepErrorsOnSite } from '@/lib/auth-redirects';

function withClientIp(request: Request): Request {
  const headers = new Headers(request.headers);
  const ip = clientIp(request);
  if (ip) headers.set(CLIENT_IP_HEADER, ip);
  else headers.delete(CLIENT_IP_HEADER);
  // See NEXT-13: never `new Request(request, …)` here. Next hands route handlers a Proxy around the
  // request, and Node 24's Request reads its input's private fields, which a Proxy doesn't have: every
  // auth request failed with a 500. Copy it from its parts instead; the body stream moves over unread.
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(request.url, {
    method: request.method,
    headers,
    signal: request.signal,
    ...(hasBody ? { body: request.body, duplex: 'half' } : {}),
  } as RequestInit);
}

async function handle(request: Request): Promise<Response> {
  const response = await getAuth().handler(withClientIp(request));
  return keepErrorsOnSite(request, response, getConfig().appOrigin);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
