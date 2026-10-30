import { Request, Response } from 'express';
import { z } from 'zod';
import { sendError, sendSuccess } from '../utils/response';
import { DispatchError } from '../services/dispatch.errors';
import {
  buildPaymentQr,
  chatAllowed,
  confirmUpiCollection,
  getTrackingSnapshot,
  pingProfessionalLocation,
  saveProfessionalUpi,
  setProfessionalAvailability,
} from '../services/execution.service';
import { listBookingMessages, sendBookingMessage } from '../services/chat.service';
import { listEscalationsForActor, resolveEscalation } from '../services/escalation.service';
import { prisma } from '../config/prisma';

function handleDispatchError(res: Response, err: unknown): boolean {
  if (err instanceof DispatchError) {
    sendError(res, err.code, err.message, err.httpStatus);
    return true;
  }
  return false;
}

function paramId(req: Request): string {
  return String(req.params.id);
}

export const locationPingSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
});

export const chatMessageSchema = z.object({
  body: z.string().min(1).max(2000),
});

export const availabilitySchema = z.object({
  isAvailable: z.boolean(),
  acceptingRequests: z.boolean().optional(),
});

export const upiSchema = z.object({
  upiId: z.string().min(5).max(320),
});

export const confirmUpiSchema = z.object({
  utr: z.string().trim().min(8).max(32),
});

export const resolveEscalationSchema = z.object({
  note: z.string().min(3).max(1000),
  status: z.enum(['ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']).optional(),
});

export const pingOrderLocation = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await pingProfessionalLocation(
      req.user!.userId,
      paramId(req),
      Number(req.body.latitude),
      Number(req.body.longitude)
    );
    sendSuccess(res, { location: result });
  } catch (err: any) {
    if (handleDispatchError(res, err)) return;
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const getOrderTracking = async (req: Request, res: Response): Promise<void> => {
  try {
    const tracking = await getTrackingSnapshot(req.user!.userId, paramId(req));
    sendSuccess(res, { tracking });
  } catch (err: any) {
    if (handleDispatchError(res, err)) return;
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const getOrderMessages = async (req: Request, res: Response): Promise<void> => {
  try {
    const data = await listBookingMessages(req.user!.userId, paramId(req));
    sendSuccess(res, data);
  } catch (err: any) {
    if (handleDispatchError(res, err)) return;
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const postOrderMessage = async (req: Request, res: Response): Promise<void> => {
  try {
    const message = await sendBookingMessage(req.user!.userId, paramId(req), req.body.body);
    sendSuccess(res, { message }, 201);
  } catch (err: any) {
    if (handleDispatchError(res, err)) return;
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const confirmUpiPayment = async (req: Request, res: Response): Promise<void> => {
  try {
    const payment = await confirmUpiCollection(req.user!.userId, paramId(req), req.body.utr);
    sendSuccess(res, { payment });
  } catch (err: any) {
    if (handleDispatchError(res, err)) return;
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const getPaymentQr = async (req: Request, res: Response): Promise<void> => {
  try {
    const qr = await buildPaymentQr(req.user!.userId, paramId(req));
    sendSuccess(res, { qr });
  } catch (err: any) {
    if (handleDispatchError(res, err)) return;
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const updateMyAvailability = async (req: Request, res: Response): Promise<void> => {
  try {
    const profile = await setProfessionalAvailability(
      req.user!.userId,
      Boolean(req.body.isAvailable),
      req.body.acceptingRequests
    );
    sendSuccess(res, { profile });
  } catch (err: any) {
    if (handleDispatchError(res, err)) return;
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const updateMyUpi = async (req: Request, res: Response): Promise<void> => {
  try {
    const profile = await saveProfessionalUpi(req.user!.userId, req.body.upiId);
    sendSuccess(res, { profile });
  } catch (err: any) {
    if (handleDispatchError(res, err)) return;
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const getMyProfessionalProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const profile = await prisma.employeeProfile.findUnique({
      where: { userId: req.user!.userId },
      select: {
        id: true,
        isAvailable: true,
        acceptingRequests: true,
        upiId: true,
        lastLatitude: true,
        lastLongitude: true,
        lastLocationAt: true,
        specialization: true,
        rating: true,
        completedJobs: true,
      },
    });
    if (!profile) {
      sendError(res, 'NOT_FOUND', 'Professional profile not found', 404);
      return;
    }
    sendSuccess(res, { profile });
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const listEscalations = async (req: Request, res: Response): Promise<void> => {
  try {
    const tickets = await listEscalationsForActor(req.user!.userId, typeof req.query.status === 'string' ? req.query.status : undefined);
    sendSuccess(res, { tickets });
  } catch (err: any) {
    if (handleDispatchError(res, err)) return;
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const resolveEscalationTicket = async (req: Request, res: Response): Promise<void> => {
  try {
    const ticket = await resolveEscalation(
      req.user!.userId,
      paramId(req),
      req.body.note,
      req.body.status || 'RESOLVED'
    );
    sendSuccess(res, { ticket });
  } catch (err: any) {
    if (handleDispatchError(res, err)) return;
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const getActiveCustomerBooking = async (req: Request, res: Response): Promise<void> => {
  try {
    const booking = await prisma.booking.findFirst({
      where: {
        customer: { userId: req.user!.userId },
        status: { in: ['ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'ARRIVED', 'IN_PROGRESS'] },
      },
      orderBy: { updatedAt: 'desc' },
      include: {
        service: { select: { id: true, name: true } },
        employee: {
          select: {
            id: true,
            specialization: true,
            rating: true,
            user: { select: { name: true, profilePhotoUrl: true } },
          },
        },
      },
    });
    sendSuccess(res, {
      booking: booking
        ? {
            ...booking,
            chatAvailable: chatAllowed(booking.status),
            professional: booking.employee
              ? {
                  id: booking.employee.id,
                  name: booking.employee.user.name,
                  specialization: booking.employee.specialization,
                  rating: booking.employee.rating,
                  photoUrl: booking.employee.user.profilePhotoUrl,
                }
              : null,
          }
        : null,
    });
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};
