import { prisma } from '../config/prisma';
import { DispatchError } from './dispatch.errors';
import { chatAllowed } from './execution.service';
import { emitToBookingRoom, emitUserEvent } from '../utils/realtime';
import { notifyUsers } from './notify.service';

const MAX_BODY = 2000;
const HUB_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function hubIdsForOperationsManager(userId: string): Promise<string[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      managerProfile: { select: { kind: true, vendorId: true, zone: true } },
    },
  });
  if (user?.role !== 'OPERATIONS_MANAGER' || !user.managerProfile) return [];
  if (user.managerProfile.kind && user.managerProfile.kind !== 'OPERATIONS') return [];

  const ids = new Set<string>();
  if (user.managerProfile.vendorId) ids.add(user.managerProfile.vendorId);

  const parts = (user.managerProfile.zone || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return [...ids];

  const vendors = await prisma.vendorProfile.findMany({
    select: { id: true, companyName: true, warehouseName: true },
  });
  const byId = new Map(vendors.map((v) => [v.id, v]));
  const byName = new Map<string, string>();
  for (const v of vendors) {
    if (v.warehouseName) byName.set(v.warehouseName.trim().toLowerCase(), v.id);
    if (v.companyName) byName.set(v.companyName.trim().toLowerCase(), v.id);
  }
  for (const part of parts) {
    if (HUB_UUID_RE.test(part) && byId.has(part)) ids.add(part);
    else {
      const named = byName.get(part.toLowerCase());
      if (named) ids.add(named);
    }
  }
  return [...ids];
}

async function resolveChatAccess(userId: string, bookingId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      bookingNumber: true,
      status: true,
      vendorId: true,
      customer: { select: { userId: true } },
      employee: { select: { userId: true } },
      vendor: { select: { userId: true } },
    },
  });
  if (!booking) throw new DispatchError('NOT_FOUND', 'Booking not found', 404);

  if (booking.customer.userId === userId) {
    return { booking, role: 'CUSTOMER' as const, isManager: false };
  }
  if (booking.employee?.userId === userId) {
    return { booking, role: 'EXPERT' as const, isManager: false };
  }
  if (booking.vendor?.userId === userId) {
    // Partner owner can monitor; send as OPERATIONS_MANAGER for schema fit.
    return { booking, role: 'OPERATIONS_MANAGER' as const, isManager: true };
  }
  if (booking.vendorId) {
    const hubs = await hubIdsForOperationsManager(userId);
    if (hubs.includes(booking.vendorId)) {
      return { booking, role: 'OPERATIONS_MANAGER' as const, isManager: true };
    }
  }
  throw new DispatchError('FORBIDDEN', 'You cannot access this conversation', 403);
}

export async function listBookingMessages(userId: string, bookingId: string, limit = 50) {
  const { booking } = await resolveChatAccess(userId, bookingId);

  const take = Math.min(Math.max(limit, 1), 100);
  const messages = await prisma.bookingMessage.findMany({
    where: { bookingId },
    orderBy: { createdAt: 'asc' },
    take,
    select: {
      id: true,
      senderUserId: true,
      senderRole: true,
      body: true,
      createdAt: true,
      readAt: true,
    },
  });
  return { bookingId, status: booking.status, chatAvailable: chatAllowed(booking.status), messages };
}

export async function sendBookingMessage(userId: string, bookingId: string, rawBody: unknown) {
  const body = typeof rawBody === 'string' ? rawBody.trim() : '';
  if (body.length < 1) throw new DispatchError('BAD_REQUEST', 'Message cannot be empty', 400);
  if (body.length > MAX_BODY) throw new DispatchError('BAD_REQUEST', 'Message is too long', 400);

  const { booking, role } = await resolveChatAccess(userId, bookingId);
  if (!chatAllowed(booking.status)) {
    throw new DispatchError('CHAT_NOT_AVAILABLE', `Chat is not available while the booking is ${booking.status}`, 409);
  }

  const message = await prisma.bookingMessage.create({
    data: {
      bookingId,
      senderUserId: userId,
      senderRole: role,
      body,
    },
    select: {
      id: true,
      senderUserId: true,
      senderRole: true,
      body: true,
      createdAt: true,
    },
  });

  await prisma.booking.update({
    where: { id: bookingId },
    data: { lastChatAt: message.createdAt },
  });

  const peers = [booking.customer.userId, booking.employee?.userId, booking.vendor?.userId].filter(
    (id): id is string => Boolean(id) && id !== userId
  );
  const uniquePeers = [...new Set(peers)];
  const payload = {
    bookingId,
    messageId: message.id,
    senderRole: message.senderRole,
    createdAt: message.createdAt.toISOString(),
  };
  emitUserEvent('booking:chat', payload, [...uniquePeers, userId]);
  emitToBookingRoom(bookingId, 'booking:chat', payload);

  if (uniquePeers.length) {
    void notifyUsers(
      uniquePeers,
      `New message #${booking.bookingNumber}`,
      body.slice(0, 80),
      { bookingId, type: 'booking:chat' }
    );
  }

  return message;
}

/** Recent hub conversations for BOM inbox. */
export async function listHubChatInbox(userId: string, hubIds: string[], limit = 40) {
  if (hubIds.length === 0) return [];
  const take = Math.min(Math.max(limit, 1), 80);
  const bookings = await prisma.booking.findMany({
    where: {
      vendorId: { in: hubIds },
      OR: [
        { lastChatAt: { not: null } },
        {
          status: {
            in: [
              'ASSIGNED',
              'ACCEPTED',
              'ON_THE_WAY',
              'ARRIVED',
              'IN_PROGRESS',
              'AWAITING_CUSTOMER_CONFIRMATION',
              'AWAITING_PAYMENT',
            ],
          },
        },
      ],
    },
    orderBy: [{ lastChatAt: 'desc' }, { updatedAt: 'desc' }],
    take,
    select: {
      id: true,
      bookingNumber: true,
      status: true,
      scheduledDate: true,
      scheduledTimeSlot: true,
      lastChatAt: true,
      service: { select: { name: true } },
      package: { select: { name: true } },
      customer: { select: { user: { select: { name: true, phone: true } } } },
      employee: { select: { user: { select: { name: true } } } },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { body: true, createdAt: true, senderRole: true },
      },
    },
  });

  return bookings.map((b) => {
    const last = b.messages[0] || null;
    return {
      bookingId: b.id,
      bookingNumber: b.bookingNumber,
      status: b.status,
      scheduledDate: b.scheduledDate,
      scheduledTimeSlot: b.scheduledTimeSlot,
      serviceName: b.package?.name || b.service?.name || 'Service',
      customerName: b.customer?.user?.name || '',
      customerPhone: b.customer?.user?.phone || '',
      employeeName: b.employee?.user?.name || '',
      lastChatAt: b.lastChatAt?.toISOString() || last?.createdAt?.toISOString() || null,
      lastMessage: last?.body || null,
      lastSenderRole: last?.senderRole || null,
      chatAvailable: chatAllowed(b.status),
    };
  });
}
