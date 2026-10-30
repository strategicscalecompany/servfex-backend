import { prisma } from '../config/prisma';
import { DispatchError } from './dispatch.errors';
import { chatAllowed } from './execution.service';
import { emitToBookingRoom, emitUserEvent } from '../utils/realtime';
import { notifyUsers } from './notify.service';

const MAX_BODY = 2000;

export async function listBookingMessages(userId: string, bookingId: string, limit = 50) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      customer: { select: { userId: true } },
      employee: { select: { userId: true } },
      vendor: { select: { userId: true } },
    },
  });
  if (!booking) throw new DispatchError('NOT_FOUND', 'Booking not found', 404);
  const allowed =
    booking.customer.userId === userId ||
    booking.employee?.userId === userId ||
    booking.vendor?.userId === userId;
  if (!allowed) throw new DispatchError('FORBIDDEN', 'You cannot access this conversation', 403);

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

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      bookingNumber: true,
      status: true,
      customer: { select: { userId: true } },
      employee: { select: { userId: true } },
    },
  });
  if (!booking) throw new DispatchError('NOT_FOUND', 'Booking not found', 404);
  const isCustomer = booking.customer.userId === userId;
  const isExpert = booking.employee?.userId === userId;
  if (!isCustomer && !isExpert) {
    throw new DispatchError('FORBIDDEN', 'Only the customer and assigned professional can chat on this order', 403);
  }
  if (!chatAllowed(booking.status)) {
    throw new DispatchError('CHAT_NOT_AVAILABLE', `Chat is not available while the booking is ${booking.status}`, 409);
  }

  const message = await prisma.bookingMessage.create({
    data: {
      bookingId,
      senderUserId: userId,
      senderRole: isCustomer ? 'CUSTOMER' : 'EXPERT',
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

  const peerUserId = isCustomer ? booking.employee?.userId : booking.customer.userId;
  const payload = {
    bookingId,
    messageId: message.id,
    senderRole: message.senderRole,
    createdAt: message.createdAt.toISOString(),
  };
  emitUserEvent('booking:chat', payload, [peerUserId, userId]);
  emitToBookingRoom(bookingId, 'booking:chat', payload);

  if (peerUserId) {
    void notifyUsers(
      [peerUserId],
      `New message #${booking.bookingNumber}`,
      body.slice(0, 80),
      { bookingId, type: 'booking:chat' }
    );
  }

  return message;
}
