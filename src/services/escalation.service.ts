import { EscalationStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { DispatchError } from './dispatch.errors';
import { emitUserEvent } from '../utils/realtime';
import { notifyUsers } from './notify.service';

const OPEN_STATUSES: EscalationStatus[] = ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'];

async function hubManagerUserIds(vendorId: string | null | undefined): Promise<string[]> {
  if (!vendorId) {
    const managers = await prisma.user.findMany({
      where: { role: 'OPERATIONS_MANAGER', status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    return managers.map((m) => m.id);
  }
  const managers = await prisma.managerProfile.findMany({
    where: { vendorId, kind: 'OPERATIONS', user: { status: 'ACTIVE', deletedAt: null } },
    select: { userId: true },
  });
  return managers.map((m) => m.userId);
}

export async function createMissedCallEscalation(bookingId: string, callAttemptCount: number) {
  const existing = await prisma.escalationTicket.findFirst({
    where: { bookingId, reason: 'MISSED_CALLS', status: { in: OPEN_STATUSES } },
  });
  if (existing) {
    return prisma.escalationTicket.update({
      where: { id: existing.id },
      data: { callAttemptCount },
    });
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      customer: { include: { user: { select: { id: true, name: true, phone: true } } } },
      employee: { include: { user: { select: { id: true, name: true, phone: true } } } },
      address: { select: { addressLine1: true, city: true } },
      vendor: { select: { userId: true } },
    },
  });
  if (!booking) return null;

  const ticket = await prisma.escalationTicket.create({
    data: {
      bookingId,
      reason: 'MISSED_CALLS',
      status: 'OPEN',
      callAttemptCount,
      customerName: booking.customer.user.name,
      customerPhone: booking.customer.user.phone || '',
      professionalName: booking.employee?.user.name || null,
      professionalPhone: booking.employee?.phone || booking.employee?.user.phone || null,
      professionalId: booking.employeeId,
      orderLocation: booking.serviceFormattedAddress || booking.address.addressLine1,
      orderStatusSnapshot: booking.status,
      createdBy: 'SYSTEM',
      actions: {
        create: {
          actorUserId: 'SYSTEM',
          action: 'CREATED',
          note: `Automatic escalation after ${callAttemptCount} unanswered professional-to-customer calls`,
        },
      },
    },
  });

  const managers = await hubManagerUserIds(booking.vendorId);
  await notifyUsers(
    managers,
    `Escalation: unanswered calls #${booking.bookingNumber}`,
    `${booking.customer.user.name} did not answer ${callAttemptCount} calls from ${booking.employee?.user.name || 'the professional'}. Contact the customer and unblock the job.`,
    { bookingId, ticketId: ticket.id, type: 'booking:escalation' }
  );
  emitUserEvent('booking:escalation', { bookingId, reason: 'MISSED_CALLS', status: 'OPEN' }, [
    ...managers,
    booking.employee?.userId,
    booking.vendor?.userId,
  ]);
  logger.info({ bookingId, ticketId: ticket.id, callAttemptCount }, 'Created missed-call escalation ticket');
  return ticket;
}

export async function recordCallOutcome(callId: string, outcome: 'MISSED' | 'ENDED' | 'DECLINED') {
  const call = await prisma.bookingCall.update({
    where: { id: callId },
    data: {
      status: outcome,
      endedAt: new Date(),
      endReason: outcome === 'MISSED' ? 'Unanswered' : outcome,
    },
  });

  if (outcome !== 'MISSED') return call;

  const booking = await prisma.booking.findUnique({
    where: { id: call.bookingId },
    select: { id: true, employee: { select: { userId: true } }, missedCallCount: true },
  });
  if (!booking?.employee) return call;
  if (call.callerUserId !== booking.employee.userId) return call;

  const missed = (booking.missedCallCount || 0) + 1;
  await prisma.booking.update({
    where: { id: booking.id },
    data: { missedCallCount: missed },
  });

  if (missed >= env.MISSED_CALL_ESCALATION_THRESHOLD) {
    await createMissedCallEscalation(booking.id, missed);
  }
  return call;
}

export async function sweepMissedRingingCalls(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 60 * 1000);
  const ringing = await prisma.bookingCall.findMany({
    where: { status: 'RINGING', startedAt: { lte: cutoff } },
    select: { id: true },
    take: 50,
  });
  for (const call of ringing) {
    try {
      await recordCallOutcome(call.id, 'MISSED');
    } catch (err) {
      logger.warn({ err, callId: call.id }, 'Failed to mark ringing call as missed');
    }
  }
  return ringing.length;
}

export async function listEscalationsForActor(userId: string, status?: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      managerProfile: { select: { vendorId: true, kind: true } },
      vendorProfile: { select: { id: true } },
      employeeProfile: { select: { id: true, vendorId: true } },
    },
  });
  if (!user) throw new DispatchError('FORBIDDEN', 'Unauthorized', 403);

  const where: any = {};
  if (status) where.status = status;
  if (user.role === 'SUPER_ADMIN') {
    // platform-wide
  } else if (user.managerProfile?.vendorId) {
    where.booking = { vendorId: user.managerProfile.vendorId };
  } else if (user.vendorProfile) {
    where.booking = { vendorId: user.vendorProfile.id };
  } else if (user.employeeProfile) {
    where.professionalId = user.employeeProfile.id;
  } else {
    throw new DispatchError('FORBIDDEN', 'You cannot view escalation tickets', 403);
  }

  return prisma.escalationTicket.findMany({
    where,
    include: {
      booking: { select: { id: true, bookingNumber: true, status: true, vendorId: true } },
      actions: { orderBy: { createdAt: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}

export async function resolveEscalation(
  userId: string,
  ticketId: string,
  note: string,
  nextStatus: EscalationStatus = 'RESOLVED'
) {
  const ticket = await prisma.escalationTicket.findUnique({
    where: { id: ticketId },
    include: {
      booking: {
        select: {
          id: true,
          bookingNumber: true,
          vendorId: true,
          employee: { select: { userId: true } },
        },
      },
    },
  });
  if (!ticket) throw new DispatchError('NOT_FOUND', 'Escalation ticket not found', 404);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, managerProfile: { select: { vendorId: true } }, vendorProfile: { select: { id: true } } },
  });
  const canResolve =
    user?.role === 'SUPER_ADMIN' ||
    user?.role === 'OPERATIONS_MANAGER' ||
    (user?.vendorProfile && user.vendorProfile.id === ticket.booking.vendorId);
  if (!canResolve) throw new DispatchError('FORBIDDEN', 'Only a hub operations manager can resolve this ticket', 403);

  const updated = await prisma.escalationTicket.update({
    where: { id: ticketId },
    data: {
      status: nextStatus,
      resolvedBy: userId,
      resolvedAt: nextStatus === 'RESOLVED' || nextStatus === 'CLOSED' ? new Date() : null,
      resolutionNote: note,
      actions: {
        create: {
          actorUserId: userId,
          action: nextStatus,
          note,
        },
      },
    },
    include: { actions: true, booking: { select: { bookingNumber: true } } },
  });

  await notifyUsers(
    [ticket.booking.employee?.userId],
    `Escalation resolved #${ticket.booking.bookingNumber}`,
    note || 'The hub operations manager contacted the customer. Continue the service workflow.',
    { bookingId: ticket.bookingId, ticketId, type: 'booking:escalation' }
  );
  emitUserEvent('booking:escalation', { bookingId: ticket.bookingId, reason: 'RESOLVED', status: nextStatus }, [
    ticket.booking.employee?.userId,
    userId,
  ]);
  return updated;
}
