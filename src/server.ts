import http from 'http';
import express from 'express';

import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { Server as SocketIOServer } from 'socket.io';

import { env } from './config/env';
import { logger } from './config/logger';
import { prisma } from './config/prisma';
import { ensureMongoSparseUniqueIndexes } from './config/mongo-indexes';
import { ensureAllowlistedSuperAdmins } from './config/super-admins';
import { errorHandler } from './middleware/errorHandler';
import { corsMiddleware } from './middleware/cors';
import { timingMiddleware } from './middleware/timing.middleware';
import { verifyAccessToken } from './utils/token';
import { getFirebaseAuth, isFirebaseConfigured } from './config/firebase';
import { setRealtimeServer } from './utils/realtime';

// Route Handlers
import authRoutes from './routes/auth.routes';
import adminRoutes from './routes/admin.routes';
import catalogRoutes from './routes/catalog.routes';
import customerRoutes from './routes/customer-portal.routes';
import vendorRoutes from './routes/vendor-portal.routes';
import notificationRoutes from './routes/notification.routes';
import geoRoutes from './routes/geo.routes';
import callRoutes from './routes/call.routes';
import { startDispatchWorker, stopDispatchWorker } from './services/dispatch.worker';

const app = express();
const server = http.createServer(app);

// Trust the first hop from AWS/Nginx reverse proxy.
// Required for express-rate-limit to correctly read X-Forwarded-For without throwing
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR which crashes the request pipeline before CORS headers are sent.
app.set('trust proxy', 1);

// Serve Socket.IO under /api/socket.io so nginx configs that only reverse-proxy /api still work.
export const io = new SocketIOServer(server, {
  path: '/api/socket.io',
  cors: {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
  allowEIO3: true,
});

// Authenticate every socket from its handshake token. MongoDB stays the authority on role/status.
setRealtimeServer(io);

io.use(async (socket, next) => {
  try {
    const token =
      (socket.handshake.auth?.token as string | undefined) ||
      (socket.handshake.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) {
      logger.warn({ socketId: socket.id }, 'Realtime socket connection rejected: No token provided');
      return next(new Error('UNAUTHORIZED'));
    }

    let user = null;
    try {
      const payload = verifyAccessToken(token);
      user = await prisma.user.findFirst({
        where: { id: payload.userId, deletedAt: null },
        select: { id: true, role: true, status: true },
      });
    } catch {
      if (!isFirebaseConfigured()) {
        logger.warn({ socketId: socket.id }, 'Realtime socket connection rejected: Firebase unconfigured & JWT invalid');
        return next(new Error('UNAUTHORIZED'));
      }
      const decoded = await getFirebaseAuth().verifyIdToken(token);
      user = await prisma.user.findFirst({
        where: { firebaseUid: decoded.uid, deletedAt: null },
        select: { id: true, role: true, status: true },
      });

      // Email fallback if firebaseUid not linked yet (e.g. Google Sign-In)
      if (!user && decoded.email) {
        user = await prisma.user.findFirst({
          where: { email: decoded.email.toLowerCase().trim(), deletedAt: null },
          select: { id: true, role: true, status: true },
        });
        if (user) {
          await prisma.user.update({
            where: { id: user.id },
            data: { firebaseUid: decoded.uid, isVerified: true },
          });
        }
      }
    }

    if (!user || user.status === 'SUSPENDED' || user.status === 'INACTIVE') {
      logger.warn({ socketId: socket.id, hasUser: !!user, status: user?.status }, 'Realtime socket rejected: Inactive or suspended user');
      return next(new Error('UNAUTHORIZED'));
    }
    socket.data.userId = user.id;
    socket.data.role = user.role;
    next();
  } catch (err: any) {
    logger.warn({ socketId: socket.id, err: err?.message }, 'Realtime socket handshake error');
    next(new Error('UNAUTHORIZED'));
  }
});

io.on('connection', (socket) => {
  socket.join(`user:${socket.data.userId}`);
  if (socket.data.role === 'SUPER_ADMIN') {
    socket.join('admins');
  }
  logger.info({ socketId: socket.id, userId: socket.data.userId, role: socket.data.role }, 'Realtime client connected');

  socket.on('disconnect', (reason) => {
    logger.info({ socketId: socket.id, reason }, 'Realtime client disconnected');
  });
});


// CORS must run first and re-apply on writeHead so GET /admin/services (and every other
// response) always has a spec-valid Access-Control-Allow-Origin. Wildcards are invalid
// when Access-Control-Allow-Credentials is true.
app.use(corsMiddleware);

// Security HTTP Headers (Rule #12 in SECURITY_RULES.md)
// This is a JSON API, not a document — disable document-only policies that confuse CORS.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// Gzip / Deflate HTTP Response Compression for high-speed data transfer
// End-to-End Performance & Timing Instrumentation (Phase 2)
app.use(timingMiddleware);

app.use(compression());

// Body Parsers & Cookie Parser
// 700mb covers a 500MB document encoded as a JSON data URI (~4/3 overhead).
app.use(express.json({ limit: '700mb' }));
app.use(express.urlencoded({ extended: true, limit: '700mb' }));
app.use(cookieParser());

server.timeout = 15 * 60 * 1000;
server.headersTimeout = 16 * 60 * 1000;
server.requestTimeout = 15 * 60 * 1000;

// Structured HTTP Request Logging with Pino (Rule #21 in SECURITY_RULES.md)
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url === '/health',
    },
  })
);

// Rate Limiting on API endpoints (Rule #10 in SECURITY_RULES.md)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // Limit each IP to 300 requests per 15 mins
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many requests from this IP, please try again after 15 minutes.',
    },
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // 20 login attempts per 15 mins
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_LOGIN_ATTEMPTS',
      message: 'Too many authentication attempts. Please try again after 15 minutes.',
    },
  },
});

app.use('/api/', apiLimiter);
app.use('/api/v1/auth/login', authLimiter);

// Liveness Health Check
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'servfex-api',
    version: 'v1',
    authBuild: 'super-admin-allowlist-v3',
    database: 'mongodb',
  });
});

// Mount Versioned API Routes (Rule #13 in master architecture)
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/catalog', catalogRoutes);
app.use('/api/v1/customer', customerRoutes);
app.use('/api/v1/customer-portal', customerRoutes);
app.use('/api/v1/vendor', vendorRoutes);
app.use('/api/v1/vendor-portal', vendorRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/geo', geoRoutes);
app.use('/api/v1/calls', callRoutes);

// Catch-all 404 Route Handler
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'The requested API route was not found on this server',
    },
  });
});

// Central Sanitized Error Handler (Rule #20 in SECURITY_RULES.md)
app.use(errorHandler);

// Start HTTP Server
server.listen(env.PORT, '0.0.0.0', async () => {
  logger.info(`ServFex Super Admin API listening on port ${env.PORT} on 0.0.0.0 in ${env.NODE_ENV} mode`);
  try {
    await prisma.$connect();
    await ensureMongoSparseUniqueIndexes();
    await ensureAllowlistedSuperAdmins();
    logger.info('Database connection pool established successfully');
  } catch (err: any) {
    logger.error({ err }, 'Failed to warm database connection on startup');
  }

  try {
    await startDispatchWorker();
  } catch (err: any) {
    logger.error({ err }, 'Failed to initialize dispatch worker on startup');
  }
});

const handleShutdown = async (signal: string) => {
  logger.info({ signal }, 'Received shutdown signal, shutting down gracefully...');
  stopDispatchWorker();
  server.close(async () => {
    try {
      await prisma.$disconnect();
    } catch {
      // Ignore
    }
    process.exit(0);
  });
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

export { app, server };
