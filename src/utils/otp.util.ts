import crypto from 'crypto';
import { env } from '../config/env';

export interface MobileValidationResult {
  valid: boolean;
  normalized?: string;    // e.g. "919876543210" (used for MSG91 and DB matching)
  displayPhone?: string;  // e.g. "+91 98765 43210"
  clean10Digit?: string;  // e.g. "9876543210"
  error?: string;
}

/**
 * Normalizes and validates Indian mobile numbers.
 * Supports inputs like:
 * - "9876543210"
 * - "+91 98765 43210"
 * - "919876543210"
 * - "09876543210"
 */
export function normalizeIndianMobile(raw: string): MobileValidationResult {
  if (!raw || typeof raw !== 'string') {
    return { valid: false, error: 'Mobile number is required' };
  }

  // Strip all non-digit characters
  const digits = raw.replace(/\D/g, '');

  let clean10 = '';
  if (digits.length === 10) {
    clean10 = digits;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    clean10 = digits.slice(1);
  } else if (digits.length === 12 && digits.startsWith('91')) {
    clean10 = digits.slice(2);
  } else {
    return {
      valid: false,
      error: 'Please enter a valid 10-digit Indian mobile number',
    };
  }

  // Indian mobile numbers must start with 6, 7, 8, or 9
  if (!/^[6-9]\d{9}$/.test(clean10)) {
    return {
      valid: false,
      error: 'Indian mobile number must start with 6, 7, 8, or 9',
    };
  }

  const normalized = `91${clean10}`;
  const displayPhone = `+91 ${clean10.slice(0, 5)} ${clean10.slice(5)}`;

  return {
    valid: true,
    normalized,
    displayPhone,
    clean10Digit: clean10,
  };
}

/**
 * Generates a cryptographically secure 6-digit numeric OTP using crypto.randomInt.
 */
export function generateNumericOtp(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Creates a keyed HMAC-SHA256 hash of the OTP using JWT_SECRET.
 * Ensures the plaintext OTP is never stored in the database.
 */
export function hashOtp(otp: string): string {
  return crypto
    .createHmac('sha256', env.JWT_SECRET)
    .update(otp.trim())
    .digest('hex');
}

/**
 * Compares a submitted OTP against the stored HMAC hash using timingSafeEqual
 * to prevent timing side-channel attacks.
 */
export function compareOtp(submittedOtp: string, storedHash: string): boolean {
  try {
    const computedHash = hashOtp(submittedOtp);
    const bufA = Buffer.from(computedHash, 'hex');
    const bufB = Buffer.from(storedHash, 'hex');

    if (bufA.length !== bufB.length) {
      return false;
    }

    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
