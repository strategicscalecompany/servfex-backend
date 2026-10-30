import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { UserRole } from '@prisma/client';
import { CookieOptions } from 'express';

export interface TokenPayload {
  userId: string;
  role: UserRole;
  email: string;
  purpose?: string;
}

export const ONBOARDING_TOKEN_PURPOSE = 'CUSTOMER_ONBOARDING';

export interface OnboardingTokenPayload {
  purpose: typeof ONBOARDING_TOKEN_PURPOSE;
  email?: string;
  phone?: string;
  displayPhone?: string;
  normalizedMobile?: string;
  googleUid?: string;
  name?: string;
  photoUrl?: string;
  emailVerified: boolean;
  phoneVerified: boolean;
}

export const generateOnboardingToken = (payload: Omit<OnboardingTokenPayload, 'purpose'>): string => {
  return jwt.sign(
    { ...payload, purpose: ONBOARDING_TOKEN_PURPOSE },
    env.JWT_SECRET,
    { expiresIn: '30m' }
  );
};

export const verifyOnboardingToken = (token: string): OnboardingTokenPayload => {
  const decoded = jwt.verify(token, env.JWT_SECRET) as OnboardingTokenPayload;
  if (decoded.purpose !== ONBOARDING_TOKEN_PURPOSE) {
    throw new Error('Invalid onboarding token');
  }
  return decoded;
};

export const isOnboardingTokenPayload = (
  payload: TokenPayload | OnboardingTokenPayload | Record<string, unknown>
): payload is OnboardingTokenPayload => {
  return (payload as OnboardingTokenPayload).purpose === ONBOARDING_TOKEN_PURPOSE;
};

export const generateAccessToken = (payload: TokenPayload): string => {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: '30d',
  });
};

export const generateRefreshToken = (payload: TokenPayload): string => {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: `${env.REFRESH_TOKEN_EXPIRES_IN_DAYS}d`,
  });
};

export const verifyAccessToken = (token: string): TokenPayload => {
  return jwt.verify(token, env.JWT_SECRET) as TokenPayload;
};

export const verifyRefreshToken = (token: string): TokenPayload => {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as TokenPayload;
};

export const hashToken = (token: string): string => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

export const getRefreshCookieOptions = (): CookieOptions => {
  const isProd = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'strict' : 'lax',
    maxAge: env.REFRESH_TOKEN_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000,
    path: '/api/v1/auth',
  };
};
