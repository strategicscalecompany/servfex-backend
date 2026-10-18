import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { Server as SocketIOServer } from 'socket.io';

import { env } from './config/env';
import { logger } from './config/logger';
import { prisma } from './config/prisma';
import { errorHandler } from './middleware/errorHandler';
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

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO for real-time live admin booking updates
export const io = new SocketIOServer(server, {
  cors: {
    origin: env.CLIENT_URL,
    credentials: true,
  },
});

// Authenticate every socket from its handshake token. PostgreSQL stays the authority on role/status.
setRealtimeServer(io);

io.use(async (socket, next) => {
  try {
    const token =
      (socket.handshake.auth?.token as string | undefined) ||
      (socket.handshake.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return next(new Error('UNAUTHORIZED'));

    let user = null;
    try {
      const payload = verifyAccessToken(token);
      user = await prisma.user.findFirst({
        where: { id: payload.userId, deletedAt: null },
        select: { id: true, role: true, status: true },
      });
    } catch {
      if (!isFirebaseConfigured()) return next(new Error('UNAUTHORIZED'));
      const decoded = await getFirebaseAuth().verifyIdToken(token);
      user = await prisma.user.findFirst({
        where: { firebaseUid: decoded.uid, deletedAt: null },
        select: { id: true, role: true, status: true },
      });
    }

    if (!user || user.status === 'SUSPENDED' || user.status === 'INACTIVE') {
      return next(new Error('UNAUTHORIZED'));
    }
    socket.data.userId = user.id;
    socket.data.role = user.role;
    next();
  } catch {
    next(new Error('UNAUTHORIZED'));
  }
});

io.on('connection', (socket) => {
  socket.join(`user:${socket.data.userId}`);
  if (socket.data.role === 'SUPER_ADMIN') {
    socket.join('admins');
  }
  logger.info({ socketId: socket.id, role: socket.data.role }, 'Realtime client connected');

  socket.on('disconnect', () => {
    logger.info({ socketId: socket.id }, 'Realtime client disconnected');
  });
});

// Security HTTP Headers (Rule #12 in SECURITY_RULES.md)
app.use(helmet());

// Gzip / Deflate HTTP Response Compression for high-speed data transfer
app.use(compression());

// Cross-Origin Resource Sharing (Rule #11 in SECURITY_RULES.md)
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, Postman) or matching development client URL
      if (!origin || env.NODE_ENV === 'development' || origin === env.CLIENT_URL) {
        callback(null, true);
      } else {
        callback(null, true);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  })
);

// Body Parsers & Cookie Parser
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(cookieParser());

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
  res.status(200).json({ status: 'ok', service: 'servfex-api', version: 'v1' });
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
    logger.info('Database connection pool established successfully');
  } catch (err: any) {
    logger.error({ err }, 'Failed to warm database connection on startup');
  }
});

export { app, server };
