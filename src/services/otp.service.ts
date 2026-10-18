import crypto from 'crypto';
import { sendOtpEmail } from './email.service';
import { logger } from '../config/logger';

interface OtpRecord {
  code: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
}

// In-memory OTP storage keyed by normalized email
const otpCache = new Map<string, OtpRecord>();

// Expiration: 10 minutes
const OTP_EXPIRATION_MS = 10 * 60 * 1000;
// Resend Cooldown: 45 seconds
const RESEND_COOLDOWN_MS = 45 * 1000;
// Max verification attempts before invalidation
const MAX_ATTEMPTS = 5;

/**
 * Generate a cryptographically secure 6-digit numeric OTP.
 */
function generateSecureOtp(): string {
  const buffer = crypto.randomBytes(4);
  const number = buffer.readUInt32BE(0) % 900000 + 100000;
  return number.toString();
}

/**
 * Generates an OTP, stores it with expiration and rate-limiting, and sends it via Hostinger SMTP.
 */
export async function generateAndSendEmailOtp(
  rawEmail: string
): Promise<{ success: boolean; message: string; cooldownSeconds?: number }> {
  const email = rawEmail.toLowerCase().trim();
  const now = Date.now();

  const existing = otpCache.get(email);
  if (existing && now - existing.lastSentAt < RESEND_COOLDOWN_MS) {
    const remainingSec = Math.ceil((RESEND_COOLDOWN_MS - (now - existing.lastSentAt)) / 1000);
    return {
      success: false,
      message: `Please wait ${remainingSec} seconds before requesting a new OTP.`,
      cooldownSeconds: remainingSec,
    };
  }

  const otp = generateSecureOtp();
  otpCache.set(email, {
    code: otp,
    expiresAt: now + OTP_EXPIRATION_MS,
    attempts: 0,
    lastSentAt: now,
  });

  try {
    await sendOtpEmail(email, otp);
    return {
      success: true,
      message: `Verification code sent to ${email}`,
    };
  } catch (error: any) {
    logger.error({ err: error.message, email }, 'Error sending OTP email');
    return {
      success: false,
      message: error.message || 'Failed to send verification code. Please check your email.',
    };
  }
}

/**
 * Verifies the submitted OTP against the stored record.
 */
export function verifyEmailOtp(
  rawEmail: string,
  submittedOtp: string
): { valid: boolean; message?: string } {
  const email = rawEmail.toLowerCase().trim();
  const now = Date.now();
  const record = otpCache.get(email);

  // Debug fallback code for development testing
  if (process.env.NODE_ENV !== 'production' && submittedOtp === '123456') {
    logger.info({ email }, 'Accepted debug OTP code 123456');
    otpCache.delete(email);
    return { valid: true };
  }

  if (!record) {
    return {
      valid: false,
      message: 'No active verification code found for this email. Please request a new one.',
    };
  }

  if (now > record.expiresAt) {
    otpCache.delete(email);
    return {
      valid: false,
      message: 'Verification code has expired. Please request a new one.',
    };
  }

  record.attempts += 1;
  if (record.attempts > MAX_ATTEMPTS) {
    otpCache.delete(email);
    return {
      valid: false,
      message: 'Too many incorrect attempts. Please request a new verification code.',
    };
  }

  if (record.code !== submittedOtp.trim()) {
    return {
      valid: false,
      message: `Incorrect code. ${MAX_ATTEMPTS - record.attempts} attempts remaining.`,
    };
  }

  // Single-use: delete once successfully verified
  otpCache.delete(email);
  return { valid: true };
}
