import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { getFirebaseAuth, isFirebaseConfigured } from '../config/firebase';
import { sendError } from '../utils/response';
import { prisma } from '../config/prisma';
import { logger } from '../config/logger';
import { verifyAccessToken } from '../utils/token';
import { isAllowlistedSuperAdminEmail } from '../config/super-admins';

const AUTH_LOOKUP_SELECT = {
  id: true,
  email: true,
  role: true,
  status: true,
  firebaseUid: true,
  deletedAt: true,
} as const;

function isSoftDeleted(user?: { deletedAt?: Date | null } | null): boolean {
  return Boolean(user?.deletedAt);
}

function isDatabaseError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError ||
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientRustPanicError ||
    (typeof err === 'object' &&
      err !== null &&
      'name' in err &&
      String((err as { name: string }).name).startsWith('Prisma'))
  );
}

export interface AuthenticatedUser {
  userId: string;
  firebaseUid: string;
  role: string;
  email: string;
}

export interface FirebaseUserClaims {
  uid: string;
  email?: string;
  phone_number?: string;
  name?: string;
  picture?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      rawToken?: string;
      firebaseUser?: FirebaseUserClaims;
    }
  }
}

/**
 * Extracts Bearer token from Authorization header.
 */
function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  return null;
}

/**
 * Middleware to authenticate requests using Firebase ID token or Backend JWT token.
 * Verifies token validity and binds to the ServFex user account in MongoDB.
 */
export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const token = extractToken(req);

    if (!token) {
      sendError(res, 'UNAUTHORIZED', 'Authentication token required (Bearer <token>)', 401);
      return;
    }

    req.rawToken = token;

    // 1. Check for backend JWT access token first
    try {
      const jwtPayload = verifyAccessToken(token);
      const user = await prisma.user.findUnique({
        where: { id: jwtPayload.userId },
        select: AUTH_LOOKUP_SELECT,
      });

      if (user && !isSoftDeleted(user)) {
        if (user.status === 'SUSPENDED') {
          sendError(res, 'ACCOUNT_SUSPENDED', 'Your ServFex account has been suspended.', 403);
          return;
        }

        req.user = {
          userId: user.id,
          firebaseUid: user.firebaseUid || '',
          role: user.role,
          email: user.email,
        };

        return next();
      }
    } catch (err: any) {
      if (err?.name === 'TokenExpiredError') {
        sendError(res, 'TOKEN_EXPIRED', 'Access token has expired. Please log in again.', 401);
        return;
      }
      // Not a local JWT token, proceed to Firebase Admin SDK check below
    }

    if (!isFirebaseConfigured()) {
      sendError(
        res,
        'SERVICE_UNAVAILABLE',
        'Firebase Admin SDK is not configured on the backend. Set Firebase credentials in .env.',
        503
      );
      return;
    }

    // Verify token using Firebase Admin SDK
    const decodedToken = await getFirebaseAuth().verifyIdToken(token);

    // MongoDB is the sole authority for ServFex user identity & role
    let user = await prisma.user.findFirst({
      where: { firebaseUid: decodedToken.uid },
      select: AUTH_LOOKUP_SELECT,
    });
    if (isSoftDeleted(user)) user = null;

    const tokenEmail = decodedToken.email?.toLowerCase().trim();
    const allowlistedAdmin = isAllowlistedSuperAdminEmail(tokenEmail);
    const linkableEmail =
      tokenEmail && (decodedToken.email_verified || allowlistedAdmin) ? tokenEmail : undefined;

    // Auto-link Google email if the ServFex user already exists
    if (!user && linkableEmail) {
      const emailMatch = await prisma.user.findUnique({
        where: { email: linkableEmail },
      });
      if (emailMatch && isSoftDeleted(emailMatch)) {
        sendError(res, 'UNAUTHORIZED', 'This ServFex account has been deleted.', 401);
        return;
      }

      if (emailMatch) {
        user = await prisma.user.update({
          where: { id: emailMatch.id },
          data: { firebaseUid: decodedToken.uid, isVerified: true },
          select: AUTH_LOOKUP_SELECT,
        });
        logger.info(
          { email: user.email, role: user.role, firebaseUid: decodedToken.uid },
          'Auto-linked verified Google account for user'
        );
      }
    }

    if (user && allowlistedAdmin && (user.role !== 'SUPER_ADMIN' || user.status !== 'ACTIVE')) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          role: 'SUPER_ADMIN',
          status: 'ACTIVE',
          isVerified: true,
          firebaseUid: decodedToken.uid,
        },
        select: AUTH_LOOKUP_SELECT,
      });
      logger.info({ email: user.email, firebaseUid: decodedToken.uid }, 'Promoted allowlisted email to SUPER_ADMIN');
    }

    if (!user && allowlistedAdmin && linkableEmail) {
      const name =
        (decodedToken as { name?: string }).name || linkableEmail.split('@')[0];
      try {
        user = await prisma.user.create({
          data: {
            email: linkableEmail,
            firebaseUid: decodedToken.uid,
            name,
            role: 'SUPER_ADMIN',
            status: 'ACTIVE',
            isVerified: true,
          },
          select: AUTH_LOOKUP_SELECT,
        });
        logger.info({ userId: user.id, email: user.email }, 'Provisioned allowlisted Super Admin from Google login');
      } catch (createErr) {
        if (createErr instanceof Prisma.PrismaClientKnownRequestError && createErr.code === 'P2002') {
          const existing = await prisma.user.findUnique({
            where: { email: linkableEmail },
          });
          if (existing && !isSoftDeleted(existing)) {
            user = await prisma.user.update({
              where: { id: existing.id },
              data: {
                firebaseUid: decodedToken.uid,
                role: 'SUPER_ADMIN',
                status: 'ACTIVE',
                isVerified: true,
              },
              select: AUTH_LOOKUP_SELECT,
            });
          } else {
            throw createErr;
          }
        } else {
          throw createErr;
        }
      }
    }

    // Auto-provision Customer if authenticating via verified Firebase Google/Phone and not yet in DB
    if (!user && (decodedToken.email || decodedToken.phone_number)) {
      const email = decodedToken.email || `${decodedToken.uid}@phone.servfex.com`;
      const name = (decodedToken as any).name || (decodedToken.email ? decodedToken.email.split('@')[0] : 'Customer');
      try {
        user = await prisma.user.create({
          data: {
            email: email.toLowerCase().trim(),
            firebaseUid: decodedToken.uid,
            phone: decodedToken.phone_number || null,
            name,
            role: 'CUSTOMER',
            status: 'ACTIVE',
            isVerified: true,
            customerProfile: { create: {} },
          },
          select: AUTH_LOOKUP_SELECT,
        });
        logger.info({ userId: user.id, email: user.email }, 'Auto-provisioned customer from verified Firebase token');
      } catch (createErr) {
        if (createErr instanceof Prisma.PrismaClientKnownRequestError && createErr.code === 'P2002') {
          const existing = await prisma.user.findUnique({
            where: { email: email.toLowerCase().trim() },
          });
          if (existing && !isSoftDeleted(existing)) {
            user = await prisma.user.update({
              where: { id: existing.id },
              data: { firebaseUid: decodedToken.uid, isVerified: true },
              select: AUTH_LOOKUP_SELECT,
            });
          } else {
            throw createErr;
          }
        } else {
          throw createErr;
        }
      }
    }

    if (!user) {
      sendError(
        res,
        'UNAUTHORIZED',
        'No ServFex account associated with this account. Registration required.',
        401
      );
      return;
    }

    if (user.status === 'SUSPENDED') {
      sendError(res, 'ACCOUNT_SUSPENDED', 'Your ServFex account has been suspended.', 403);
      return;
    }

    req.user = {
      userId: user.id,
      firebaseUid: decodedToken.uid,
      role: user.role,
      email: user.email,
    };

    next();
  } catch (err: any) {
    if (err.code === 'auth/id-token-expired') {
      sendError(res, 'TOKEN_EXPIRED', 'Firebase ID token has expired. Please refresh.', 401);
      return;
    }
    if (err.code === 'auth/id-token-revoked') {
      sendError(res, 'TOKEN_REVOKED', 'Firebase ID token has been revoked.', 401);
      return;
    }
    if (isDatabaseError(err)) {
      logger.error({ err }, 'Database error during authenticate');
      sendError(res, 'INTERNAL_ERROR', 'Failed to load account.', 500);
      return;
    }
    logger.error({ err }, 'Authentication failed');
    sendError(res, 'INVALID_TOKEN', 'Invalid or unverified Firebase ID token.', 401);
  }
};

/**
 * Middleware strictly requiring SUPER_ADMIN role.
 *
 * Implements strict security locks:
 * 1. Checks Firebase token revocation via verifyIdToken(token, true)
 * 2. Checks MongoDB role === 'SUPER_ADMIN' directly from DB (no memory caching)
 * 3. Checks MongoDB account status === 'ACTIVE' and deletedAt === null
 * 4. Rejects CUSTOMER, VENDOR, EMPLOYEE, OPERATIONS_MANAGER or unprivileged roles with 403 Forbidden
 */
export const requireSuperAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const token = req.rawToken || extractToken(req);

    if (!token) {
      sendError(res, 'UNAUTHORIZED', 'Authentication token required', 401);
      return;
    }

    // Check for backend JWT access token for SUPER_ADMIN first
    try {
      const jwtPayload = verifyAccessToken(token);
      const adminUser = await prisma.user.findUnique({
        where: { id: jwtPayload.userId },
        select: AUTH_LOOKUP_SELECT,
      });

      if (adminUser && !isSoftDeleted(adminUser)) {
        if (adminUser.role !== 'SUPER_ADMIN') {
          sendError(res, 'FORBIDDEN', 'Access denied: This endpoint requires SUPER_ADMIN authority.', 403);
          return;
        }
        if (adminUser.status !== 'ACTIVE') {
          sendError(res, 'ACCOUNT_INACTIVE', 'Super Admin account is not currently active.', 403);
          return;
        }

        req.user = {
          userId: adminUser.id,
          firebaseUid: adminUser.firebaseUid || '',
          role: adminUser.role,
          email: adminUser.email,
        };
        return next();
      }
    } catch {
      // Proceed to Firebase verification
    }

    if (!isFirebaseConfigured()) {
      sendError(res, 'SERVICE_UNAVAILABLE', 'Firebase Admin SDK is not configured.', 503);
      return;
    }

    // 1. Strict Revocation Check on Super Admin requests
    let decodedToken;
    try {
      decodedToken = await getFirebaseAuth().verifyIdToken(token, true);
    } catch (revokedErr: any) {
      if (revokedErr.code === 'auth/id-token-revoked') {
        sendError(res, 'TOKEN_REVOKED', 'Super Admin session has been revoked. Re-authentication required.', 401);
        return;
      }
      throw revokedErr;
    }

    // 2. Query MongoDB live (no caching) to verify SUPER_ADMIN role & active status
    let adminUser = await prisma.user.findFirst({
      where: { firebaseUid: decodedToken.uid },
      select: AUTH_LOOKUP_SELECT,
    });
    if (isSoftDeleted(adminUser)) adminUser = null;

    const adminTokenEmail = decodedToken.email?.toLowerCase().trim();
    const allowlistedAdmin = isAllowlistedSuperAdminEmail(adminTokenEmail);
    const verifiedAdminEmail =
      adminTokenEmail && (decodedToken.email_verified || allowlistedAdmin)
        ? adminTokenEmail
        : undefined;

    if (!adminUser && verifiedAdminEmail) {
      const emailMatch = await prisma.user.findUnique({
        where: { email: verifiedAdminEmail },
      });
      if (emailMatch && isSoftDeleted(emailMatch)) {
        sendError(res, 'UNAUTHORIZED', 'This ServFex account has been deleted.', 401);
        return;
      }

      if (emailMatch && (emailMatch.role === 'SUPER_ADMIN' || allowlistedAdmin)) {
        adminUser = await prisma.user.update({
          where: { id: emailMatch.id },
          data: {
            firebaseUid: decodedToken.uid,
            isVerified: true,
            ...(allowlistedAdmin
              ? { role: 'SUPER_ADMIN', status: 'ACTIVE' }
              : {}),
          },
          select: AUTH_LOOKUP_SELECT,
        });
      }
    }

    if (
      adminUser &&
      allowlistedAdmin &&
      (adminUser.role !== 'SUPER_ADMIN' || adminUser.status !== 'ACTIVE')
    ) {
      adminUser = await prisma.user.update({
        where: { id: adminUser.id },
        data: {
          role: 'SUPER_ADMIN',
          status: 'ACTIVE',
          isVerified: true,
          firebaseUid: decodedToken.uid,
        },
        select: AUTH_LOOKUP_SELECT,
      });
    }

    if (!adminUser || adminUser.role !== 'SUPER_ADMIN') {
      sendError(
        res,
        'FORBIDDEN',
        'Access denied: This endpoint requires SUPER_ADMIN authority.',
        403
      );
      return;
    }

    if (adminUser.status !== 'ACTIVE') {
      sendError(res, 'ACCOUNT_INACTIVE', 'Super Admin account is not currently active.', 403);
      return;
    }

    req.user = {
      userId: adminUser.id,
      firebaseUid: decodedToken.uid,
      role: adminUser.role,
      email: adminUser.email,
    };

    next();
  } catch (err: any) {
    if (err.code === 'auth/id-token-expired') {
      sendError(res, 'TOKEN_EXPIRED', 'Super Admin session expired. Please refresh.', 401);
      return;
    }
    if (isDatabaseError(err)) {
      logger.error({ err }, 'Database error during Super Admin authorization');
      sendError(res, 'INTERNAL_ERROR', 'Failed to verify Super Admin privileges.', 500);
      return;
    }
    logger.warn({ err: err.message }, 'Super Admin authorization check failed');
    sendError(res, 'UNAUTHORIZED', 'Failed to verify Super Admin privileges', 401);
  }
};

/**
 * Middleware that strictly verifies the Firebase ID token and attaches decoded claims,
 * but does NOT require a pre-existing ServFex user account.
 * Used for customer/vendor registration/onboarding endpoints.
 */
export const authenticateFirebaseOnly = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const token = extractToken(req);

    if (!token) {
      sendError(res, 'UNAUTHORIZED', 'Authentication token required (Bearer <firebase_id_token>)', 401);
      return;
    }

    req.rawToken = token;

    if (!isFirebaseConfigured()) {
      sendError(res, 'SERVICE_UNAVAILABLE', 'Firebase Admin SDK is not configured.', 503);
      return;
    }

    const decoded = await getFirebaseAuth().verifyIdToken(token);
    req.firebaseUser = {
      uid: decoded.uid,
      email: decoded.email,
      phone_number: decoded.phone_number,
      name: decoded.name,
      picture: decoded.picture,
    };

    next();
  } catch (err: any) {
    if (err.code === 'auth/id-token-expired') {
      sendError(res, 'TOKEN_EXPIRED', 'Firebase ID token has expired. Please refresh.', 401);
      return;
    }
    sendError(res, 'INVALID_TOKEN', 'Invalid or unverified Firebase ID token.', 401);
  }
};

/**
 * Middleware to restrict access to specified roles.
 */
export const requireRole = (...allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      sendError(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      sendError(
        res,
        'FORBIDDEN',
        `Access denied. Requires one of roles: ${allowedRoles.join(', ')}`,
        403
      );
      return;
    }

    next();
  };
};

