import { BookingStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { DispatchError } from './dispatch.errors';
import { notifyUsers } from './notify.service';
import { emitUserEvent, emitToBookingRoom } from '../utils/realtime';
import { sendBookingMessage } from './chat.service';

const SUPPORT_COMPLETED_WINDOW_MS = 24 * 60 * 60 * 1000;

const PENDING_STATUSES: BookingStatus[] = [
  'PENDING',
  'ASSIGNED',
  'ACCEPTED',
  'ON_THE_WAY',
  'ARRIVED',
  'IN_PROGRESS',
  'AWAITING_CUSTOMER_CONFIRMATION',
  'AWAITING_PAYMENT',
];

export const BOM_MISSED_CALL_PRESETS = [
  'We tried to call you but did not get any response.',
  'Can we call you now?',
  'We will get back to you as soon as possible.',
] as const;

export const CUSTOMER_SUPPORT_REPLY_PRESETS = [
  'Yes',
  'Thank you',
  'Please call me now',
] as const;

function digitsOnlyPhone(raw?: string | null): string {
  return (raw || '').replace(/\D/g, '');
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isValidCoordinate(lat: number | null | undefined, lng: number | null | undefined): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

async function platformSupportPhoneFallback(): Promise<{
  hubId: string;
  hubName: string;
  managerName: string;
  phone: string;
  distanceKm: number | null;
} | null> {
  const setting = await prisma.platformSetting.findUnique({
    where: { key: 'PLATFORM_GENERAL' },
    select: { value: true },
  });
  const value = (setting?.value || {}) as { supportPhone?: string; platformName?: string };
  const phone = digitsOnlyPhone(value.supportPhone);
  if (!phone) return null;
  return {
    hubId: 'platform',
    hubName: value.platformName || 'ServFex Support',
    managerName: 'ServFex Support',
    phone,
    distanceKm: null,
  };
}

/** BOM may be linked via ManagerProfile.vendorId OR listed in zone CSV (ids/names). */
async function findOpsManagerForHub(hubId: string, hubNameHints: string[]) {
  const direct = await prisma.managerProfile.findFirst({
    where: {
      kind: 'OPERATIONS',
      vendorId: hubId,
      user: { status: 'ACTIVE', deletedAt: null },
    },
    orderBy: { createdAt: 'asc' },
    select: { user: { select: { name: true, phone: true } } },
  });
  if (direct?.user) return direct.user;

  const ops = await prisma.managerProfile.findMany({
    where: {
      kind: 'OPERATIONS',
      user: { status: 'ACTIVE', deletedAt: null },
    },
    select: {
      zone: true,
      vendorId: true,
      user: { select: { name: true, phone: true } },
    },
  });
  const hints = new Set([hubId, ...hubNameHints].map((h) => h.trim().toLowerCase()).filter(Boolean));
  for (const m of ops) {
    const parts = (m.zone || '')
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    if (parts.some((p) => hints.has(p))) return m.user;
  }
  return null;
}

export async function resolveBomSupportContact(params: {
  latitude?: number | null;
  longitude?: number | null;
  vendorId?: string | null;
}): Promise<{
  hubId: string;
  hubName: string;
  managerName: string;
  phone: string;
  distanceKm: number | null;
} | null> {
  const hubs = await prisma.vendorProfile.findMany({
    where: {
      isActive: true,
      ...(params.vendorId ? { id: params.vendorId } : {}),
    },
    select: {
      id: true,
      companyName: true,
      warehouseName: true,
      warehousePhone: true,
      latitude: true,
      longitude: true,
      user: { select: { phone: true, name: true, status: true, deletedAt: true } },
      managers: {
        where: { kind: 'OPERATIONS', user: { status: 'ACTIVE', deletedAt: null } },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { user: { select: { name: true, phone: true } } },
      },
    },
  });
  if (hubs.length === 0) return platformSupportPhoneFallback();

  const lat = params.latitude ?? null;
  const lng = params.longitude ?? null;
  const hasPoint = isValidCoordinate(lat, lng);

  const ranked = hubs
    .map((hub) => {
      let distanceKm: number | null = null;
      if (hasPoint && isValidCoordinate(hub.latitude, hub.longitude)) {
        distanceKm = haversineKm(lat as number, lng as number, hub.latitude as number, hub.longitude as number);
      }
      return { hub, distanceKm };
    })
    .sort((a, b) => {
      if (a.distanceKm == null && b.distanceKm == null) return 0;
      if (a.distanceKm == null) return 1;
      if (b.distanceKm == null) return -1;
      return a.distanceKm - b.distanceKm;
    });

  for (const row of ranked) {
    const linked = row.hub.managers[0]?.user;
    const zoneManager = linked
      ? null
      : await findOpsManagerForHub(row.hub.id, [row.hub.warehouseName || '', row.hub.companyName || '']);
    const manager = linked || zoneManager;
    const managerPhone = digitsOnlyPhone(manager?.phone);
    const warehousePhone = digitsOnlyPhone(row.hub.warehousePhone);
    const ownerPhone =
      row.hub.user?.status === 'ACTIVE' && !row.hub.user?.deletedAt
        ? digitsOnlyPhone(row.hub.user.phone)
        : '';
    const phone = managerPhone || warehousePhone || ownerPhone;
    if (!phone) continue;
    return {
      hubId: row.hub.id,
      hubName: row.hub.warehouseName || row.hub.companyName,
      managerName: manager?.name || row.hub.user?.name || 'Hub Operations',
      phone,
      distanceKm: row.distanceKm,
    };
  }
  return platformSupportPhoneFallback();
}

function isSupportEligibleBooking(b: {
  status: BookingStatus;
  customerConfirmedAt: Date | null;
  updatedAt: Date;
  now?: Date;
}): boolean {
  if (PENDING_STATUSES.includes(b.status)) return true;
  // Customer dispute / report must always be able to open a BOM ticket.
  if (b.status === 'DISPUTED') return true;
  if (b.status !== 'COMPLETED') return false;
  const completedAt = b.customerConfirmedAt || b.updatedAt;
  const now = b.now || new Date();
  return now.getTime() - completedAt.getTime() <= SUPPORT_COMPLETED_WINDOW_MS;
}

export async function listCustomerSupportEligibleBookings(userId: string) {
  const customer = await prisma.customerProfile.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!customer) throw new DispatchError('NOT_FOUND', 'Customer profile not found', 404);

  const now = new Date();
  const since = new Date(now.getTime() - SUPPORT_COMPLETED_WINDOW_MS);
  const bookings = await prisma.booking.findMany({
    where: {
      customerId: customer.id,
      OR: [
        { status: { in: PENDING_STATUSES } },
        { status: 'DISPUTED' },
        {
          status: 'COMPLETED',
          OR: [{ customerConfirmedAt: { gte: since } }, { updatedAt: { gte: since } }],
        },
      ],
    },
    orderBy: [{ updatedAt: 'desc' }],
    take: 40,
    select: {
      id: true,
      bookingNumber: true,
      status: true,
      scheduledDate: true,
      scheduledTimeSlot: true,
      customerConfirmedAt: true,
      updatedAt: true,
      totalAmount: true,
      vendorId: true,
      service: { select: { name: true } },
      package: { select: { name: true } },
    },
  });

  return bookings
    .filter((b) => isSupportEligibleBooking(b))
    .map((b) => ({
      id: b.id,
      bookingNumber: b.bookingNumber,
      status: b.status,
      scheduledDate: b.scheduledDate,
      scheduledTimeSlot: b.scheduledTimeSlot,
      serviceName: b.package?.name || b.service?.name || 'Service',
      totalAmount: b.totalAmount,
      vendorId: b.vendorId,
    }));
}

/** Open CUSTOMER_SUPPORT tickets for this customer (any booking still open). */
export async function listCustomerOpenSupportTickets(userId: string) {
  const customer = await prisma.customerProfile.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!customer) throw new DispatchError('NOT_FOUND', 'Customer profile not found', 404);

  const tickets = await prisma.escalationTicket.findMany({
    where: {
      reason: 'CUSTOMER_SUPPORT',
      status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] },
      booking: { customerId: customer.id },
    },
    orderBy: [{ updatedAt: 'desc' }],
    take: 40,
    select: {
      id: true,
      status: true,
      updatedAt: true,
      createdAt: true,
      booking: {
        select: {
          id: true,
          bookingNumber: true,
          status: true,
          scheduledDate: true,
          lastChatAt: true,
          service: { select: { name: true } },
          package: { select: { name: true } },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { body: true, createdAt: true, senderRole: true },
          },
        },
      },
    },
  });

  return tickets.map((t) => {
    const last = t.booking.messages[0];
    return {
      ticketId: t.id,
      ticketStatus: t.status,
      bookingId: t.booking.id,
      bookingNumber: t.booking.bookingNumber,
      bookingStatus: t.booking.status,
      scheduledDate: t.booking.scheduledDate,
      serviceName: t.booking.package?.name || t.booking.service?.name || 'Service',
      lastMessage: last?.body || null,
      lastMessageAt: (last?.createdAt || t.booking.lastChatAt || t.updatedAt).toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  });
}

export async function createCustomerSupportTicket(
  userId: string,
  bookingId: string,
  issueRaw: string
) {
  const issue = (issueRaw || '').trim();
  if (issue.length < 5) {
    throw new DispatchError('BAD_REQUEST', 'Please describe the issue (at least 5 characters)', 400);
  }
  if (issue.length > 2000) {
    throw new DispatchError('BAD_REQUEST', 'Issue description is too long', 400);
  }

  const customer = await prisma.customerProfile.findUnique({
    where: { userId },
    select: {
      id: true,
      user: { select: { id: true, name: true, phone: true } },
    },
  });
  if (!customer) throw new DispatchError('NOT_FOUND', 'Customer profile not found', 404);

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, customerId: customer.id },
    select: {
      id: true,
      bookingNumber: true,
      status: true,
      vendorId: true,
      customerConfirmedAt: true,
      updatedAt: true,
      employee: { select: { id: true, user: { select: { name: true, phone: true } } } },
      serviceFormattedAddress: true,
      address: { select: { addressLine1: true, city: true } },
      vendor: {
        select: {
          userId: true,
          managers: {
            where: { kind: 'OPERATIONS', user: { status: 'ACTIVE', deletedAt: null } },
            select: { userId: true },
          },
        },
      },
    },
  });
  if (!booking) throw new DispatchError('NOT_FOUND', 'Booking not found', 404);
  if (!isSupportEligibleBooking(booking)) {
    throw new DispatchError(
      'SUPPORT_NOT_ELIGIBLE',
      'Support tickets are only available for pending orders or orders completed in the last 24 hours',
      409
    );
  }

  let ticket = await prisma.escalationTicket.findFirst({
    where: {
      bookingId: booking.id,
      reason: 'CUSTOMER_SUPPORT',
      status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] },
    },
  });

  if (!ticket) {
    ticket = await prisma.escalationTicket.create({
      data: {
        bookingId: booking.id,
        reason: 'CUSTOMER_SUPPORT',
        status: 'OPEN',
        customerName: customer.user.name || 'Customer',
        customerPhone: customer.user.phone || '',
        professionalName: booking.employee?.user?.name || null,
        professionalPhone: booking.employee?.user?.phone || null,
        professionalId: booking.employee?.id || null,
        orderLocation:
          booking.serviceFormattedAddress ||
          [booking.address?.addressLine1, booking.address?.city].filter(Boolean).join(', ') ||
          null,
        orderStatusSnapshot: booking.status,
        createdBy: userId,
        actions: {
          create: {
            actorUserId: userId,
            action: 'CUSTOMER_OPENED_SUPPORT',
            note: issue.slice(0, 500),
          },
        },
      },
    });
  } else {
    await prisma.escalationAction.create({
      data: {
        ticketId: ticket.id,
        actorUserId: userId,
        action: 'CUSTOMER_SUPPORT_UPDATE',
        note: issue.slice(0, 500),
      },
    });
  }

  const message = await sendBookingMessage(userId, booking.id, issue, { forceSupport: true });

  const notifyIds = new Set<string>();
  if (booking.vendor?.userId) notifyIds.add(booking.vendor.userId);
  for (const m of booking.vendor?.managers || []) notifyIds.add(m.userId);
  notifyIds.delete(userId);

  if (notifyIds.size) {
    void notifyUsers(
      [...notifyIds],
      `Support ticket #${booking.bookingNumber}`,
      issue.slice(0, 80),
      { bookingId: booking.id, ticketId: ticket.id, type: 'booking:support' }
    );
  }

  emitUserEvent(
    'booking:escalation',
    { bookingId: booking.id, reason: 'CUSTOMER_SUPPORT', status: ticket.status },
    [...notifyIds, userId]
  );
  emitToBookingRoom(booking.id, 'booking:escalation', {
    bookingId: booking.id,
    reason: 'CUSTOMER_SUPPORT',
  });

  return {
    ticketId: ticket.id,
    bookingId: booking.id,
    bookingNumber: booking.bookingNumber,
    status: ticket.status,
    message,
    presets: {
      bom: [...BOM_MISSED_CALL_PRESETS],
      customer: [...CUSTOMER_SUPPORT_REPLY_PRESETS],
    },
  };
}

export async function getCustomerSupportBootstrap(userId: string, latitude?: number | null, longitude?: number | null) {
  const [eligible, openTickets, contact] = await Promise.all([
    listCustomerSupportEligibleBookings(userId),
    listCustomerOpenSupportTickets(userId),
    resolveBomSupportContact({ latitude, longitude }),
  ]);
  const openBookingIds = new Set(openTickets.map((t) => t.bookingId));
  // Create-ticket picker only shows orders that do not already have an open ticket.
  const eligibleForNew = eligible.filter((b) => !openBookingIds.has(b.id));
  return {
    contact: contact
      ? {
          hubId: contact.hubId,
          hubName: contact.hubName,
          managerName: contact.managerName,
          phone: contact.phone,
        }
      : null,
    eligibleBookings: eligibleForNew,
    openTickets,
    presets: {
      bom: [...BOM_MISSED_CALL_PRESETS],
      customer: [...CUSTOMER_SUPPORT_REPLY_PRESETS],
    },
  };
}
