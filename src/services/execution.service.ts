import { BookingStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { DispatchError } from './dispatch.errors';
import {
  CHATTABLE_STATUSES,
  CALLABLE_STATUSES,
  START_OTP_ELIGIBLE_STATUSES,
  TRACKABLE_STATUSES,
  addSeconds,
  haversineKm,
  isValidCoordinate,
} from './dispatch.rules';
import { generateStartOtp, isValidStartOtp, normalizeStartOtp } from '../utils/start-otp';
import { buildUpiPaymentUri, isValidUpiId, normalizeUpiId } from '../utils/upi';
import { emitBookingRefresh, emitUserEvent } from '../utils/realtime';
import { notifyUsers } from './notify.service';

const LOCATION_STATUSES: BookingStatus[] = TRACKABLE_STATUSES;

export function communicationAllowed(status: BookingStatus): boolean {
  return CALLABLE_STATUSES.includes(status);
}

export function chatAllowed(status: BookingStatus): boolean {
  return CHATTABLE_STATUSES.includes(status);
}

export function trackingAllowed(status: BookingStatus, sharingEnabled: boolean): boolean {
  return sharingEnabled && LOCATION_STATUSES.includes(status);
}

export async function loadBookingParticipants(bookingId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      bookingNumber: true,
      status: true,
      vendorId: true,
      employeeId: true,
      locationSharingEnabled: true,
      totalAmount: true,
      etaMinutes: true,
      professionalLastLatitude: true,
      professionalLastLongitude: true,
      professionalLastLocationAt: true,
      serviceLatitude: true,
      serviceLongitude: true,
      serviceFormattedAddress: true,
      address: { select: { latitude: true, longitude: true, addressLine1: true, city: true } },
      customer: { select: { userId: true, user: { select: { id: true, name: true, phone: true } } } },
      employee: {
        select: {
          id: true,
          userId: true,
          upiId: true,
          lastLatitude: true,
          lastLongitude: true,
          lastLocationAt: true,
          user: { select: { id: true, name: true } },
        },
      },
      vendor: { select: { userId: true, companyName: true } },
    },
  });
  if (!booking) throw new DispatchError('NOT_FOUND', 'Booking not found', 404);
  return booking;
}

export function assertParticipant(
  booking: { customer: { userId: string }; employee: { userId: string } | null },
  userId: string,
  role: 'CUSTOMER' | 'EXPERT' | 'EITHER'
): 'CUSTOMER' | 'EXPERT' {
  const isCustomer = booking.customer.userId === userId;
  const isExpert = booking.employee?.userId === userId;
  if (role === 'CUSTOMER' && !isCustomer) {
    throw new DispatchError('FORBIDDEN', 'Only the booking customer can perform this action', 403);
  }
  if (role === 'EXPERT' && !isExpert) {
    throw new DispatchError('FORBIDDEN', 'Only the assigned professional can perform this action', 403);
  }
  if (role === 'EITHER' && !isCustomer && !isExpert) {
    throw new DispatchError('FORBIDDEN', 'Only the customer and assigned professional can access this booking room', 403);
  }
  return isCustomer ? 'CUSTOMER' : 'EXPERT';
}

export async function setLocationSharing(bookingId: string, enabled: boolean): Promise<void> {
  await prisma.booking.updateMany({
    where: { id: bookingId },
    data: enabled
      ? { locationSharingEnabled: true }
      : {
          locationSharingEnabled: false,
          professionalLastLatitude: null,
          professionalLastLongitude: null,
          professionalLastLocationAt: null,
        },
  });
}

export async function pingProfessionalLocation(
  userId: string,
  bookingId: string,
  latitude: number,
  longitude: number
) {
  if (!isValidCoordinate(latitude, longitude)) {
    throw new DispatchError('BAD_REQUEST', 'Valid latitude and longitude are required', 400);
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      locationSharingEnabled: true,
      professionalLastLocationAt: true,
      employee: { select: { id: true, userId: true } },
      customer: { select: { userId: true } },
    },
  });
  if (!booking) throw new DispatchError('NOT_FOUND', 'Order not found', 404);
  if (booking.employee?.userId !== userId) {
    throw new DispatchError('FORBIDDEN', 'Only the assigned professional can share live location', 403);
  }
  if (!trackingAllowed(booking.status, booking.locationSharingEnabled)) {
    throw new DispatchError('TRACKING_NOT_AVAILABLE', 'Live location sharing is not active for this order', 409);
  }

  const now = new Date();
  const last = booking.professionalLastLocationAt?.getTime() ?? 0;
  if (now.getTime() - last < env.LOCATION_PING_MIN_INTERVAL_MS) {
    return { throttled: true as const, latitude, longitude, updatedAt: booking.professionalLastLocationAt };
  }

  await prisma.$transaction([
    prisma.booking.update({
      where: { id: bookingId },
      data: {
        professionalLastLatitude: latitude,
        professionalLastLongitude: longitude,
        professionalLastLocationAt: now,
      },
    }),
    prisma.employeeProfile.update({
      where: { id: booking.employee.id },
      data: { lastLatitude: latitude, lastLongitude: longitude, lastLocationAt: now },
    }),
  ]);

  emitUserEvent(
    'booking:location',
    { bookingId, reason: 'LOCATION_UPDATED' },
    [booking.customer.userId, userId]
  );

  return { throttled: false as const, latitude, longitude, updatedAt: now };
}

export async function getTrackingSnapshot(userId: string, bookingId: string) {
  const booking = await loadBookingParticipants(bookingId);
  const isCustomer = booking.customer.userId === userId;
  const isExpert = booking.employee?.userId === userId;
  const isVendor = booking.vendor?.userId === userId;
  if (!isCustomer && !isExpert && !isVendor) {
    throw new DispatchError('FORBIDDEN', 'You cannot view tracking for this booking', 403);
  }

  const customerLat = booking.serviceLatitude ?? booking.address.latitude ?? null;
  const customerLng = booking.serviceLongitude ?? booking.address.longitude ?? null;
  const proLat = booking.professionalLastLatitude ?? booking.employee?.lastLatitude ?? null;
  const proLng = booking.professionalLastLongitude ?? booking.employee?.lastLongitude ?? null;
  const sharing = trackingAllowed(booking.status, booking.locationSharingEnabled);
  const distanceKm =
    sharing && isValidCoordinate(customerLat, customerLng) && isValidCoordinate(proLat, proLng)
      ? haversineKm(customerLat as number, customerLng as number, proLat as number, proLng as number)
      : null;

  return {
    bookingId: booking.id,
    bookingNumber: booking.bookingNumber,
    status: booking.status,
    sharing,
    etaMinutes: booking.etaMinutes,
    remainingDistanceKm: distanceKm,
    customer: sharing
      ? {
          latitude: customerLat,
          longitude: customerLng,
          label: booking.serviceFormattedAddress || booking.address.addressLine1,
        }
      : { latitude: null, longitude: null, label: null },
    professional: sharing
      ? {
          name: booking.employee?.user.name || 'Service professional',
          latitude: proLat,
          longitude: proLng,
          updatedAt: booking.professionalLastLocationAt || booking.employee?.lastLocationAt || null,
        }
      : null,
  };
}

export async function issueStartOtp(bookingId: string, forceNew = false) {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) throw new DispatchError('NOT_FOUND', 'Booking not found', 404);
  if (booking.qrVerifiedAt) {
    throw new DispatchError('OTP_ALREADY_USED', 'Start OTP has already been used', 400);
  }
  const existing = booking.qrChallengeToken;
  const expired = booking.qrChallengeExpiresAt ? booking.qrChallengeExpiresAt.getTime() < Date.now() : false;
  if (!forceNew && existing && !expired) {
    return existing;
  }
  const token = generateStartOtp();
  await prisma.booking.update({
    where: { id: bookingId },
    data: {
      qrChallengeToken: token,
      qrChallengeExpiresAt: addSeconds(new Date(), env.START_OTP_EXPIRY_MINUTES * 60),
      startOtpAttempts: 0,
      startOtpLockedUntil: null,
    },
  });
  return token;
}

export async function verifyStartOtpForExpert(userId: string, bookingId: string, rawOtp: unknown) {
  const otp = normalizeStartOtp(rawOtp);
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { employee: { select: { userId: true } }, customer: { select: { userId: true } } },
  });
  if (!booking) throw new DispatchError('NOT_FOUND', 'Order not found', 404);
  if (booking.employee?.userId !== userId) {
    throw new DispatchError('FORBIDDEN', 'Only the assigned professional can verify the start PIN', 403);
  }
  if (booking.qrVerifiedAt) {
    throw new DispatchError('OTP_ALREADY_USED', 'This service has already been OTP-verified and started', 400);
  }
  if (!START_OTP_ELIGIBLE_STATUSES.includes(booking.status)) {
    throw new DispatchError(
      'INVALID_TRANSITION',
      'Confirm arrival before entering the customer start PIN',
      409
    );
  }
  if (booking.startOtpLockedUntil && booking.startOtpLockedUntil.getTime() > Date.now()) {
    throw new DispatchError('OTP_LOCKED', 'Too many incorrect PIN attempts. Try again later.', 429);
  }
  if (!isValidStartOtp(otp)) {
    throw new DispatchError('INVALID_OTP', 'Enter the 4-digit start OTP shown on the customer app', 400);
  }
  if (!booking.qrChallengeToken) {
    throw new DispatchError('BAD_REQUEST', 'No start OTP is active. Ask the customer to open the booking.', 400);
  }
  if (booking.qrChallengeExpiresAt && booking.qrChallengeExpiresAt.getTime() < Date.now()) {
    throw new DispatchError('OTP_EXPIRED', 'Start PIN expired. Ask the customer to refresh it.', 400);
  }
  if (booking.qrChallengeToken !== otp) {
    const attempts = (booking.startOtpAttempts || 0) + 1;
    const locked = attempts >= env.START_OTP_MAX_ATTEMPTS;
    await prisma.booking.update({
      where: { id: bookingId },
      data: {
        startOtpAttempts: attempts,
        startOtpLockedUntil: locked ? addSeconds(new Date(), env.START_OTP_LOCKOUT_MINUTES * 60) : null,
      },
    });
    throw new DispatchError(
      'INVALID_OTP',
      locked
        ? 'Too many incorrect PIN attempts. The PIN is locked temporarily.'
        : 'Start OTP does not match this booking. Ask the customer for the 4-digit code',
      400
    );
  }

  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      status: 'IN_PROGRESS',
      qrVerifiedAt: new Date(),
      qrChallengeToken: null,
      startOtpAttempts: 0,
      startOtpLockedUntil: null,
      statusHistory: {
        create: {
          oldStatus: booking.status,
          newStatus: 'IN_PROGRESS',
          changedBy: userId,
          changedByRole: 'EMPLOYEE',
          reason: 'Customer start OTP verified on site. Work officially commenced.',
        },
      },
    },
  });

  await notifyUsers(
    [booking.customer.userId],
    `Service started #${booking.bookingNumber}`,
    'Your service professional has verified the PIN and started the work.',
    { bookingId, type: 'booking:started' }
  );
  void emitBookingRefresh(bookingId, { reason: 'SERVICE_STARTED' });
  return updated;
}

export async function buildPaymentQr(userId: string, bookingId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      employee: { include: { user: { select: { id: true, name: true } } } },
      service: { select: { name: true } },
    },
  });
  if (!booking) throw new DispatchError('NOT_FOUND', 'Order not found', 404);
  if (booking.employee?.userId !== userId) {
    throw new DispatchError('FORBIDDEN', 'Only the assigned professional can generate a payment QR', 403);
  }
  if (!['IN_PROGRESS', 'AWAITING_CUSTOMER_CONFIRMATION', 'AWAITING_PAYMENT'].includes(booking.status)) {
    throw new DispatchError('BAD_REQUEST', 'Payment QR is available after the service has started', 400);
  }
  const upiId = normalizeUpiId(booking.employee.upiId);
  if (!isValidUpiId(upiId)) {
    throw new DispatchError('UPI_REQUIRED', 'Save a valid UPI ID on your profile before generating a payment QR', 400);
  }
  const amount = booking.totalAmount;
  const uri = buildUpiPaymentUri({
    upiId,
    payeeName: booking.employee.user.name || 'ServFex Professional',
    amount,
    transactionRef: booking.bookingNumber.replace(/[^a-zA-Z0-9]/g, '').slice(0, 35),
    note: `ServFex ${booking.service.name} ${booking.bookingNumber}`,
  });
  return {
    bookingId: booking.id,
    bookingNumber: booking.bookingNumber,
    amount,
    currency: 'INR',
    upiId,
    payeeName: booking.employee.user.name,
    uri,
    paymentStatus: booking.paymentStatus,
    note: 'QR display is not payment confirmation. Mark paid only after verified collection or reconciliation.',
  };
}

export async function saveProfessionalUpi(userId: string, upiIdRaw: unknown) {
  const upiId = normalizeUpiId(upiIdRaw);
  if (!isValidUpiId(upiId)) {
    throw new DispatchError('INVALID_UPI', 'Enter a valid UPI ID such as name@upi', 400);
  }
  const profile = await prisma.employeeProfile.findUnique({ where: { userId } });
  if (!profile) throw new DispatchError('FORBIDDEN', 'Only service professionals can save a UPI ID', 403);
  return prisma.employeeProfile.update({
    where: { id: profile.id },
    data: { upiId },
    select: { id: true, upiId: true },
  });
}

export async function setProfessionalAvailability(userId: string, isAvailable: boolean, acceptingRequests?: boolean) {
  const profile = await prisma.employeeProfile.findUnique({ where: { userId } });
  if (!profile) throw new DispatchError('FORBIDDEN', 'Only service professionals can update availability', 403);
  return prisma.employeeProfile.update({
    where: { id: profile.id },
    data: {
      isAvailable,
      acceptingRequests: acceptingRequests ?? isAvailable,
    },
    select: { id: true, isAvailable: true, acceptingRequests: true },
  });
}
