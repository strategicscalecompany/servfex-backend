import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendSuccess, sendError } from '../utils/response';
import { NotificationTarget } from '@prisma/client';

export const registerFcmTokenSchema = z.object({
  fcmToken: z.string().min(10, 'Valid FCM token is required'),
  deviceType: z.enum(['ANDROID', 'IOS', 'WEB']).default('ANDROID'),
});

export const broadcastNotificationSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  message: z.string().min(1, 'Message is required'),
  target: z.enum(['ALL', 'CUSTOMERS', 'VENDORS', 'EMPLOYEES', 'SPECIFIC_USER']).default('ALL'),
  targetUserId: z.string().uuid().optional(),
});

/**
 * Super Admin broadcast notification
 */
export const broadcastNotification = async (req: Request, res: Response): Promise<void> => {
  try {
    const { title, message, target, targetUserId } = req.body;

    const notification = await prisma.notification.create({
      data: {
        title,
        message,
        target: target as NotificationTarget,
        targetUserId: target === 'SPECIFIC_USER' ? targetUserId : null,
      },
    });

    sendSuccess(res, { notification }, 201);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

/**
 * Super Admin notification history
 */
export const getNotificationHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const page = parseInt(String(req.query.page || '1'), 10) || 1;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        take: limit,
        skip,
        orderBy: { sentAt: 'desc' },
      }),
      prisma.notification.count(),
    ]);

    sendSuccess(res, { notifications }, 200, {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

/**
 * User personal notifications feed
 */
export const getUserNotifications = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const role = req.user!.role;
    const page = parseInt(String(req.query.page || '1'), 10) || 1;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const roleTarget: NotificationTarget =
      role === 'CUSTOMER' ? 'CUSTOMERS' : role === 'VENDOR' ? 'VENDORS' : role === 'EMPLOYEE' ? 'EMPLOYEES' : 'ALL';

    const where = {
      OR: [
        { target: 'ALL' as NotificationTarget },
        { target: roleTarget },
        { targetUserId: userId },
      ],
    };

    const [notifications, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        take: limit,
        skip,
        orderBy: { sentAt: 'desc' },
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { ...where, isRead: false } }),
    ]);

    sendSuccess(
      res,
      {
        notifications,
        unreadCount,
      },
      200,
      {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      }
    );
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const markNotificationAsRead = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;

    const notification = await prisma.notification.findUnique({
      where: { id },
    });

    if (!notification) {
      sendError(res, 'NOT_FOUND', 'Notification not found', 404);
      return;
    }

    const updated = await prisma.notification.update({
      where: { id },
      data: { isRead: true },
    });

    sendSuccess(res, { notification: updated }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const markAllNotificationsAsRead = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const role = req.user!.role;

    const roleTarget: NotificationTarget =
      role === 'CUSTOMER' ? 'CUSTOMERS' : role === 'VENDOR' ? 'VENDORS' : role === 'EMPLOYEE' ? 'EMPLOYEES' : 'ALL';

    await prisma.notification.updateMany({
      where: {
        OR: [
          { target: 'ALL' as NotificationTarget },
          { target: roleTarget },
          { targetUserId: userId },
        ],
        isRead: false,
      },
      data: { isRead: true },
    });

    sendSuccess(res, null, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const registerFcmToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { fcmToken, deviceType } = req.body;

    await prisma.session.create({
      data: {
        userId,
        tokenHash: `fcm_${userId}_${Date.now()}`,
        userAgent: `${deviceType}_DEVICE: ${fcmToken.slice(0, 15)}...`,
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 days
      },
    });

    sendSuccess(res, null, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};
