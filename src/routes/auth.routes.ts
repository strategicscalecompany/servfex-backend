import { Router } from 'express';
import {
  login,
  loginSchema,
  googleLogin,
  googleLoginSchema,
  getCurrentUser,
  revokeAllSessions,
  sendCustomerOtp,
  sendOtpSchema,
  verifyCustomerOtp,
  verifyOtpSchema,
  forgotPasswordSendOtp,
  forgotPasswordSendOtpSchema,
  forgotPasswordVerifyOtp,
  forgotPasswordVerifyOtpSchema,
  resetPassword,
  resetPasswordSchema,
} from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { otpSendLimiter, otpVerifyLimiter } from '../middleware/otp-rate-limit';

const router = Router();

// Customer & User OTP Authentication (MSG91 Flow SMS / Hostinger SMTP)
router.post('/customer/send-otp', otpSendLimiter, validate(sendOtpSchema), sendCustomerOtp);
router.post('/customer/verify-otp', otpVerifyLimiter, validate(verifyOtpSchema), verifyCustomerOtp);
router.post('/send-otp', otpSendLimiter, validate(sendOtpSchema), sendCustomerOtp);
router.post('/verify-otp', otpVerifyLimiter, validate(verifyOtpSchema), verifyCustomerOtp);

// Forgot Password Flow with Email OTP via Hostinger SMTP
router.post('/forgot-password/send-otp', validate(forgotPasswordSendOtpSchema), forgotPasswordSendOtp);
router.post('/forgot-password/verify-otp', validate(forgotPasswordVerifyOtpSchema), forgotPasswordVerifyOtp);
router.post('/forgot-password/reset', validate(resetPasswordSchema), resetPassword);
router.post('/reset-password', validate(resetPasswordSchema), resetPassword);

// Direct login with email and password
router.post('/login', validate(loginSchema), login);

// Google Sign-In verification & login
router.post('/google', validate(googleLoginSchema), googleLogin);

// Retrieve authenticated user's PostgreSQL ServFex profile & role
router.get('/me', authenticate, getCurrentUser);

// Revoke all Firebase sessions
router.post('/revoke-all', authenticate, revokeAllSessions);

export default router;
