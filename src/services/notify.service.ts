import { prisma } from '../config/prisma';
import { logger } from '../config/logger';
import { sendPushToUserIds } from './push.service';

export async function notifyUsers(
  userIds: Array<string | null | undefined>,
  title: string,
  message: string,
  data?: Record<string, string>
): Promise<void> {
  const unique = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return;

  await prisma.notification
    .createMany({
      data: unique.map((targetUserId) => ({
        title,
        message,
        target: 'SPECIFIC_USER' as const,
        targetUserId,
        type: data?.type || 'BOOKING',
        serviceId: data?.serviceId || null,
      })),
    })
    .catch((err) => logger.warn({ err }, 'Failed to persist in-app notifications'));

  void sendPushToUserIds(unique, {
    title,
    body: message,
    data,
  }).catch((err) => logger.warn({ err }, 'Failed to send FCM notifications'));
}
