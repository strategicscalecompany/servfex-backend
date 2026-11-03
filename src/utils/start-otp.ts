import crypto from 'crypto';

/** Rapido-style 4-digit start PIN. Generated server-side only. */
export function generateStartOtp(): string {
  return crypto.randomInt(1000, 10000).toString();
}

export function normalizeStartOtp(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, '').trim() : '';
}

export function isValidStartOtp(value: unknown): boolean {
  return /^\d{4}$/.test(normalizeStartOtp(value));
}

export function stripStartOtp<T extends Record<string, any>>(order: T): T {
  if (!order) return order;
  const {
    qrChallengeToken: _token,
    qrChallengeExpiresAt: _expires,
    completionOtpToken: _cToken,
    completionOtpExpiresAt: _cExpires,
    ...rest
  } = order;
  return rest as T;
}

export function customerStartOtpPayload(booking: {
  qrChallengeToken?: string | null;
  qrVerifiedAt?: Date | null;
}): string | null {
  if (booking.qrVerifiedAt) return null;
  const token = booking.qrChallengeToken || null;
  return token && /^\d{4}$/.test(token) ? token : token;
}

export function customerCompletionOtpPayload(booking: {
  completionOtpToken?: string | null;
  completionOtpVerifiedAt?: Date | null;
  qrVerifiedAt?: Date | null;
}): string | null {
  if (!booking.qrVerifiedAt || booking.completionOtpVerifiedAt) return null;
  const token = booking.completionOtpToken || null;
  return token && /^\d{4}$/.test(token) ? token : null;
}

/** Alias — same 4-digit generator used for start and completion PINs. */
export const generateCompletionOtp = generateStartOtp;
export const normalizeCompletionOtp = normalizeStartOtp;
export const isValidCompletionOtp = isValidStartOtp;
