import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { requestMetricsStore, RequestMetrics } from '../utils/metrics';
import { logger } from '../config/logger';

export const timingMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const rawReqId = req.headers['x-request-id'] || req.headers['x-correlation-id'];
  const requestId = Array.isArray(rawReqId)
    ? rawReqId[0]
    : typeof rawReqId === 'string' && rawReqId.trim().length > 0
    ? rawReqId.trim()
    : crypto.randomUUID();

  (req as any).id = requestId;
  res.setHeader('X-Request-ID', requestId);

  const startTime = performance.now();
  const metrics: RequestMetrics = {
    requestId,
    startTime,
    dbDurationMs: 0,
    dbQueryCount: 0,
  };

  const setTimingHeaders = () => {
    if (!res.headersSent) {
      const totalMs = performance.now() - startTime;
      const dbMs = metrics.dbDurationMs;
      const appMs = Math.max(0, totalMs - dbMs);

      res.setHeader('X-Response-Time', `${totalMs.toFixed(1)}ms`);
      res.setHeader(
        'Server-Timing',
        `db;dur=${dbMs.toFixed(1)}, app;dur=${appMs.toFixed(1)}, total;dur=${totalMs.toFixed(1)}`
      );
    }
  };

  res.on('finish', () => {
    const totalMs = performance.now() - startTime;
    const dbMs = metrics.dbDurationMs;
    const appMs = Math.max(0, totalMs - dbMs);

    // Development or slow-query threshold logging
    if (totalMs > 250 || process.env.NODE_ENV === 'development') {
      logger.info(
        {
          requestId,
          method: req.method,
          url: req.originalUrl || req.url,
          status: res.statusCode,
          totalDurationMs: Number(totalMs.toFixed(2)),
          dbDurationMs: Number(dbMs.toFixed(2)),
          appDurationMs: Number(appMs.toFixed(2)),
          dbQueryCount: metrics.dbQueryCount,
        },
        'API Request Performance'
      );
    }
  });

  // Capture writeHead so Server-Timing is included in HTTP headers before sending body
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = function (statusCode: any, ...args: any[]) {
    setTimingHeaders();
    return originalWriteHead(statusCode, ...args);
  } as any;

  requestMetricsStore.run(metrics, () => {
    next();
  });
};
