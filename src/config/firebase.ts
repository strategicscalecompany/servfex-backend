import { initializeApp, getApps, getApp, cert, applicationDefault, App } from 'firebase-admin/app';
import { getAuth, Auth } from 'firebase-admin/auth';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

let isConfigured = false;
let authInstance: Auth | null = null;
let appInstance: App | null = null;

function initializeFirebase(): App | null {
  if (getApps().length > 0) {
    isConfigured = true;
    appInstance = getApp();
    authInstance = getAuth(appInstance);
    return appInstance;
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : undefined;

  try {
    // 1. Service account JSON file
    if (serviceAccountPath) {
      const resolvedPath = path.isAbsolute(serviceAccountPath)
        ? serviceAccountPath
        : path.resolve(process.cwd(), serviceAccountPath);

      if (fs.existsSync(resolvedPath)) {
        const fileContent = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
        appInstance = initializeApp({
          credential: cert(fileContent),
        });
        isConfigured = true;
        authInstance = getAuth(appInstance);
        logger.info('Firebase Admin SDK initialized from service account JSON file');
        return appInstance;
      }
    }

    // 2. Individual environment variables
    if (projectId && clientEmail && privateKey) {
      appInstance = initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
      isConfigured = true;
      authInstance = getAuth(appInstance);
      logger.info('Firebase Admin SDK initialized from environment credentials');
      return appInstance;
    }

    // 3. Application Default Credentials
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      appInstance = initializeApp({
        credential: applicationDefault(),
      });
      isConfigured = true;
      authInstance = getAuth(appInstance);
      logger.info('Firebase Admin SDK initialized with Application Default Credentials');
      return appInstance;
    }

    // Missing Credentials Handling (Adjustment 1)
    if (isProduction) {
      const errorMsg =
        'FATAL: Firebase Admin credentials are not configured in production environment. ' +
        'Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in .env.';
      logger.error(errorMsg);
      throw new Error(errorMsg);
    } else {
      logger.warn(
        '⚠️  DEVELOPMENT NOTICE: Firebase Admin SDK credentials not yet provided in .env. ' +
        'API requests requiring Firebase ID token verification will fail until credentials are provided. ' +
        'Add FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY (or FIREBASE_SERVICE_ACCOUNT_PATH) to .env.'
      );
      return null;
    }
  } catch (error: any) {
    if (isProduction) {
      logger.error({ err: error }, 'Fatal error initializing Firebase Admin SDK');
      throw error;
    }
    logger.warn({ err: error.message }, 'Failed to initialize Firebase Admin SDK in development');
    return null;
  }
}

export const firebaseApp = initializeFirebase();

export const getFirebaseAuth = (): Auth => {
  if (!authInstance) {
    if (getApps().length > 0) {
      authInstance = getAuth();
    } else {
      throw new Error('Firebase Admin SDK is not initialized.');
    }
  }
  return authInstance;
};

export const isFirebaseConfigured = (): boolean => isConfigured;
