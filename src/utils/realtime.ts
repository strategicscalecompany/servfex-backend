import { Server as SocketIOServer } from 'socket.io';
import { logger } from '../config/logger';
import { prisma } from '../config/prisma';

/**
 * Realtime fan-out for booking lifecycle events.
 *
 * Rooms (joined only after the socket handshake token is verified against the DB):
 *   - `admins`        -> every active SUPER_ADMIN
 *   - `user:<userId>` -> that single user (vendor owner, employee, customer)
 *
 * Payloads carry identifiers and status only. Clients must refetch through the
 * authenticated REST API, so no personal data travels over the socket.
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
}

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
    // 1. Dispatch event to Super Admin dashboard room
    ioInstance.to('admins').emit(event, payload);

    // 2. Dispatch event to respective user rooms (vendor, employee, customer)
    const validUserIds = new Set(userIds.filter(Boolean) as string[]);
    for (const id of validUserIds) {
      ioInstance.to(`user:${id}`).emit(event, payload);
    }

    logger.info(
      { event, bookingId: payload.bookingId, bookingNumber: payload.bookingNumber, targetUserCount: validUserIds.size },
      'Realtime booking event successfully dispatched'
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to emit realtime booking event');
  }
};

/** Realtime refresh for every party attached to a booking (admin desk, vendor, technician, customer). */
export async function emitBookingRefresh(bookingId: string): Promise<void> {
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
      { bookingId: b.id, bookingNumber: b.bookingNumber, status: b.status, vendorId: b.vendorId },
      [b.vendor?.userId, b.employee?.userId, b.customer.userId]
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to refresh booking realtime event');
  }
}
