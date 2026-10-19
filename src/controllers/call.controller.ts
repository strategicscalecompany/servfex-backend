import { Request, Response } from 'express';
import { RtcTokenBuilder, RtcRole } from 'agora-token';
import { z } from 'zod';
import { env } from '../config/env';
import { prisma } from '../config/prisma';
import { sendSuccess, sendError } from '../utils/response';
import { logger } from '../config/logger';
import { emitUserEvent } from '../utils/realtime';
import {
  agoraUidForRole,
  channelNameForBooking,
  evaluateCallAccess,
} from '../services/dispatch.rules';

export const callTokenSchema = z.object({
  bookingId: z.string().min(1, 'Booking ID is required'),
});

export const answerCallSchema = z.object({
  callId: z.string().min(1, 'Call ID is required').optional(),
  bookingId: z.string().optional(),
});

export const endCallSchema = z.object({
  callId: z.string().min(1, 'Call ID is required').optional(),
  bookingId: z.string().optional(),
  reason: z.string().optional(),
});

/**
 * Controller to generate an Agora RTC Voice Call Token and initiate/join a booking-scoped call session.
 * Authenticates that caller is either the customer or the assigned expert, verifies booking status is eligible,
 * records call session in BookingCall, and emits incoming call event to the callee.
 */
export const generateCallToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
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

    // Lookup booking and participants
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
      },
    });

    if (!booking) {
      sendError(res, 'NOT_FOUND', 'Booking not found', 404);
      return;
    }

    const customerUserId = booking.customer?.userId;
    const expertUserId = booking.employee?.userId;

    const decision = evaluateCallAccess({
      status: booking.status,
      customerUserId,
      expertUserId,
      userId,
    });

    if (!decision.allowed) {
      sendError(res, decision.code, decision.message, decision.httpStatus);
      return;
    }

    const { participantRole, peerUserId } = decision;
    const agoraUid = agoraUidForRole(participantRole);
    const channelName = channelNameForBooking(booking.id);

    const isCustomer = participantRole === 'CUSTOMER';
    const peerName = isCustomer
      ? booking.employee?.user?.name || 'Assigned Technician'
      : booking.customer?.user?.name || 'Customer';
    const peerPhone = isCustomer
      ? booking.employee?.user?.phone || ''
      : booking.customer?.user?.phone || '';
    const peerRole = isCustomer ? 'EMPLOYEE' : 'CUSTOMER';
    const peerPhotoUrl = isCustomer
      ? booking.employee?.user?.profilePhotoUrl || null
      : booking.customer?.user?.profilePhotoUrl || null;
    const myName = isCustomer
      ? booking.customer?.user?.name || 'Customer'
      : booking.employee?.user?.name || 'Assigned Expert';

    const tokenTtl = env.AGORA_TOKEN_TTL_SECONDS || 1800;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + tokenTtl;

    const rtcToken = RtcTokenBuilder.buildTokenWithUid(
      env.AGORA_APP_ID,
      env.AGORA_APP_CERTIFICATE,
      channelName,
      agoraUid,
      RtcRole.PUBLISHER,
      tokenTtl,
      privilegeExpiredTs
    );

    // Look for an existing active or ringing call, or create a new call record
    let call = await prisma.bookingCall.findFirst({
      where: {
        bookingId: booking.id,
        status: { in: ['RINGING', 'ACTIVE'] },
      },
      orderBy: { startedAt: 'desc' },
    });

    if (!call) {
      call = await prisma.bookingCall.create({
        data: {
          bookingId: booking.id,
          channelName,
          callerUserId: userId,
          calleeUserId: peerUserId,
          status: 'RINGING',
        },
      });

      // Emit incoming call signaling to the callee
      emitUserEvent(
        'call:incoming',
        {
          callId: call.id,
          bookingId: booking.id,
          bookingNumber: booking.bookingNumber,
          status: 'RINGING',
          fromName: myName,
        },
        [peerUserId]
      );

      // Notification for push/offline delivery
      await prisma.notification.create({
        data: {
          title: `Incoming call from ${myName}`,
          message: `${myName} is calling you regarding booking #${booking.bookingNumber}.`,
          target: 'SPECIFIC_USER',
          targetUserId: peerUserId,
        },
      }).catch((e) => logger.warn({ e }, 'Failed to persist call notification'));
    }

    logger.info(
      {
        bookingId: booking.id,
        bookingNumber: booking.bookingNumber,
        userId,
        participantRole,
        agoraUid,
        channelName,
        callId: call.id,
      },
      'Generated Agora RTC call token and initialized call session'
    );

    sendSuccess(
      res,
      {
        appId: env.AGORA_APP_ID,
        channelName,
        token: rtcToken,
        uid: agoraUid,
        callId: call.id,
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

/**
 * Callee answers the incoming call.
 * Advances call status to ACTIVE and notifies caller via socket.
 */
export const answerCall = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const callId = (req.params.callId || req.body.callId) as string;
    const bookingId = req.body.bookingId as string | undefined;

    let call = null;
    if (callId) {
      call = await prisma.bookingCall.findUnique({
        where: { id: callId },
        include: { booking: { select: { bookingNumber: true } } },
      });
    } else if (bookingId) {
      call = await prisma.bookingCall.findFirst({
        where: {
          bookingId,
          calleeUserId: userId,
          status: 'RINGING',
        },
        orderBy: { startedAt: 'desc' },
        include: { booking: { select: { bookingNumber: true } } },
      });
    }

    if (!call) {
      sendError(res, 'NOT_FOUND', 'Active call session not found', 404);
      return;
    }

    if (call.calleeUserId !== userId && call.callerUserId !== userId) {
      sendError(res, 'FORBIDDEN', 'You are not a participant in this call', 403);
      return;
    }

    const updated = await prisma.bookingCall.update({
      where: { id: call.id },
      data: {
        status: 'ACTIVE',
        answeredAt: call.answeredAt || new Date(),
      },
    });

    emitUserEvent(
      'call:answered',
      {
        callId: updated.id,
        bookingId: updated.bookingId,
        bookingNumber: call.booking?.bookingNumber,
        status: 'ACTIVE',
      },
      [call.callerUserId, call.calleeUserId]
    );

    sendSuccess(res, { call: updated }, 200);
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to answer call');
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

/**
 * End or decline a call session cleanly.
 * Notifies peer via socket and records call completion timestamp.
 */
export const endCall = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const callId = (req.params.callId || req.body.callId) as string;
    const bookingId = req.body.bookingId as string | undefined;
    const reason = (req.body.reason || 'Call ended by user') as string;

    let call = null;
    if (callId) {
      call = await prisma.bookingCall.findUnique({
        where: { id: callId },
        include: { booking: { select: { bookingNumber: true } } },
      });
    } else if (bookingId) {
      call = await prisma.bookingCall.findFirst({
        where: {
          bookingId,
          status: { in: ['RINGING', 'ACTIVE'] },
          OR: [{ callerUserId: userId }, { calleeUserId: userId }],
        },
        orderBy: { startedAt: 'desc' },
        include: { booking: { select: { bookingNumber: true } } },
      });
    }

    if (!call) {
      // Idempotent: if already ended, return success
      sendSuccess(res, { message: 'Call already ended' }, 200);
      return;
    }

    if (call.callerUserId !== userId && call.calleeUserId !== userId) {
      sendError(res, 'FORBIDDEN', 'You are not a participant in this call', 403);
      return;
    }

    const isDecline = call.status === 'RINGING' && call.calleeUserId === userId;
    const newStatus = isDecline ? 'DECLINED' : 'ENDED';

    const updated = await prisma.bookingCall.update({
      where: { id: call.id },
      data: {
        status: newStatus,
        endedAt: new Date(),
        endReason: reason,
      },
    });

    const peerUserId = call.callerUserId === userId ? call.calleeUserId : call.callerUserId;
    emitUserEvent(
      isDecline ? 'call:declined' : 'call:ended',
      {
        callId: updated.id,
        bookingId: updated.bookingId,
        bookingNumber: call.booking?.bookingNumber,
        status: newStatus,
        endReason: reason,
      },
      [peerUserId]
    );

    sendSuccess(res, { call: updated }, 200);
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to end call');
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};
