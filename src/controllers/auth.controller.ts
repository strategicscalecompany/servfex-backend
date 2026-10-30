import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendSuccess, sendError } from '../utils/response';
import { getFirebaseAuth, isFirebaseConfigured } from '../config/firebase';
import { logger } from '../config/logger';
import { hashPassword, verifyPassword } from '../utils/password';
import { generateAccessToken, generateRefreshToken, verifyAccessToken } from '../utils/token';
import { generateAndSendEmailOtp, verifyEmailOtp } from '../services/otp.service';
import { isTestingWorkflowEnabled } from '../config/testing-workflow';
import {
  sendCustomerEmailOtp,
  sendCustomerMobileOtp,
  verifyCustomerEmailOtp,
  verifyCustomerMobileOtp,
  resolveGoogleCustomer,
  completeCustomerProfile,
} from '../services/customer-onboarding.service';

export const loginSchema = z.object({
  email: z.string().email('Valid email is required'),
  password: z.string().min(1, 'Password is required'),
  role: z.string().optional(),
});

/** Maps client portal labels onto PostgreSQL UserRole values. */
export function normalizePortalRole(role?: string): string | undefined {
  if (!role) return undefined;
  const raw = role.toUpperCase().trim();
  if (raw === 'PROVIDER' || raw === 'EMPLOYEE') return 'EMPLOYEE';
  if (raw === 'MANAGER' || raw === 'OPERATIONS_MANAGER') return 'OPERATIONS_MANAGER';
  return raw;
}

function toClientRole(dbRole: string): string {
  if (dbRole === 'EMPLOYEE') return 'PROVIDER';
  if (dbRole === 'OPERATIONS_MANAGER') return 'MANAGER';
  return dbRole;
}

/**
 * Direct email/password login endpoint for mobile apps and web.
 * Authenticates against PostgreSQL and returns JWT tokens.
 * Endpoint: POST /api/v1/auth/login
 */
export const login = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { email, password, role } = req.body;
    const cleanEmail = email.toLowerCase().trim();

    const targetRole = normalizePortalRole(role);

    // Super Admin never shares the Manager / Vendor / Expert portals.
    const roleFilter = targetRole ? { role: targetRole as any } : {};

    const user = await prisma.user.findFirst({
      where: {
        email: cleanEmail,
        deletedAt: null,
        ...roleFilter,
      },
      include: {
        vendorProfile: true,
        employeeProfile: {
          include: {
            vendor: true,
          },
        },
        customerProfile: true,
        managerProfile: {
          include: { vendor: true },
        },
      },
    });

    if (!user) {
      sendError(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
      return;
    }

    if (user.status === 'SUSPENDED') {
      sendError(res, 'ACCOUNT_SUSPENDED', 'Your ServFex account has been suspended.', 403);
      return;
    }

    // Explicitly reject password login if account has no password set (e.g. OAuth or Phone OTP accounts)
    // Return standard generic error to prevent account enumeration.
    if (!user.passwordHash) {
      sendError(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
      return;
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      sendError(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
      return;
    }

    // Update lastLoginAt
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const token = generateAccessToken({
      userId: user.id,
      role: user.role,
      email: user.email,
    });
    const refreshToken = generateRefreshToken({
      userId: user.id,
      role: user.role,
      email: user.email,
    });

    const userPayload = {
      id: user.id,
      email: user.email,
      phone: user.phone || '',
      name: user.name,
      role: toClientRole(user.role),
      actualRole: user.role,
      status: user.status,
      profilePhotoUrl: user.profilePhotoUrl,
      companyName:
        user.vendorProfile?.companyName ||
        user.employeeProfile?.vendor?.companyName ||
        user.managerProfile?.vendor?.companyName ||
        user.name,
      location: user.vendorProfile?.location || user.managerProfile?.city || 'India',
      bio: user.vendorProfile?.bio || '',
      category: user.employeeProfile?.specialization || user.managerProfile?.kind || '',
      expertKind: user.employeeProfile?.expertKind || null,
      rating: user.vendorProfile?.rating ?? user.employeeProfile?.rating ?? 5.0,
      vendorProfile: user.vendorProfile,
      employeeProfile: user.employeeProfile,
      managerProfile: user.managerProfile,
      testingWorkflowEnabled: isTestingWorkflowEnabled(),
    };

    logger.info({ userId: user.id, email: user.email, role: user.role }, 'User successfully logged in via credentials');

    sendSuccess(res, {
      user: userPayload,
      token,
      refreshToken,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Returns the authenticated user's ServFex PostgreSQL profile.
 * Endpoint: GET /api/v1/auth/me
 */
export const getCurrentUser = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      sendError(res, 'UNAUTHORIZED', 'Not authenticated', 401);
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: {
        id: true,
        firebaseUid: true,
        email: true,
        phone: true,
        name: true,
        role: true,
        status: true,
        profilePhotoUrl: true,
        isVerified: true,
        createdAt: true,
        lastLoginAt: true,
        deletedAt: true,
        customerProfile: true,
        vendorProfile: true,
        employeeProfile: true,
        managerProfile: true,
      },
    });

    if (!user || user.deletedAt) {
      sendError(res, 'NOT_FOUND', 'User profile not found in ServFex database', 404);
      return;
    }

    // Update last active / login timestamp in background
    prisma.user
      .update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      })
      .catch((err) => logger.warn({ err }, 'Failed to update lastLoginAt'));

    const { deletedAt: _deletedAt, ...publicUser } = user;

    sendSuccess(res, {
      user: {
        ...publicUser,
        expertKind: user.employeeProfile?.expertKind || null,
        testingWorkflowEnabled: isTestingWorkflowEnabled(),
      },
      workflow: {
        testingWorkflowEnabled: isTestingWorkflowEnabled(),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Revokes all active refresh tokens for the authenticated user via Firebase Admin SDK.
 * Forces all client devices to re-authenticate.
 * Endpoint: POST /api/v1/auth/revoke-all
 */
export const revokeAllSessions = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      sendError(res, 'UNAUTHORIZED', 'Not authenticated', 401);
      return;
    }

    if (!isFirebaseConfigured()) {
      sendError(res, 'SERVICE_UNAVAILABLE', 'Firebase Admin SDK not configured', 503);
      return;
    }

    // Revoke all Firebase refresh tokens for this user
    await getFirebaseAuth().revokeRefreshTokens(req.user.firebaseUid);

    logger.info({ userId: req.user.userId, firebaseUid: req.user.firebaseUid }, 'Revoked all user sessions via Firebase');

    sendSuccess(res, { message: 'All sessions successfully revoked. Devices must re-authenticate.' });
  } catch (error) {
    next(error);
  }
};

export const googleLoginSchema = z.object({
  idToken: z.string().min(1, 'Firebase/Google ID token is required'),
  role: z.string().optional(),
  email: z.string().email().optional(),
  name: z.string().optional(),
});

/**
 * Authenticates with Firebase Google ID token and returns ServFex profile + JWT.
 * Auto-provisions user account if not registered yet.
 * Endpoint: POST /api/v1/auth/google
 */
export const googleLogin = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { idToken, role, email: clientEmail, name: clientName } = req.body;
    let decodedEmail: string | undefined = clientEmail;
    let decodedName: string | undefined = clientName;
    let firebaseUid: string | undefined;
    let photoUrl: string | undefined;
    let tokenVerified = !isFirebaseConfigured();
    const targetRole = normalizePortalRole(role) || 'VENDOR';

    if (isFirebaseConfigured()) {
      try {
        const decoded = await getFirebaseAuth().verifyIdToken(idToken);
        decodedEmail = decoded.email || clientEmail;
        decodedName = decoded.name || clientName;
        firebaseUid = decoded.uid;
        photoUrl = decoded.picture;
        tokenVerified = true;
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Firebase ID token verification failed, using token payload fallback if in dev');
      }
    }

    if (targetRole === 'CUSTOMER' && isFirebaseConfigured() && !tokenVerified) {
      sendError(res, 'INVALID_TOKEN', 'Google credentials could not be verified. Please try again.', 401);
      return;
    }

    if (!decodedEmail) {
      sendError(res, 'INVALID_TOKEN', 'Could not determine email from Google credentials', 400);
      return;
    }

    const cleanEmail = decodedEmail.toLowerCase().trim();

    let user = await prisma.user.findFirst({
      where: {
        OR: [
          ...(firebaseUid ? [{ firebaseUid }] : []),
          { email: cleanEmail },
        ],
        deletedAt: null,
      },
      include: {
        vendorProfile: true,
        employeeProfile: {
          include: {
            vendor: true,
          },
        },
        customerProfile: true,
        managerProfile: {
          include: { vendor: true },
        },
      },
    });

    if (!user) {
      if (targetRole === 'CUSTOMER') {
        const googleResult = await resolveGoogleCustomer({
          email: cleanEmail,
          name: decodedName,
          firebaseUid,
          photoUrl,
        });
        if (!googleResult.success) {
          sendError(res, googleResult.code, googleResult.message, googleResult.status);
          return;
        }
        sendSuccess(res, googleResult.payload);
        return;
      }
      sendError(
        res,
        'ACCOUNT_NOT_FOUND',
        "Login failed. You don't have an account. Please contact Super Admin to get an account.",
        403
      );
      return;
    }

    if (targetRole === 'CUSTOMER' && user.role === 'CUSTOMER') {
      const googleResult = await resolveGoogleCustomer({
        email: cleanEmail,
        name: decodedName,
        firebaseUid,
        photoUrl,
      });
      if (!googleResult.success) {
        sendError(res, googleResult.code, googleResult.message, googleResult.status);
        return;
      }
      sendSuccess(res, googleResult.payload);
      return;
    }

    // Super Admin stays on the admin website. Managers use the vendor-app Manager portal only.
    const isAuthorized =
      targetRole === 'OPERATIONS_MANAGER'
        ? user.role === 'OPERATIONS_MANAGER'
        : user.role === targetRole || (user.role === 'SUPER_ADMIN' && targetRole !== 'OPERATIONS_MANAGER' && targetRole !== 'CUSTOMER');
    if (!isAuthorized) {
      sendError(
        res,
        'FORBIDDEN',
        `Login failed. Your account (${user.role}) is not authorized for the ${role || 'this'} portal.`,
        403
      );
      return;
    }

    if (user.status === 'SUSPENDED') {
      sendError(res, 'ACCOUNT_SUSPENDED', 'Your ServFex account has been suspended.', 403);
      return;
    }

    if (user.status === 'INACTIVE' || user.status === 'PENDING_APPROVAL') {
      sendError(res, 'ACCOUNT_INACTIVE', 'Your account is pending approval by Super Admin.', 403);
      return;
    }

    // Account exists & verified: update firebaseUid and lastLoginAt
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(firebaseUid && !user.firebaseUid ? { firebaseUid } : {}),
        ...(photoUrl && !user.profilePhotoUrl ? { profilePhotoUrl: photoUrl } : {}),
        lastLoginAt: new Date(),
      },
      include: {
        vendorProfile: true,
        employeeProfile: {
          include: {
            vendor: true,
          },
        },
        customerProfile: true,
        managerProfile: {
          include: { vendor: true },
        },
      },
    });

    const token = generateAccessToken({
      userId: user.id,
      role: user.role,
      email: user.email,
    });
    const refreshToken = generateRefreshToken({
      userId: user.id,
      role: user.role,
      email: user.email,
    });

    const userPayload = {
      id: user.id,
      email: user.email,
      phone: user.phone || '',
      name: user.name,
      role: toClientRole(user.role),
      actualRole: user.role,
      status: user.status,
      profilePhotoUrl: user.profilePhotoUrl,
      companyName:
        user.vendorProfile?.companyName ||
        user.employeeProfile?.vendor?.companyName ||
        user.managerProfile?.vendor?.companyName ||
        user.name,
      location: user.vendorProfile?.location || user.managerProfile?.city || 'India',
      bio: user.vendorProfile?.bio || '',
      category: user.employeeProfile?.specialization || user.managerProfile?.kind || '',
      expertKind: user.employeeProfile?.expertKind || null,
      rating: user.vendorProfile?.rating ?? user.employeeProfile?.rating ?? 5.0,
      vendorProfile: user.vendorProfile,
      employeeProfile: user.employeeProfile,
      managerProfile: user.managerProfile,
      testingWorkflowEnabled: isTestingWorkflowEnabled(),
    };

    logger.info({ userId: user.id, email: user.email, role: user.role }, 'User successfully logged in via Google');

    sendSuccess(res, {
      user: userPayload,
      token,
      refreshToken,
    });
  } catch (error) {
    next(error);
  }
};

export const sendOtpSchema = z.object({
  email: z.string().email('Please enter a valid email address').optional(),
  phone: z.string().optional(),
  mobile: z.string().optional(),
});

export const verifyOtpSchema = z.object({
  email: z.string().email('Please enter a valid email address').optional(),
  phone: z.string().optional(),
  mobile: z.string().optional(),
  otp: z.string().min(4, 'OTP must be at least 4 digits'),
  name: z.string().optional(),
  onboardingToken: z.string().optional(),
});

export const completeCustomerProfileSchema = z.object({
  onboardingToken: z.string().min(1, 'Onboarding session is required'),
  name: z.string().min(2, 'Please enter your full name'),
  phone: z.string().optional(),
  mobile: z.string().optional(),
  otp: z.string().optional(),
  profilePhotoUrl: z.string().optional(),
});

/**
 * Send an OTP code to a customer's Indian mobile number via MSG91 Flow or Email.
 * Endpoints:
 * - POST /api/auth/send-otp
 * - POST /api/v1/auth/send-otp
 * - POST /api/v1/auth/customer/send-otp
 */
export const sendCustomerOtp = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    let { email, phone, mobile } = req.body;
    const rawTarget = mobile || phone;

    // Check if unified target is an email address
    if (rawTarget && rawTarget.includes('@') && !email) {
      email = rawTarget;
    }

    const reqMeta = {
      ip: req.ip,
      userAgent: (req.headers['user-agent'] as string) || undefined,
    };

    // 1. Email OTP Path via Hostinger SMTP (hashed challenge, no account-existence leak)
    if (email) {
      const result = await sendCustomerEmailOtp(email, reqMeta);
      if (!result.success) {
        sendError(res, result.code, result.message, result.status);
        return;
      }
      sendSuccess(res, {
        message: result.message,
        cooldownSeconds: result.cooldownSeconds,
      });
      return;
    }

    // 2. Mobile OTP Path via MSG91 Flow SMS (hashed challenge, no account-existence leak)
    if (rawTarget) {
      const result = await sendCustomerMobileOtp(rawTarget, reqMeta);
      if (!result.success) {
        sendError(res, result.code, result.message, result.status);
        return;
      }
      sendSuccess(res, {
        message: result.message,
        mobile: result.mobile,
        cooldownSeconds: result.cooldownSeconds,
      });
      return;
    }

    sendError(res, 'BAD_REQUEST', 'Please provide a valid Indian mobile number or email address', 400);
  } catch (error) {
    next(error);
  }
};

/**
 * Verify customer OTP and sign-in or create customer account.
 * Endpoints:
 * - POST /api/auth/verify-otp
 * - POST /api/v1/auth/verify-otp
 * - POST /api/v1/auth/customer/verify-otp
 */
export const verifyCustomerOtp = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    let { email, phone, mobile, otp, name } = req.body;
    const rawTarget = mobile || phone;

    if (rawTarget && rawTarget.includes('@') && !email) {
      email = rawTarget;
    }

    const cleanOtp = (otp ? otp.toString().trim() : '');
    if (!cleanOtp) {
      sendError(res, 'BAD_REQUEST', 'Verification OTP is required', 400);
      return;
    }

    const onboardingToken = (req.body?.onboardingToken as string | undefined) || undefined;

    // 1. Email OTP verification — existing customers sign in; new identities get an onboarding token.
    if (email) {
      const result = await verifyCustomerEmailOtp({
        email,
        otp: cleanOtp,
        onboardingToken,
      });
      if (!result.success) {
        sendError(res, result.code, result.message, result.status);
        return;
      }
      sendSuccess(res, result.payload);
      return;
    }

    // 2. Mobile OTP verification — never creates an incomplete account.
    if (rawTarget) {
      const result = await verifyCustomerMobileOtp({
        rawMobile: rawTarget,
        otp: cleanOtp,
        onboardingToken,
      });
      if (!result.success) {
        sendError(res, result.code, result.message, result.status);
        return;
      }
      sendSuccess(res, result.payload);
      return;
    }

    sendError(res, 'BAD_REQUEST', 'Email or mobile number is required', 400);
  } catch (error) {
    next(error);
  }
};

/**
 * Completes customer onboarding after identity verification.
 * Requires a verified mobile number before the account is created.
 * Endpoint: POST /api/v1/auth/customer/complete-profile
 */
export const completeCustomerOnboarding = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { onboardingToken, name, phone, mobile, otp, profilePhotoUrl } = req.body;
    const result = await completeCustomerProfile({
      onboardingToken,
      name,
      phone: phone || mobile,
      otp,
      profilePhotoUrl,
    });
    if (!result.success) {
      sendError(res, result.code, result.message, result.status);
      return;
    }
    sendSuccess(res, result.payload, 200);
  } catch (error) {
    next(error);
  }
};

export const forgotPasswordSendOtpSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  role: z.string().optional(),
});

export const forgotPasswordVerifyOtpSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  otp: z.string().min(4, 'OTP must be at least 4 digits'),
});

export const resetPasswordSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  otp: z.string().optional(),
  resetToken: z.string().optional(),
  newPassword: z.string().min(6, 'Password must be at least 6 characters'),
  role: z.string().optional(),
});

interface PasswordResetValidationResult {
  valid: boolean;
  user?: any;
  error?: {
    code: string;
    message: string;
    statusCode: number;
  };
}

/**
 * Validates that an email belongs to a registered and properly onboarded user
 * matching the required portal hierarchy before any OTP is generated or sent.
 */
async function validateUserForPasswordReset(
  cleanEmail: string,
  role?: string
): Promise<PasswordResetValidationResult> {
  const user = await prisma.user.findFirst({
    where: {
      email: cleanEmail,
      deletedAt: null,
    },
    include: {
      vendorProfile: true,
      employeeProfile: {
        include: {
          vendor: true,
        },
      },
      customerProfile: true,
      managerProfile: true,
    },
  });

  if (!user) {
    return {
      valid: false,
      error: {
        code: 'USER_NOT_FOUND',
        message: 'This email is not registered. Please contact your Super Admin or Service Provider to onboard your account.',
        statusCode: 404,
      },
    };
  }

  // Account status verification
  if (user.status === 'SUSPENDED') {
    return {
      valid: false,
      error: {
        code: 'ACCOUNT_SUSPENDED',
        message: 'Your account has been suspended. Please contact Super Admin support.',
        statusCode: 403,
      },
    };
  }

  if (user.status === 'PENDING_APPROVAL') {
    return {
      valid: false,
      error: {
        code: 'ACCOUNT_PENDING',
        message: 'Your account is pending Super Admin approval. Password reset is not available until your account has been approved.',
        statusCode: 403,
      },
    };
  }

  if (user.status === 'INACTIVE') {
    return {
      valid: false,
      error: {
        code: 'ACCOUNT_INACTIVE',
        message: 'Your account is inactive. Please contact Super Admin to reactivate your account.',
        statusCode: 403,
      },
    };
  }

  // Role & portal hierarchy verification
  if (role) {
    const rawRole = role.toUpperCase().trim();
    const targetRole = normalizePortalRole(rawRole) || rawRole;

    if (user.role !== targetRole) {
        const portalLabel =
          rawRole === 'VENDOR'
            ? 'Home Service Provider'
            : rawRole === 'PROVIDER' || rawRole === 'EMPLOYEE'
            ? 'Home Service Expert'
            : rawRole === 'MANAGER'
            ? 'Manager'
            : rawRole;
        const actualLabel =
          user.role === 'VENDOR'
            ? 'Home Service Provider'
            : user.role === 'EMPLOYEE'
            ? 'Home Service Expert'
            : user.role === 'CUSTOMER'
            ? 'Customer'
            : user.role === 'OPERATIONS_MANAGER'
            ? 'Manager'
            : user.role;

        return {
          valid: false,
          error: {
            code: 'ROLE_MISMATCH',
            message: `This email is registered as ${actualLabel}, not as a ${portalLabel}. Please use the correct portal.`,
            statusCode: 403,
          },
        };
      }

    // Role-specific onboarding hierarchy verification
    if (user.role === 'VENDOR') {
      if (!user.vendorProfile) {
        return {
          valid: false,
          error: {
            code: 'PROFILE_NOT_FOUND',
            message: 'Home Service Provider profile has not been onboarded by Super Admin.',
            statusCode: 403,
          },
        };
      }
      if (!user.vendorProfile.isActive) {
        return {
          valid: false,
          error: {
            code: 'VENDOR_INACTIVE',
            message: 'Your Provider business profile is inactive. Please contact Super Admin.',
            statusCode: 403,
          },
        };
      }
    } else if (user.role === 'EMPLOYEE') {
      if (!user.employeeProfile) {
        return {
          valid: false,
          error: {
            code: 'PROFILE_NOT_FOUND',
            message: 'Expert profile has not been onboarded by a Home Service Provider.',
            statusCode: 403,
          },
        };
      }
      if (!user.employeeProfile.vendor) {
        return {
          valid: false,
          error: {
            code: 'PROVIDER_UNLINKED',
            message: 'This Expert account is not linked to any registered Home Service Provider.',
            statusCode: 403,
          },
        };
      }
      if (!user.employeeProfile.vendor.isActive) {
        return {
          valid: false,
          error: {
            code: 'PROVIDER_INACTIVE',
            message: 'The Home Service Provider linked to this Expert account is inactive. Please contact your Provider.',
            statusCode: 403,
          },
        };
      }
    } else if (targetRole === 'OPERATIONS_MANAGER') {
      if (user.role !== 'OPERATIONS_MANAGER' || !user.managerProfile) {
        return {
          valid: false,
          error: {
            code: 'UNAUTHORIZED_MANAGER',
            message: 'This email is not registered as an authorized Manager. Ask Super Admin to provision a Manager login for the vendor app.',
            statusCode: 403,
          },
        };
      }
    }
  }

  return { valid: true, user };
}

/**
 * Generates and sends a 6-digit OTP to the user's email via Hostinger SMTP for password reset.
 * Strict validation ensures OTP is only dispatched to registered, approved, and correctly linked accounts.
 * Endpoint: POST /api/v1/auth/forgot-password/send-otp
 */
export const forgotPasswordSendOtp = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { email, role } = req.body;
    const cleanEmail = email.toLowerCase().trim();

    const validation = await validateUserForPasswordReset(cleanEmail, role);
    if (!validation.valid || !validation.user) {
      sendError(
        res,
        validation.error?.code || 'UNAUTHORIZED',
        validation.error?.message || 'Access denied.',
        validation.error?.statusCode || 400
      );
      return;
    }

    const user = validation.user;

    const result = await generateAndSendEmailOtp(cleanEmail);
    if (!result.success) {
      sendError(res, 'OTP_SEND_FAILED', result.message, 400);
      return;
    }

    logger.info({ email: cleanEmail, role: user.role }, 'Forgot password OTP dispatched via Hostinger SMTP');
    sendSuccess(res, {
      message: result.message,
      cooldownSeconds: result.cooldownSeconds,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Verifies the 6-digit OTP code submitted for password reset.
 * Endpoint: POST /api/v1/auth/forgot-password/verify-otp
 */
export const forgotPasswordVerifyOtp = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { email, otp } = req.body;
    const cleanEmail = email.toLowerCase().trim();

    const verification = verifyEmailOtp(cleanEmail, otp ? otp.toString().trim() : '');
    if (!verification.valid) {
      sendError(res, 'INVALID_OTP', verification.message || 'Invalid or expired verification code.', 400);
      return;
    }

    const user = await prisma.user.findFirst({
      where: { email: cleanEmail, deletedAt: null },
      select: { id: true, role: true, email: true },
    });

    if (!user) {
      sendError(res, 'USER_NOT_FOUND', 'No account found with this email address.', 404);
      return;
    }

    const resetToken = generateAccessToken({
      userId: user.id,
      role: user.role,
      email: cleanEmail,
    });

    logger.info({ email: cleanEmail }, 'Forgot password OTP successfully verified');
    sendSuccess(res, {
      valid: true,
      message: 'Verification code verified successfully.',
      resetToken,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Resets the user's password in PostgreSQL after OTP verification.
 * Endpoint: POST /api/v1/auth/forgot-password/reset
 */
export const resetPassword = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { email, otp, resetToken, newPassword, role } = req.body;
    const cleanEmail = email.toLowerCase().trim();

    if (!newPassword || newPassword.length < 6) {
      sendError(res, 'INVALID_PASSWORD', 'New password must be at least 6 characters.', 400);
      return;
    }

    // Verify either resetToken or OTP
    if (resetToken) {
      try {
        const decoded = verifyAccessToken(resetToken);
        if (decoded.email.toLowerCase() !== cleanEmail) {
          sendError(res, 'INVALID_TOKEN', 'Reset token does not match email address.', 400);
          return;
        }
      } catch {
        sendError(res, 'INVALID_TOKEN', 'Reset token has expired or is invalid. Please request a new code.', 400);
        return;
      }
    } else if (otp) {
      const verification = verifyEmailOtp(cleanEmail, otp.toString().trim());
      if (!verification.valid) {
        sendError(res, 'INVALID_OTP', verification.message || 'Invalid or expired verification code.', 400);
        return;
      }
    } else {
      sendError(res, 'UNAUTHORIZED', 'Verification required before resetting password.', 401);
      return;
    }

    const validation = await validateUserForPasswordReset(cleanEmail, role);
    if (!validation.valid || !validation.user) {
      sendError(
        res,
        validation.error?.code || 'UNAUTHORIZED',
        validation.error?.message || 'Password reset not allowed.',
        validation.error?.statusCode || 400
      );
      return;
    }

    const user = validation.user;

    const hashedPassword = await hashPassword(newPassword);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: hashedPassword,
        updatedAt: new Date(),
      },
    });

    logger.info({ userId: user.id, email: user.email }, 'User password successfully reset');
    sendSuccess(res, {
      success: true,
      message: 'Password reset successfully. You can now log in with your new password.',
    });
  } catch (error) {
    next(error);
  }
};

