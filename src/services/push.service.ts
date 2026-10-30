import { UserRole } from '@prisma/client';
import { prisma } from '../config/prisma';
import { getFirebaseMessaging, isFirebaseConfigured } from '../config/firebase';
import { logger } from '../config/logger';

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

const FCM_BATCH_SIZE = 500;

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

function stringifyData(data?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!data) return out;
  for (const [key, value] of Object.entries(data)) {
    if (value == null || value === '') continue;
    out[key] = String(value);
  }
  return out;
}

export async function upsertDevicePushToken(
  userId: string,
  token: string,
  platform: string
): Promise<void> {
  await prisma.devicePushToken.upsert({
    where: { token },
    create: {
      userId,
      token,
      platform,
    },
    update: {
      userId,
      platform,
    },
  });
}

export async function deleteDevicePushToken(token: string, userId?: string): Promise<void> {
  await prisma.devicePushToken.deleteMany({
    where: userId ? { token, userId } : { token },
  });
}

async function pruneInvalidTokens(tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  await prisma.devicePushToken.deleteMany({
    where: { token: { in: tokens } },
  });
}

async function sendToTokenList(tokens: string[], payload: PushPayload): Promise<number> {
  if (tokens.length === 0) return 0;
  if (!isFirebaseConfigured()) {
    logger.warn('Skipping FCM send: Firebase Admin is not configured');
    return 0;
  }

  const uniqueTokens = [...new Set(tokens.filter((token) => token && token.length > 20))];
  if (uniqueTokens.length === 0) return 0;

  const messaging = getFirebaseMessaging();
  const data = stringifyData(payload.data);
  let delivered = 0;
  const staleTokens: string[] = [];

  for (let i = 0; i < uniqueTokens.length; i += FCM_BATCH_SIZE) {
    const batch = uniqueTokens.slice(i, i + FCM_BATCH_SIZE);
    try {
      const response = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data,
        android: {
          priority: 'high',
          notification: {
            channelId: 'servfex_offers',
            sound: 'default',
          },
        },
      });
      delivered += response.successCount;
      response.responses.forEach((result, index) => {
        if (result.success) return;
        const code = result.error?.code || '';
        if (INVALID_TOKEN_CODES.has(code)) {
          staleTokens.push(batch[index]);
        }
      });
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'FCM multicast batch failed');
    }
  }

  if (staleTokens.length > 0) {
    await pruneInvalidTokens(staleTokens);
  }

  return delivered;
}

export async function sendPushToUserIds(
  userIds: string[],
  payload: PushPayload
): Promise<number> {
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
  if (uniqueUserIds.length === 0) return 0;

  const rows = await prisma.devicePushToken.findMany({
    where: { userId: { in: uniqueUserIds } },
    select: { token: true },
  });

  return sendToTokenList(
    rows.map((row) => row.token),
    payload
  );
}

export async function sendPushToRoles(
  roles: UserRole[] | 'ALL',
  payload: PushPayload
): Promise<number> {
  const where =
    roles === 'ALL'
      ? {
          user: {
            status: 'ACTIVE' as const,
            deletedAt: null,
          },
        }
      : {
          user: {
            role: { in: roles },
            status: 'ACTIVE' as const,
            deletedAt: null,
          },
        };

  const rows = await prisma.devicePushToken.findMany({
    where,
    select: { token: true },
  });

  return sendToTokenList(
    rows.map((row) => row.token),
    payload
  );
}
