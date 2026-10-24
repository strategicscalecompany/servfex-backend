import pino from 'pino';
import { env } from './env';

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'passwordHash',
      'token',
      'refreshToken',
      'jwtSecret',
      'databaseUrl',
      'otp',
      'startOtp',
      'fcmToken',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.tokenHash',
      '*.refreshToken',
      '*.otp',
      '*.startOtp',
      '*.fcmToken',
      '*.*.otp',
      '*.*.startOtp',
      '*.*.fcmToken',
    ],
    remove: true,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
