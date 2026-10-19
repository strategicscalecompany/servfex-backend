import { Server as SocketIOServer } from 'socket.io';
import { logger } from '../config/logger';
import { prisma } from '../config/prisma';

/**
 * Realtime fan-out for booking lifecycle and call-signalling events.
 *
 * Rooms (joined only after the socket handshake token is verified against the DB):
 *   - `admins`        -> every active SUPER_ADMIN
 *   - `user:<userId>` -> that single user (vendor owner, employee, customer)
 *
 * PRIVACY: events are never broadcast globally. Super admins receive the full payload (they already have
 * platform-wide access); every other user receives a sanitized payload containing identifiers and status only.
 * Clients must refetch through the authenticated REST API, so no personal data or location travels over the socket.
 */
let ioInstance: SocketIOServer | null = null;

export const setRealtimeServer = (io: SocketIOServer): void => {
  ioInstance = io;
};

export interface BookingRealtimeEvent {
  bookingId: string;
  bookingNumber?: string;
  status?: string;
  vendorId?: string | null;
  /** Machine-readable cause, e.g. EXPERT_ASSIGNED, EXPERT_ACCEPTED, NO_EXPERT_AVAILABLE. */
  reason?: string;
  booking?: any;
}

export type UserRealtimeEventName =
  | 'booking:assignment'
  | 'call:incoming'
  | 'call:answered'
  | 'call:declined'
  | 'call:ended';

export interface CallRealtimeEvent {
  callId: string;
  bookingId: string;
  bookingNumber?: string;
  status: string;
  /** Display name of the other party (only ever sent to a participant of the same booking). */
  fromName?: string;
  endReason?: string | null;
}

const sanitizeBookingPayload = (payload: BookingRealtimeEvent): BookingRealtimeEvent => ({
  bookingId: payload.bookingId,
  bookingNumber: payload.bookingNumber,
  status: payload.status,
  vendorId: payload.vendorId,
  reason: payload.reason,
});

export const emitBookingEvent = (
  event: 'booking:new' | 'booking:updated',
  payload: BookingRealtimeEvent,
  userIds: Array<string | null | undefined> = []
): void => {
  if (!ioInstance) {
    logger.warn('Realtime ioInstance not initialized, skipping booking event emit');
    return;
  }
  try {
    // 1. Super Admin dashboard room only (never a global broadcast).
    ioInstance.to('admins').emit(event, payload);

    // 2. Party rooms (vendor owner, employee, customer) receive identifiers + status only.
    const safe = sanitizeBookingPayload(payload);
    const validUserIds = new Set(userIds.filter(Boolean) as string[]);
    for (const id of validUserIds) {
      ioInstance.to(`user:${id}`).emit(event, safe);
    }

    logger.info(
      { event, bookingId: payload.bookingId, bookingNumber: payload.bookingNumber, targetUserCount: validUserIds.size },
      'Realtime booking event successfully dispatched'
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to emit realtime booking event');
  }
};

/** Emit a user-scoped event (assignment offers, call signalling) to specific user rooms only. */
export const emitUserEvent = (
  event: UserRealtimeEventName,
  payload: BookingRealtimeEvent | CallRealtimeEvent,
  userIds: Array<string | null | undefined>
): void => {
  if (!ioInstance) {
    logger.warn({ event }, 'Realtime ioInstance not initialized, skipping user event emit');
    return;
  }
  try {
    const validUserIds = new Set(userIds.filter(Boolean) as string[]);
    for (const id of validUserIds) {
      ioInstance.to(`user:${id}`).emit(event, payload);
    }
  } catch (err) {
    logger.warn({ err, event }, 'Failed to emit realtime user event');
  }
};

/** Realtime refresh for every party attached to a booking (admin desk, vendor, technician, customer). */
export async function emitBookingRefresh(
  bookingId: string,
  options: { reason?: string; extraUserIds?: Array<string | null | undefined> } = {}
): Promise<void> {
  try {
    const b = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        bookingNumber: true,
        status: true,
        vendorId: true,
        vendor: { select: { userId: true } },
        employee: { select: { userId: true } },
        customer: { select: { userId: true } },
      },
    });
    if (!b) return;
    emitBookingEvent(
      'booking:updated',
      { bookingId: b.id, bookingNumber: b.bookingNumber, status: b.status, vendorId: b.vendorId, reason: options.reason },
      [b.vendor?.userId, b.employee?.userId, b.customer.userId, ...(options.extraUserIds ?? [])]
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to refresh booking realtime event');
  }
}
