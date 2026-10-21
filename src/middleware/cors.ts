import { Request, Response, NextFunction } from 'express';

const ALLOWED_HEADERS = [
  'Accept',
  'Authorization',
  'Content-Type',
  'Origin',
  'X-Requested-With',
  'X-Request-Id',
  'X-Request-ID',
  'X-Correlation-Id',
  'X-Idempotency-Key',
  'X-Client-Platform',
  'Cache-Control',
  'Pragma',
].join(', ');

const EXPOSED_HEADERS = [
  'X-Request-Id',
  'X-Request-ID',
  'X-Response-Time',
  'Server-Timing',
  'Retry-After',
  'Content-Disposition',
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'RateLimit-Policy',
].join(', ');

function requestOrigin(req: Request): string | undefined {
  const raw = req.headers.origin;
  const origin = Array.isArray(raw) ? raw[0] : raw;
  if (!origin || origin === 'null') {
    return undefined;
  }

  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return origin;
  } catch {
    return undefined;
  }
}

/**
 * Credentialed CORS cannot use `*` for Allow-Origin, Allow-Headers, or Expose-Headers.
 * Re-apply these on every response (including errors) so proxies/helmet cannot drop them.
 */
export function applyCorsHeaders(req: Request, res: Response): void {
  const origin = requestOrigin(req);

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');

  const requested = req.headers['access-control-request-headers'];
  const allowHeaders =
    typeof requested === 'string' && requested.trim() && requested.trim() !== '*'
      ? requested
      : ALLOWED_HEADERS;
  res.setHeader('Access-Control-Allow-Headers', allowHeaders);
  res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);
  res.setHeader('Access-Control-Max-Age', '86400');
}

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  applyCorsHeaders(req, res);

  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = function writeHeadWithCors(statusCode: any, ...args: any[]) {
    applyCorsHeaders(req, res);
    return originalWriteHead(statusCode, ...args);
  } as typeof res.writeHead;

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
}
