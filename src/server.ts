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
import { bookingRoom, hubRoom, setRealtimeServer } from './utils/realtime';

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
import { startAttendanceWorker, stopAttendanceWorker } from './services/attendance.worker';
import { startBookingSlaWorker, stopBookingSlaWorker } from './services/booking-sla.worker';

const app = express();
const server = http.createServer(app);

// Trust reverse proxy hops originating strictly from loopback addresses (127.0.0.1, ::1).
// Required for express-rate-limit to correctly read X-Forwarded-For without throwing
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR, while preventing non-loopback direct connections from spoofing client IPs.
app.set('trust proxy', 'loopback');

// Serve Socket.IO under /api/socket.io so nginx configs that only reverse-proxy /api still work.
export const io = new SocketIOServer(server, {
  path: '/api/socket.io',
  cors: {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST'],
  },
  transports: ['polling', 'websocket'],
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

    const socketUserSelect = {
      id: true,
      role: true,
      status: true,
      deletedAt: true,
    } as const;

    let user = null;
    try {
      const payload = verifyAccessToken(token);
      user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: socketUserSelect,
      });
    } catch {
      if (!isFirebaseConfigured()) {
        logger.warn({ socketId: socket.id }, 'Realtime socket connection rejected: Firebase unconfigured & JWT invalid');
        return next(new Error('UNAUTHORIZED'));
      }
      const decoded = await getFirebaseAuth().verifyIdToken(token);
      user = await prisma.user.findFirst({
        where: { firebaseUid: decoded.uid },
        select: socketUserSelect,
      });

      // Email fallback if firebaseUid not linked yet (e.g. Google Sign-In)
      if ((!user || user.deletedAt) && decoded.email) {
        user = await prisma.user.findUnique({
          where: { email: decoded.email.toLowerCase().trim() },
          select: socketUserSelect,
        });
        if (user && !user.deletedAt) {
          await prisma.user.update({
            where: { id: user.id },
            data: { firebaseUid: decoded.uid, isVerified: true },
          });
        }
      }
    }

    if (user?.deletedAt) {
      user = null;
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

  // Auto-join hub catalog rooms for partner / BOM / field staff so package toggles fan out immediately.
  void (async () => {
    try {
      const userId = socket.data.userId as string;
      const role = socket.data.role as string;
      const hubIds = new Set<string>();
      if (role === 'VENDOR') {
        const vendor = await prisma.vendorProfile.findFirst({
          where: { userId, isActive: true },
          select: { id: true },
        });
        if (vendor?.id) hubIds.add(vendor.id);
      } else if (role === 'EMPLOYEE') {
        const emp = await prisma.employeeProfile.findFirst({
          where: { userId },
          select: { vendorId: true },
        });
        if (emp?.vendorId) hubIds.add(emp.vendorId);
      } else if (role === 'OPERATIONS_MANAGER' || role === 'BUSINESS_DEVELOPMENT') {
        const mgr = await prisma.managerProfile.findFirst({
          where: { userId },
          select: { vendorId: true, zone: true },
        });
        if (mgr?.vendorId) hubIds.add(mgr.vendorId);
        const parts = (mgr?.zone || '')
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);
        for (const part of parts) {
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(part)) {
            hubIds.add(part);
          }
        }
      }
      for (const id of hubIds) {
        socket.join(hubRoom(id));
      }
    } catch (err) {
      logger.warn({ err, socketId: socket.id }, 'Failed to auto-join hub rooms');
    }
  })();

  socket.on('booking:join', async (payload: { bookingId?: string }, ack?: (result: { ok: boolean }) => void) => {
    try {
      const bookingId = payload?.bookingId;
      if (!bookingId) {
        ack?.({ ok: false });
        return;
      }
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: {
          customer: { select: { userId: true } },
          employee: { select: { userId: true } },
          vendor: { select: { userId: true } },
        },
      });
      const userId = socket.data.userId as string;
      const allowed =
        socket.data.role === 'SUPER_ADMIN' ||
        booking?.customer.userId === userId ||
        booking?.employee?.userId === userId ||
        booking?.vendor?.userId === userId;
      if (!allowed) {
        ack?.({ ok: false });
        return;
      }
      socket.join(bookingRoom(bookingId));
      ack?.({ ok: true });
    } catch {
      ack?.({ ok: false });
    }
  });

  socket.on('booking:leave', (payload: { bookingId?: string }) => {
    if (payload?.bookingId) socket.leave(bookingRoom(payload.bookingId));
  });

  /** Join hub catalog room for low-latency availability / crew updates (payload is non-PII). */
  socket.on('hub:join', async (payload: { hubId?: string }, ack?: (result: { ok: boolean }) => void) => {
    try {
      const hubId = typeof payload?.hubId === 'string' ? payload.hubId.trim() : '';
      if (!hubId) {
        ack?.({ ok: false });
        return;
      }
      const role = socket.data.role as string;
      const userId = socket.data.userId as string;
      if (role === 'SUPER_ADMIN' || role === 'CUSTOMER') {
        socket.join(hubRoom(hubId));
        ack?.({ ok: true });
        return;
      }
      const hub = await prisma.vendorProfile.findFirst({
        where: { id: hubId, isActive: true },
        select: {
          id: true,
          userId: true,
          employees: { where: { userId }, select: { id: true }, take: 1 },
          managers: { where: { userId }, select: { id: true }, take: 1 },
        },
      });
      if (!hub) {
        ack?.({ ok: false });
        return;
      }
      const allowed =
        hub.userId === userId || hub.employees.length > 0 || hub.managers.length > 0;
      if (!allowed && role === 'OPERATIONS_MANAGER') {
        // Multi-hub BOMs may be linked via zone CSV — still allow join (events are non-PII).
        socket.join(hubRoom(hubId));
        ack?.({ ok: true });
        return;
      }
      if (!allowed) {
        ack?.({ ok: false });
        return;
      }
      socket.join(hubRoom(hubId));
      ack?.({ ok: true });
    } catch {
      ack?.({ ok: false });
    }
  });

  socket.on('hub:leave', (payload: { hubId?: string }) => {
    if (payload?.hubId) socket.leave(hubRoom(payload.hubId));
  });

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
    authBuild: 'original-job-flow-v7',
    database: 'mongodb',
  });
});

// Mount Versioned API Routes (Rule #13 in master architecture)
app.use('/api/v1/auth', authRoutes);
app.use('/api/auth', authRoutes);
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
server.listen(env.PORT, env.HOST, async () => {
  logger.info(`ServFex Super Admin API listening on port ${env.PORT} on ${env.HOST} in ${env.NODE_ENV} mode`);
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

  try {
    await startAttendanceWorker();
  } catch (err: any) {
    logger.error({ err }, 'Failed to initialize attendance worker on startup');
  }

  try {
    startBookingSlaWorker();
  } catch (err: any) {
    logger.error({ err }, 'Failed to initialize booking SLA worker on startup');
  }
});

const handleShutdown = async (signal: string) => {
  logger.info({ signal }, 'Received shutdown signal, shutting down gracefully...');
  stopDispatchWorker();
  stopAttendanceWorker();
  stopBookingSlaWorker();
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
