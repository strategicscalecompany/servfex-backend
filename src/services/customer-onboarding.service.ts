import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { sendOtpSms, maskMobile } from './msg91.service';
import { sendOtpEmail } from './email.service';
import { uploadToCloudinary } from '../utils/cloudinary';
import {
  generateAccessToken,
  generateRefreshToken,
  generateOnboardingToken,
  verifyOnboardingToken,
  OnboardingTokenPayload,
} from '../utils/token';
import { normalizeIndianMobile, generateNumericOtp, hashOtp, compareOtp } from '../utils/otp.util';

const PHONE_PLACEHOLDER_DOMAIN = '@phone.servfex.com';
const EMAIL_CHALLENGE_PREFIX = 'email:';
const MAX_AVATAR_BYTES = 6 * 1024 * 1024;

export type ServiceError = {
  success: false;
  code: string;
  message: string;
  status: number;
};

export type AuthSuccess = {
  success: true;
  payload: {
    isNewUser: false;
    user: ReturnType<typeof toCustomerPayload>;
    token: string;
    refreshToken: string;
  };
};

export type OnboardingSuccess = {
  success: true;
  payload: {
    isNewUser: true;
    onboardingToken: string;
    profile: {
      email: string;
      phone: string;
      name: string;
      photoUrl: string | null;
      emailVerified: boolean;
      phoneVerified: boolean;
    };
  };
};

export type CustomerAuthResult = AuthSuccess | OnboardingSuccess | ServiceError;

function isPlaceholderEmail(email?: string | null): boolean {
  return Boolean(email && email.toLowerCase().endsWith(PHONE_PLACEHOLDER_DOMAIN));
}

function phonePlaceholderEmail(clean10: string): string {
  return `${clean10}${PHONE_PLACEHOLDER_DOMAIN}`;
}

function emailChallengeKey(email: string): string {
  return `${EMAIL_CHALLENGE_PREFIX}${email.toLowerCase().trim()}`;
}

function publicOnboardingProfile(claims: OnboardingTokenPayload) {
  return {
    email: claims.email && !isPlaceholderEmail(claims.email) ? claims.email : '',
    phone: claims.phone || '',
    name: claims.name || '',
    photoUrl: claims.photoUrl || null,
    emailVerified: Boolean(claims.emailVerified),
    phoneVerified: Boolean(claims.phoneVerified),
  };
}

function onboardingPayload(claims: OnboardingTokenPayload): OnboardingSuccess['payload'] {
  return {
    isNewUser: true,
    onboardingToken: generateOnboardingToken(claims),
    profile: publicOnboardingProfile(claims),
  };
}

function toCustomerPayload(user: {
  id: string;
  email: string;
  phone: string | null;
  name: string;
  role: string;
  status: string;
  profilePhotoUrl: string | null;
  isVerified: boolean;
}) {
  return {
    id: user.id,
    email: isPlaceholderEmail(user.email) ? '' : user.email,
    phone: user.phone || '',
    name: user.name,
    role: 'CUSTOMER' as const,
    actualRole: user.role,
    status: user.status,
    profilePhotoUrl: user.profilePhotoUrl,
    isVerified: user.isVerified,
  };
}

async function issueSession(user: {
  id: string;
  email: string;
  phone: string | null;
  name: string;
  role: string;
  status: string;
  profilePhotoUrl: string | null;
  isVerified: boolean;
}): Promise<AuthSuccess> {
  const token = generateAccessToken({
    userId: user.id,
    role: user.role as any,
    email: user.email,
  });
  const refreshToken = generateRefreshToken({
    userId: user.id,
    role: user.role as any,
    email: user.email,
  });

  return {
    success: true,
    payload: {
      isNewUser: false,
      user: toCustomerPayload(user),
      token,
      refreshToken,
    },
  };
}

function identityInUse(kind: 'mobile number' | 'email' | 'Google account'): ServiceError {
  return {
    success: false,
    code: 'IDENTITY_IN_USE',
    message: `This ${kind} is already linked to another ServFex account.`,
    status: 409,
  };
}

function forbiddenRole(): ServiceError {
  return {
    success: false,
    code: 'FORBIDDEN',
    message: 'This identity is registered with a partner account and cannot be used for the customer app.',
    status: 403,
  };
}

function suspended(): ServiceError {
  return {
    success: false,
    code: 'ACCOUNT_SUSPENDED',
    message: 'Your ServFex account has been suspended.',
    status: 403,
  };
}

type CustomerUser = Awaited<ReturnType<typeof prisma.user.findFirst>>;

function assertCustomerAccount(
  user: NonNullable<CustomerUser>,
  opts?: { allowDeleted?: boolean }
): ServiceError | null {
  if (user.role !== 'CUSTOMER') return forbiddenRole();
  if (user.status === 'SUSPENDED') return suspended();
  if (opts?.allowDeleted && user.deletedAt) return null;
  if (user.status === 'INACTIVE' || user.status === 'PENDING_APPROVAL') {
    return {
      success: false,
      code: 'ACCOUNT_INACTIVE',
      message: 'Your account is not currently active.',
      status: 403,
    };
  }
  return null;
}

function phoneIdentityOr(params: {
  phone?: string;
  displayPhone?: string;
  normalizedMobile?: string;
}): Array<Record<string, string>> {
  const rawValues = [params.phone, params.displayPhone, params.normalizedMobile].filter(
    (value): value is string => Boolean(value && value.trim())
  );
  const or: Array<Record<string, string>> = [];
  const seen = new Set<string>();

  const addPhone = (value: string) => {
    if (!value || seen.has(`p:${value}`)) return;
    seen.add(`p:${value}`);
    or.push({ phone: value });
  };
  const addEmail = (value: string) => {
    if (!value || seen.has(`e:${value}`)) return;
    seen.add(`e:${value}`);
    or.push({ email: value });
  };

  for (const raw of rawValues) {
    addPhone(raw);
    const mobileVal = normalizeIndianMobile(raw);
    const clean10 = mobileVal.clean10Digit || raw.replace(/\D/g, '').slice(-10);
    if (clean10.length === 10 && /^[6-9]\d{9}$/.test(clean10)) {
      addPhone(clean10);
      addPhone(`91${clean10}`);
      addPhone(`+91${clean10}`);
      addPhone(`+91 ${clean10}`);
      addPhone(`+91 ${clean10.slice(0, 5)} ${clean10.slice(5)}`);
      addPhone(`0${clean10}`);
      addEmail(phonePlaceholderEmail(clean10));
    }
  }
  return or;
}

async function findUserByIdentities(or: Array<Record<string, string>>) {
  if (or.length === 0) return null;
  return prisma.user.findFirst({
    where: { OR: or },
    include: { customerProfile: true },
  });
}

async function unsetDeletedAt(userId: string) {
  try {
    await prisma.$runCommandRaw({
      update: 'User',
      updates: [{ q: { _id: userId }, u: { $unset: { deletedAt: '' } } }],
    });
  } catch (err: any) {
    logger.warn({ userId, err: err?.message }, 'Failed to unset deletedAt on revived customer');
  }
}

async function reuseCustomerAccount(
  user: NonNullable<CustomerUser>,
  patch: {
    name?: string;
    phone?: string;
    email?: string;
    googleUid?: string;
    photoUrl?: string | null;
  }
): Promise<AuthSuccess | ServiceError> {
  const recovering = Boolean(user.deletedAt);
  const roleErr = assertCustomerAccount(user, { allowDeleted: recovering });
  if (roleErr) return roleErr;

  const incomingEmail =
    patch.email && !isPlaceholderEmail(patch.email) ? patch.email.toLowerCase().trim() : undefined;
  const nextEmail = recovering || isPlaceholderEmail(user.email) ? incomingEmail || user.email : user.email;

  try {
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        name: patch.name?.trim() || user.name,
        phone: recovering ? patch.phone || user.phone : user.phone || patch.phone,
        email: nextEmail,
        firebaseUid: user.firebaseUid || patch.googleUid || undefined,
        profilePhotoUrl: patch.photoUrl || user.profilePhotoUrl,
        isVerified: true,
        lastLoginAt: new Date(),
        status: recovering && user.status !== 'SUSPENDED' ? 'ACTIVE' : user.status,
        deletedAt: null,
        customerProfile: {
          upsert: {
            create: {},
            update: {},
          },
        },
      },
      include: { customerProfile: true },
    });

    if (recovering) {
      await unsetDeletedAt(user.id);
      logger.info({ userId: user.id }, 'Revived previously deleted customer account');
    }

    return issueSession(updated);
  } catch (err: any) {
    if (err?.code === 'P2002') {
      if (recovering) await unsetDeletedAt(user.id);
      logger.warn({ userId: user.id }, 'Identity patch collided; signing into existing customer as-is');
      return issueSession(user);
    }
    throw err;
  }
}

export async function findCustomerByPhone(params: {
  phone?: string;
  displayPhone?: string;
  normalizedMobile?: string;
}) {
  return findUserByIdentities(phoneIdentityOr(params));
}

export async function findCustomerByEmail(email: string) {
  const cleanEmail = email.toLowerCase().trim();
  if (!cleanEmail || isPlaceholderEmail(cleanEmail)) return null;
  return findUserByIdentities([{ email: cleanEmail }]);
}

export async function findCustomerByGoogle(params: { firebaseUid?: string; email?: string }) {
  const or: Array<Record<string, string>> = [];
  if (params.firebaseUid) or.push({ firebaseUid: params.firebaseUid });
  if (params.email && !isPlaceholderEmail(params.email)) {
    or.push({ email: params.email.toLowerCase().trim() });
  }
  return findUserByIdentities(or);
}

async function consumeOtpChallenge(
  destinationKey: string,
  otp: string
): Promise<{ ok: true } | ServiceError> {
  const cleanOtp = otp.toString().trim();
  const now = Date.now();

  const challenge = await prisma.otpChallenge.findFirst({
    where: {
      mobile: destinationKey,
      isConsumed: false,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!challenge) {
    return {
      success: false,
      code: 'OTP_NOT_FOUND',
      message: 'No active OTP request found. Please request a new OTP.',
      status: 400,
    };
  }

  if (now > challenge.expiresAt.getTime()) {
    await prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { isConsumed: true },
    });
    return {
      success: false,
      code: 'OTP_EXPIRED',
      message: 'Verification code has expired. Please request a new one.',
      status: 400,
    };
  }

  if (challenge.attempts >= challenge.maxAttempts) {
    await prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { isConsumed: true },
    });
    return {
      success: false,
      code: 'OTP_MAX_ATTEMPTS_EXCEEDED',
      message: 'Maximum verification attempts exceeded. Please request a new verification code.',
      status: 400,
    };
  }

  const isMatch = compareOtp(cleanOtp, challenge.otpHash);
  if (!isMatch) {
    const updated = await prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
    });
    const remaining = Math.max(0, updated.maxAttempts - updated.attempts);
    if (remaining <= 0) {
      await prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { isConsumed: true },
      });
      return {
        success: false,
        code: 'OTP_MAX_ATTEMPTS_EXCEEDED',
        message: 'Maximum verification attempts exceeded. Please request a new verification code.',
        status: 400,
      };
    }
    return {
      success: false,
      code: 'INVALID_OTP',
      message: `Incorrect verification code. ${remaining} attempt(s) remaining.`,
      status: 400,
    };
  }

  const consumeUpdate = await prisma.otpChallenge.updateMany({
    where: { id: challenge.id, isConsumed: false },
    data: { isConsumed: true },
  });

  if (consumeUpdate.count === 0) {
    return {
      success: false,
      code: 'OTP_ALREADY_USED',
      message: 'This OTP has already been verified.',
      status: 400,
    };
  }

  return { ok: true };
}

async function createHashedChallenge(destinationKey: string, reqMeta: { ip?: string; userAgent?: string }) {
  const now = Date.now();
  const latestChallenge = await prisma.otpChallenge.findFirst({
    where: { mobile: destinationKey, isConsumed: false },
    orderBy: { createdAt: 'desc' },
  });

  if (latestChallenge && now < latestChallenge.resendUnlockAt.getTime()) {
    const remainingSeconds = Math.ceil((latestChallenge.resendUnlockAt.getTime() - now) / 1000);
    return {
      blocked: true as const,
      remainingSeconds,
    };
  }

  const otp = generateNumericOtp();
  const otpHash = hashOtp(otp);

  await prisma.otpChallenge.updateMany({
    where: { mobile: destinationKey, isConsumed: false },
    data: { isConsumed: true },
  });

  const expiresAt = new Date(now + env.OTP_EXPIRY_MINUTES * 60 * 1000);
  const resendUnlockAt = new Date(now + env.OTP_RESEND_COOLDOWN_SECONDS * 1000);

  const challenge = await prisma.otpChallenge.create({
    data: {
      mobile: destinationKey,
      otpHash,
      attempts: 0,
      maxAttempts: env.OTP_MAX_ATTEMPTS,
      isConsumed: false,
      expiresAt,
      resendUnlockAt,
      ipAddress: reqMeta.ip || null,
      userAgent: reqMeta.userAgent || null,
    },
  });

  return { blocked: false as const, otp, challenge };
}

export async function sendCustomerEmailOtp(
  email: string,
  reqMeta: { ip?: string; userAgent?: string }
): Promise<{ success: true; message: string; cooldownSeconds: number } | ServiceError> {
  const cleanEmail = email.toLowerCase().trim();
  const issued = await createHashedChallenge(emailChallengeKey(cleanEmail), reqMeta);
  if (issued.blocked) {
    return {
      success: false,
      code: 'OTP_RESEND_COOLDOWN',
      message: `Please wait ${issued.remainingSeconds} seconds before requesting a new OTP.`,
      status: 429,
    };
  }

  try {
    await sendOtpEmail(cleanEmail, issued.otp);
  } catch (err: any) {
    await prisma.otpChallenge.update({
      where: { id: issued.challenge.id },
      data: { isConsumed: true },
    });
    logger.error({ err: err?.message, email: cleanEmail }, 'Email OTP delivery failed');
    return {
      success: false,
      code: 'OTP_SEND_FAILED',
      message: err?.message || 'Failed to send verification code. Please try again.',
      status: 502,
    };
  }

  logger.info({ email: cleanEmail }, 'Dispatched customer email OTP');
  return {
    success: true,
    message: `Verification code sent to ${cleanEmail}. Valid for ${env.OTP_EXPIRY_MINUTES} minutes.`,
    cooldownSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
  };
}

export async function sendCustomerMobileOtp(
  rawMobile: string,
  reqMeta: { ip?: string; userAgent?: string }
): Promise<{ success: true; message: string; mobile: string; cooldownSeconds: number } | ServiceError> {
  const mobileVal = normalizeIndianMobile(rawMobile);
  if (!mobileVal.valid || !mobileVal.normalized) {
    return {
      success: false,
      code: 'INVALID_MOBILE_NUMBER',
      message: mobileVal.error || 'Please enter a valid 10-digit Indian mobile number',
      status: 400,
    };
  }

  const issued = await createHashedChallenge(mobileVal.normalized, reqMeta);
  if (issued.blocked) {
    return {
      success: false,
      code: 'OTP_RESEND_COOLDOWN',
      message: `Please wait ${issued.remainingSeconds} seconds before requesting a new OTP.`,
      status: 429,
    };
  }

  try {
    await sendOtpSms(mobileVal.normalized, issued.otp);
  } catch (smsError: any) {
    await prisma.otpChallenge.update({
      where: { id: issued.challenge.id },
      data: { isConsumed: true },
    });
    logger.error(
      { err: smsError.message, mobileMasked: maskMobile(mobileVal.normalized) },
      'MSG91 SMS delivery failed'
    );
    return {
      success: false,
      code: 'SMS_DELIVERY_FAILED',
      message: smsError.message || 'Failed to dispatch verification SMS. Please try again.',
      status: 502,
    };
  }

  logger.info({ mobileMasked: maskMobile(mobileVal.normalized) }, 'Dispatched OTP SMS via MSG91');
  return {
    success: true,
    message: `OTP sent successfully to ${maskMobile(mobileVal.normalized)}. Valid for ${env.OTP_EXPIRY_MINUTES} minutes.`,
    mobile: maskMobile(mobileVal.normalized),
    cooldownSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
  };
}

function mergeOnboardingClaims(
  current: Partial<OnboardingTokenPayload> | null,
  patch: Partial<OnboardingTokenPayload>
): OnboardingTokenPayload {
  return {
    purpose: 'CUSTOMER_ONBOARDING',
    email: patch.email ?? current?.email,
    phone: patch.phone ?? current?.phone,
    displayPhone: patch.displayPhone ?? current?.displayPhone,
    normalizedMobile: patch.normalizedMobile ?? current?.normalizedMobile,
    googleUid: patch.googleUid ?? current?.googleUid,
    name: patch.name ?? current?.name,
    photoUrl: patch.photoUrl ?? current?.photoUrl,
    emailVerified: Boolean(patch.emailVerified ?? current?.emailVerified),
    phoneVerified: Boolean(patch.phoneVerified ?? current?.phoneVerified),
  };
}

export function parseOnboardingToken(raw?: string): OnboardingTokenPayload | ServiceError | null {
  if (!raw) return null;
  try {
    return verifyOnboardingToken(raw);
  } catch {
    return {
      success: false,
      code: 'INVALID_ONBOARDING_TOKEN',
      message: 'Your verification session has expired. Please start again.',
      status: 401,
    };
  }
}

export async function verifyCustomerEmailOtp(params: {
  email: string;
  otp: string;
  onboardingToken?: string;
}): Promise<CustomerAuthResult> {
  const cleanEmail = params.email.toLowerCase().trim();
  const consumed = await consumeOtpChallenge(emailChallengeKey(cleanEmail), params.otp);
  if (!('ok' in consumed)) return consumed;

  const existingClaims = parseOnboardingToken(params.onboardingToken);
  if (existingClaims && 'success' in existingClaims && existingClaims.success === false) {
    return existingClaims;
  }

  const user = await findCustomerByEmail(cleanEmail);
  if (user) {
    const claims = existingClaims && !('success' in existingClaims) ? existingClaims : null;
    logger.info({ userId: user.id, email: cleanEmail }, 'Existing customer authenticated via email OTP');
    return reuseCustomerAccount(user, {
      name: claims?.name,
      phone: claims?.phone,
      email: cleanEmail,
      googleUid: claims?.googleUid,
      photoUrl: claims?.photoUrl,
    });
  }

  if (existingClaims && !('success' in existingClaims)) {
    const merged = mergeOnboardingClaims(existingClaims, {
      email: cleanEmail,
      emailVerified: true,
    });
    return { success: true, payload: onboardingPayload(merged) };
  }

  logger.info({ email: cleanEmail }, 'New customer email identity verified; awaiting profile completion');
  return {
    success: true,
    payload: onboardingPayload({
      purpose: 'CUSTOMER_ONBOARDING',
      email: cleanEmail,
      emailVerified: true,
      phoneVerified: false,
    }),
  };
}

export async function verifyCustomerMobileOtp(params: {
  rawMobile: string;
  otp: string;
  onboardingToken?: string;
}): Promise<CustomerAuthResult> {
  const mobileVal = normalizeIndianMobile(params.rawMobile);
  if (!mobileVal.valid || !mobileVal.normalized || !mobileVal.clean10Digit || !mobileVal.displayPhone) {
    return {
      success: false,
      code: 'INVALID_MOBILE_NUMBER',
      message: mobileVal.error || 'Please enter a valid 10-digit Indian mobile number',
      status: 400,
    };
  }

  const consumed = await consumeOtpChallenge(mobileVal.normalized, params.otp);
  if (!('ok' in consumed)) return consumed;

  const existingClaims = parseOnboardingToken(params.onboardingToken);
  if (existingClaims && 'success' in existingClaims && existingClaims.success === false) {
    return existingClaims;
  }

  const phonePatch: Partial<OnboardingTokenPayload> = {
    phone: mobileVal.clean10Digit,
    displayPhone: mobileVal.displayPhone,
    normalizedMobile: mobileVal.normalized,
    phoneVerified: true,
  };

  const user = await findCustomerByPhone({
    phone: mobileVal.clean10Digit,
    displayPhone: mobileVal.displayPhone,
    normalizedMobile: mobileVal.normalized,
  });

  if (user) {
    const claims = existingClaims && !('success' in existingClaims) ? existingClaims : null;
    logger.info(
      { userId: user.id, mobileMasked: maskMobile(mobileVal.normalized) },
      'Existing customer authenticated via mobile OTP'
    );
    return reuseCustomerAccount(user, {
      name: claims?.name,
      phone: mobileVal.clean10Digit,
      email: claims?.email,
      googleUid: claims?.googleUid,
      photoUrl: claims?.photoUrl,
    });
  }

  if (existingClaims && !('success' in existingClaims)) {
    const merged = mergeOnboardingClaims(existingClaims, phonePatch);
    return { success: true, payload: onboardingPayload(merged) };
  }

  logger.info(
    { mobileMasked: maskMobile(mobileVal.normalized) },
    'New customer mobile identity verified; awaiting profile completion'
  );
  return {
    success: true,
    payload: onboardingPayload({
      purpose: 'CUSTOMER_ONBOARDING',
      phone: mobileVal.clean10Digit,
      displayPhone: mobileVal.displayPhone,
      normalizedMobile: mobileVal.normalized,
      email: phonePlaceholderEmail(mobileVal.clean10Digit),
      emailVerified: false,
      phoneVerified: true,
    }),
  };
}

export async function resolveGoogleCustomer(params: {
  email: string;
  name?: string;
  firebaseUid?: string;
  photoUrl?: string;
}): Promise<CustomerAuthResult> {
  const cleanEmail = params.email.toLowerCase().trim();
  const user = await findCustomerByGoogle({ firebaseUid: params.firebaseUid, email: cleanEmail });

  if (user) {
    logger.info({ userId: user.id, email: cleanEmail }, 'Existing customer authenticated via Google');
    return reuseCustomerAccount(user, {
      name: params.name,
      email: cleanEmail,
      googleUid: params.firebaseUid,
      photoUrl: params.photoUrl,
    });
  }

  logger.info({ email: cleanEmail }, 'New Google identity verified; awaiting profile completion');
  return {
    success: true,
    payload: onboardingPayload({
      purpose: 'CUSTOMER_ONBOARDING',
      email: cleanEmail,
      googleUid: params.firebaseUid,
      name: params.name?.trim() || cleanEmail.split('@')[0],
      photoUrl: params.photoUrl,
      emailVerified: true,
      phoneVerified: false,
    }),
  };
}

async function hostProfilePhoto(raw?: string | null): Promise<string | null> {
  if (!raw || !raw.trim()) return null;
  const value = raw.trim();
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value.slice(0, 2048);
  }
  if (!value.startsWith('data:image/')) {
    return null;
  }
  const approxBytes = Math.floor((value.length * 3) / 4);
  if (approxBytes > MAX_AVATAR_BYTES) {
    throw Object.assign(new Error('Profile photo must be 6MB or smaller'), { code: 'PAYLOAD_TOO_LARGE' });
  }
  try {
    const hosted = await uploadToCloudinary(value, 'servfex/avatars');
    if (hosted && !hosted.startsWith('data:')) return hosted;
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Customer avatar upload failed; continuing without photo');
  }
  return null;
}

export async function completeCustomerProfile(params: {
  onboardingToken: string;
  name: string;
  phone?: string;
  otp?: string;
  profilePhotoUrl?: string;
}): Promise<AuthSuccess | ServiceError> {
  const claimsOrError = parseOnboardingToken(params.onboardingToken);
  if (!claimsOrError) {
    return {
      success: false,
      code: 'INVALID_ONBOARDING_TOKEN',
      message: 'Your verification session has expired. Please start again.',
      status: 401,
    };
  }
  if ('success' in claimsOrError && claimsOrError.success === false) return claimsOrError;

  let claims = claimsOrError as OnboardingTokenPayload;
  const name = params.name.trim();
  if (name.length < 2) {
    return {
      success: false,
      code: 'INVALID_NAME',
      message: 'Please enter your full name.',
      status: 400,
    };
  }

  if (!claims.phoneVerified) {
    if (!params.phone || !params.otp) {
      return {
        success: false,
        code: 'MOBILE_VERIFICATION_REQUIRED',
        message: 'Please verify your mobile number before creating your account.',
        status: 400,
      };
    }
    const verified = await verifyCustomerMobileOtp({
      rawMobile: params.phone,
      otp: params.otp,
      onboardingToken: params.onboardingToken,
    });
    if (!verified.success) return verified;
    if (!verified.payload.isNewUser) {
      return verified as AuthSuccess;
    }
    const refreshed = parseOnboardingToken(verified.payload.onboardingToken);
    if (refreshed && !('success' in refreshed)) {
      claims = refreshed;
    }
  }

  if (!claims.phoneVerified || !claims.phone) {
    return {
      success: false,
      code: 'MOBILE_VERIFICATION_REQUIRED',
      message: 'A verified mobile number is required to create a ServFex account.',
      status: 400,
    };
  }

  const realEmail = claims.email && !isPlaceholderEmail(claims.email) ? claims.email.toLowerCase().trim() : null;
  const accountEmail = realEmail || phonePlaceholderEmail(claims.phone);

  let photoUrl: string | null = claims.photoUrl || null;
  try {
    photoUrl = (await hostProfilePhoto(params.profilePhotoUrl)) || photoUrl;
  } catch (err: any) {
    if (err?.code === 'PAYLOAD_TOO_LARGE') {
      return {
        success: false,
        code: 'PAYLOAD_TOO_LARGE',
        message: err.message,
        status: 413,
      };
    }
  }

  const phoneUser = await findCustomerByPhone({
    phone: claims.phone,
    displayPhone: claims.displayPhone,
    normalizedMobile: claims.normalizedMobile,
  });
  const emailUser = realEmail ? await findCustomerByEmail(realEmail) : null;
  const googleUser = claims.googleUid
    ? await findCustomerByGoogle({ firebaseUid: claims.googleUid, email: realEmail || undefined })
    : null;

  const candidates = [phoneUser, emailUser, googleUser].filter(Boolean) as NonNullable<CustomerUser>[];
  const uniqueCandidates = candidates.filter(
    (user, index, arr) => arr.findIndex((other) => other.id === user.id) === index
  );

  const recoverable = uniqueCandidates.filter((user) => user.role === 'CUSTOMER' && user.status !== 'SUSPENDED');
  const blocking = uniqueCandidates.find((user) => user.role !== 'CUSTOMER' || user.status === 'SUSPENDED');
  if (blocking && recoverable.length === 0) {
    const roleErr = assertCustomerAccount(blocking, { allowDeleted: Boolean(blocking.deletedAt) });
    return roleErr || identityInUse('mobile number');
  }

  if (recoverable.length === 1) {
    const existing = recoverable[0];
    const recovering = Boolean(existing.deletedAt);
    if (!recovering) {
      if (realEmail && existing.email && !isPlaceholderEmail(existing.email) && existing.email !== realEmail) {
        return identityInUse('email');
      }
      if (claims.googleUid && existing.firebaseUid && existing.firebaseUid !== claims.googleUid) {
        return identityInUse('Google account');
      }
      if (existing.phone && claims.phone && existing.phone.replace(/\D/g, '').slice(-10) !== claims.phone) {
        return identityInUse('mobile number');
      }
    }

    logger.info({ userId: existing.id, recovering }, 'Reused existing customer during profile completion');
    return reuseCustomerAccount(existing, {
      name,
      phone: claims.phone,
      email: realEmail || undefined,
      googleUid: claims.googleUid,
      photoUrl,
    });
  }

  if (uniqueCandidates.length > 1) {
    return identityInUse('mobile number');
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      return tx.user.create({
        data: {
          email: accountEmail,
          phone: claims.phone,
          name,
          role: 'CUSTOMER',
          status: 'ACTIVE',
          isVerified: true,
          firebaseUid: claims.googleUid || null,
          profilePhotoUrl: photoUrl,
          lastLoginAt: new Date(),
          customerProfile: {
            create: {},
          },
        },
        include: { customerProfile: true },
      });
    });

    logger.info(
      { userId: created.id, mobileMasked: maskMobile(claims.normalizedMobile || claims.phone || '') },
      'Created customer account after mandatory mobile verification'
    );
    return issueSession(created);
  } catch (err: any) {
    if (err?.code === 'P2002') {
      const leftover = await findUserByIdentities([
        ...phoneIdentityOr({
          phone: claims.phone,
          displayPhone: claims.displayPhone,
          normalizedMobile: claims.normalizedMobile,
        }),
        ...(realEmail ? [{ email: realEmail }] : []),
        { email: accountEmail },
        ...(claims.googleUid ? [{ firebaseUid: claims.googleUid }] : []),
      ]);
      if (leftover) {
        logger.warn({ userId: leftover.id }, 'Recovered leftover identity after unique constraint on profile create');
        return reuseCustomerAccount(leftover, {
          name,
          phone: claims.phone,
          email: realEmail || undefined,
          googleUid: claims.googleUid,
          photoUrl,
        });
      }
      return {
        success: false,
        code: 'IDENTITY_IN_USE',
        message: 'An account with this mobile number or email already exists. Please continue with that identity.',
        status: 409,
      };
    }
    throw err;
  }
}
