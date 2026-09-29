/**
 * Better Auth's endpoints (Discord sign-in, callback, get-session, sign-out). The client IP for
 * Better Auth's rate limiter comes from our own X-Forwarded-For rule (TRUST_PROXY_HOPS, D-42), handed
 * over in CLIENT_IP_HEADER; whatever a client sent in that header is overwritten or removed first, so
 * it can't pick its own rate-limit bucket (see AUTH-9).
 */
import { clientIp } from '@/lib/http';
import { CLIENT_IP_HEADER, getAuth } from '@/lib/auth';

function withClientIp(request: Request): Request {
  const headers = new Headers(request.headers);
  const ip = clientIp(request);
  if (ip) headers.set(CLIENT_IP_HEADER, ip);
  else headers.delete(CLIENT_IP_HEADER);
  // The body stream moves over to the new request unread.
  return new Request(request, { headers });
}

export async function GET(request: Request): Promise<Response> {
  return getAuth().handler(withClientIp(request));
}

export async function POST(request: Request): Promise<Response> {
  return getAuth().handler(withClientIp(request));
}
