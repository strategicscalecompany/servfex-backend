import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger';
import { env } from '../config/env';
import { sendError } from '../utils/response';

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const origin = req.headers.origin;
  if (origin && !res.getHeader('Access-Control-Allow-Origin')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  const isPayloadTooLarge =
    err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413;

  const statusCode = isPayloadTooLarge ? 413 : err.statusCode || err.status || 500;
  const errorCode = isPayloadTooLarge
    ? 'PAYLOAD_TOO_LARGE'
    : err.code || 'INTERNAL_SERVER_ERROR';

  const message = isPayloadTooLarge
    ? 'The uploaded files are too large for a single request. Attach documents one at a time — up to 30 files are supported.'
    : env.NODE_ENV === 'production' && statusCode === 500
      ? 'An unexpected internal error occurred. Please try again later.'
      : err.message || 'Internal server error';

  logger.error({
    err: {
      message: err.message,
      stack: env.NODE_ENV === 'development' ? err.stack : undefined,
      code: err.code,
    },
    req: {
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
      userId: req.user?.userId,
    },
  }, 'Unhandled request error');

  sendError(res, errorCode, message, statusCode);
};
