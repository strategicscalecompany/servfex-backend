import { Request, Response } from 'express';
import { RtcTokenBuilder, RtcRole } from 'agora-token';
import { z } from 'zod';
import { env } from '../config/env';
import { prisma } from '../config/prisma';
import { sendSuccess, sendError } from '../utils/response';
import { logger } from '../config/logger';

export const callTokenSchema = z.object({
  bookingId: z.string().min(1, 'Booking ID is required'),
});

/**
 * Generate a deterministic positive 32-bit integer UID for Agora RTC.
 * Customers and Employees/Vendors get distinct UID ranges so collisions are avoided in the same channel.
 */
function generateAgoraUid(userId: string, role: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  const positiveHash = Math.abs(hash) % 800000;
  const baseOffset = role === 'CUSTOMER' ? 100000 : 200000;
  return baseOffset + positiveHash;
}

/**
 * Sanitizes channel name for Agora RTC specifications:
 * Must be <= 64 ASCII alphanumeric characters.
 */
function sanitizeChannelName(bookingId: string): string {
  const clean = bookingId.replace(/[^a-zA-Z0-9]/g, '');
  return `sfx_${clean}`.substring(0, 64);
}

/**
 * Controller to generate an Agora RTC Voice/Audio Call Token
 * Validates caller authorization against the targeted booking.
 */
export const generateCallToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const userRole = req.user!.role;
    const bookingId = (req.body.bookingId || req.params.bookingId || req.query.bookingId) as string;

    if (!bookingId) {
      sendError(res, 'BAD_REQUEST', 'bookingId is required to generate a call token', 400);
      return;
    }

    if (!env.AGORA_APP_ID || !env.AGORA_APP_CERTIFICATE) {
      sendError(
        res,
        'SERVICE_UNAVAILABLE',
        'Agora RTC credentials are not configured on the backend server.',
        503
      );
      return;
    }

    // Lookup booking and related parties
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        customer: {
          include: {
            user: {
              select: { id: true, name: true, phone: true, profilePhotoUrl: true },
            },
          },
        },
        employee: {
          include: {
            user: {
              select: { id: true, name: true, phone: true, profilePhotoUrl: true },
            },
          },
        },
        vendor: {
          include: {
            user: {
              select: { id: true, name: true, phone: true },
            },
          },
        },
      },
    });

    if (!booking) {
      sendError(res, 'NOT_FOUND', 'Booking not found', 404);
      return;
    }

    // Verify user authorization:
    // User must be the customer, the assigned employee, or the vendor
    let isAuthorized = false;
    let peerName = 'ServFex User';
    let peerPhone = '';
    let peerRole = 'USER';
    let peerPhotoUrl: string | null = null;

    if (userRole === 'CUSTOMER') {
      if (booking.customer?.userId === userId) {
        isAuthorized = true;
        peerName = booking.employee?.user?.name || booking.vendor?.companyName || 'Assigned Technician';
        peerPhone = booking.employee?.user?.phone || booking.vendor?.user?.phone || '';
        peerRole = 'EMPLOYEE';
        peerPhotoUrl = booking.employee?.user?.profilePhotoUrl || null;
      }
    } else if (userRole === 'EMPLOYEE') {
      // Check if employee is assigned or belongs to the vendor
      if (booking.employee?.userId === userId) {
        isAuthorized = true;
        peerName = booking.customer?.user?.name || 'Customer';
        peerPhone = booking.customer?.user?.phone || '';
        peerRole = 'CUSTOMER';
        peerPhotoUrl = booking.customer?.user?.profilePhotoUrl || null;
      } else {
        const empProfile = await prisma.employeeProfile.findUnique({ where: { userId } });
        if (empProfile && empProfile.vendorId === booking.vendorId) {
          isAuthorized = true;
          peerName = booking.customer?.user?.name || 'Customer';
          peerPhone = booking.customer?.user?.phone || '';
          peerRole = 'CUSTOMER';
          peerPhotoUrl = booking.customer?.user?.profilePhotoUrl || null;
        }
      }
    } else if (userRole === 'VENDOR') {
      if (booking.vendor?.userId === userId) {
        isAuthorized = true;
        peerName = booking.customer?.user?.name || 'Customer';
        peerPhone = booking.customer?.user?.phone || '';
        peerRole = 'CUSTOMER';
        peerPhotoUrl = booking.customer?.user?.profilePhotoUrl || null;
      }
    } else if (userRole === 'SUPER_ADMIN') {
      isAuthorized = true;
      peerName = booking.customer?.user?.name || 'Customer';
      peerPhone = booking.customer?.user?.phone || '';
      peerRole = 'ADMIN';
    }

    if (!isAuthorized) {
      sendError(
        res,
        'FORBIDDEN',
        'You are not authorized to initiate or join a call for this booking',
        403
      );
      return;
    }

    // Generate Agora RTC parameters
    const channelName = sanitizeChannelName(booking.id);
    const agoraUid = generateAgoraUid(userId, userRole);
    const tokenExpirationInSeconds = 3600; // 1 hour token validity
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + tokenExpirationInSeconds;

    // Role is PUBLISHER so the participant can speak and listen
    const rtcToken = RtcTokenBuilder.buildTokenWithUid(
      env.AGORA_APP_ID,
      env.AGORA_APP_CERTIFICATE,
      channelName,
      agoraUid,
      RtcRole.PUBLISHER,
      tokenExpirationInSeconds,
      privilegeExpiredTs
    );

    logger.info(
      {
        bookingId: booking.id,
        bookingNumber: booking.bookingNumber,
        userId,
        userRole,
        agoraUid,
        channelName,
      },
      'Generated Agora RTC call token'
    );

    sendSuccess(
      res,
      {
        appId: env.AGORA_APP_ID,
        channelName,
        token: rtcToken,
        uid: agoraUid,
        bookingId: booking.id,
        bookingNumber: booking.bookingNumber,
        peerName,
        peerPhone,
        peerRole,
        peerPhotoUrl,
        expiresAt: privilegeExpiredTs,
      },
      200
    );
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to generate Agora RTC call token');
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};
