import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables
dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('5000').transform((val) => parseInt(val, 10)),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CLIENT_URL: z.string().default('http://localhost:5173'),
  
  // Database (MongoDB Atlas). DATABASE_URL is what Prisma reads; MONGODB_URI is an optional alias.
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  MONGODB_URI: z.string().optional(),
  DIRECT_URL: z.string().optional(),

  // Firebase Admin SDK Configuration
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),

  // JWT secrets: strictly loaded from environment variables (.env)
  JWT_SECRET: z.string().min(1, 'JWT_SECRET must be configured in environment variables (.env)'),
  JWT_REFRESH_SECRET: z.string().min(1, 'JWT_REFRESH_SECRET must be configured in environment variables (.env)'),
  ACCESS_TOKEN_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_EXPIRES_IN_DAYS: z.string().default('7').transform((val) => parseInt(val, 10)),

  // Optional External Integrations
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_URL: z.string().optional(),
  BUNNY_STORAGE_API_KEY: z.string().optional(),
  FCM_PROJECT_ID: z.string().optional(),
  FCM_SERVER_KEY: z.string().optional(),
  GOOGLE_MAPS_API_KEY: z.string().optional(),

  // Agora RTC Configuration (no defaults: credentials must come from the environment only)
  AGORA_APP_ID: z.string().optional(),
  AGORA_APP_CERTIFICATE: z.string().optional(),
  AGORA_TOKEN_TTL_SECONDS: z.string().default('1800').transform((val) => parseInt(val, 10)),

  // Booking dispatch: provider-first window, then server-side auto-assignment
  PROVIDER_RESPONSE_WINDOW_SECONDS: z.string().default('60').transform((val) => parseInt(val, 10)),
  AUTO_ASSIGN_RETRY_SECONDS: z.string().default('30').transform((val) => parseInt(val, 10)),
  EXPERT_ACCEPT_WINDOW_SECONDS: z.string().default('120').transform((val) => parseInt(val, 10)),
  DISPATCH_SWEEP_INTERVAL_MS: z.string().default('15000').transform((val) => parseInt(val, 10)),
  DISPATCH_WORKER_ENABLED: z.string().default('true').transform((val) => val !== 'false'),

  // Temporary Expert testing workflow. Set to "false" to restore the original auto-dispatch
  // and unrestricted Expert portal behaviour without deleting any code.
  EXPERT_TESTING_WORKFLOW_ENABLED: z.string().default('true').transform((val) => val !== 'false'),

  // Hostinger SMTP Email Configuration
  SMTP_HOST: z.string().default('smtp.hostinger.com'),
  SMTP_PORT: z.string().default('465').transform((val) => parseInt(val, 10)),
  SMTP_SECURE: z.string().default('true').transform((val) => val === 'true'),
  SMTP_USER: z.string().default('official@servfex.com'),
  SMTP_PASS: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('ServFex <no-reply@servfex.com>'),

  // MSG91 SMS OTP Configuration
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_OTP_TEMPLATE_ID: z.string().default('6adc8287bbeb62d5330dba32'),
  OTP_EXPIRY_MINUTES: z.string().default('5').transform((val) => parseInt(val, 10)),
  OTP_MAX_ATTEMPTS: z.string().default('5').transform((val) => parseInt(val, 10)),
  OTP_RESEND_COOLDOWN_SECONDS: z.string().default('60').transform((val) => parseInt(val, 10)),

  // Super Admin Seed Config (Requires actual Firebase UID for seed)
  SUPER_ADMIN_FIREBASE_UID: z.string().optional(),
  SUPER_ADMIN_EMAIL: z.string().email().optional().default('vamshi.c2002@gmail.com'),
  SUPER_ADMIN_EMAILS: z
    .string()
    .optional()
    .default('vamshi.c2002@gmail.com,strategicscalecompany@gmail.com'),
  SUPER_ADMIN_PASSWORD: z.string().optional(),
  SUPER_ADMIN_NAME: z.string().optional().default('ServFex Super Admin'),
});

const parseResult = envSchema.safeParse(process.env);

if (!parseResult.success) {
  // Never leak secrets! Format only the missing/invalid field names.
  const issues = parseResult.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join(', ');
  
  throw new Error(`Environment validation failed: ${issues}`);
}

export const env = parseResult.data;
