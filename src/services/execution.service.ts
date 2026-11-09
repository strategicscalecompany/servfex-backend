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

const DEFAULT_WORK_RADIUS_METERS = 200;
/** Planned 10-hour day (09:00–19:00). Checkout allowed after last job even if before 10h when ops ends early. */
const MIN_SHIFT_HOURS = 0;
/** Mandatory online cycle after check-in. */
export const SHIFT_HOURS = 10;
/** Kept for compatibility; late checkout is notified to HOM instead of a 2h grace flag. */
export const GRACE_HOURS = 0;
export const CHECK_IN_START_HOUR = 9;
export const CHECK_IN_GRACE_MINUTES = 30;

export function computeShiftTiming(hubCheckedInAt: Date | string | null | undefined, now: Date = new Date()) {
  if (!hubCheckedInAt) {
    return {
      workedHours: 0,
      shiftEndsAt: null as Date | null,
      graceEndsAt: null as Date | null,
      isShiftOverdue: false,
      isInGrace: false,
      needsReturnToHub: false,
      canCheckOut: false,
    };
  }
  const checkInMs = new Date(hubCheckedInAt).getTime();
  const workedHours = (now.getTime() - checkInMs) / (1000 * 60 * 60);
  const shiftEndsAt = new Date(checkInMs + SHIFT_HOURS * 60 * 60 * 1000);
  const graceEndsAt = new Date(checkInMs + (SHIFT_HOURS + GRACE_HOURS) * 60 * 60 * 1000);
  const isShiftOverdue = workedHours >= SHIFT_HOURS;
  const isInGrace = isShiftOverdue && workedHours < SHIFT_HOURS + GRACE_HOURS;
  return {
    workedHours: Math.round(workedHours * 10) / 10,
    shiftEndsAt,
    graceEndsAt,
    isShiftOverdue,
    isInGrace,
    needsReturnToHub: isShiftOverdue,
    canCheckOut: workedHours >= MIN_SHIFT_HOURS,
  };
}

export function isLateWorkerFlagged(lateWorkerFlaggedAt: Date | string | null | undefined): boolean {
  return Boolean(lateWorkerFlaggedAt);
}
import {
  generateCompletionOtp,
  generateStartOtp,
  isValidCompletionOtp,
  isValidStartOtp,
  normalizeCompletionOtp,
  normalizeStartOtp,
} from '../utils/start-otp';
import { buildUpiPaymentUri, formatRupeeAmount, isValidUpiId, isValidUtr, normalizeUpiId, normalizeUtr } from '../utils/upi';
import { getDrivingDirections } from './directions.service';
import { emitBookingRefresh, emitToBookingRoom, emitUserEvent } from '../utils/realtime';
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

  const locationPayload = { bookingId, reason: 'LOCATION_UPDATED' };
  emitUserEvent('booking:location', locationPayload, [booking.customer.userId, userId]);
  emitToBookingRoom(bookingId, 'booking:location', locationPayload);

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
  let remainingDistanceKm: number | null = null;
  let etaMinutes = booking.etaMinutes;
  let encodedPolyline: string | null = null;
  let routeSource: 'GOOGLE_DIRECTIONS' | 'OSRM' | 'HAVERSINE' | null = null;

  if (sharing && isValidCoordinate(customerLat, customerLng) && isValidCoordinate(proLat, proLng)) {
    const route = await getDrivingDirections(
      proLat as number,
      proLng as number,
      customerLat as number,
      customerLng as number
    );
    remainingDistanceKm = route.remainingDistanceKm;
    etaMinutes = route.etaMinutes;
    encodedPolyline = route.encodedPolyline;
    routeSource = route.source;
  }

  return {
    bookingId: booking.id,
    bookingNumber: booking.bookingNumber,
    status: booking.status,
    sharing,
    etaMinutes,
    remainingDistanceKm,
    encodedPolyline,
    routeSource,
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

  // PIN verified — stay ARRIVED until at least 4 before photos are uploaded, then IN_PROGRESS.
  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      qrVerifiedAt: new Date(),
      qrChallengeToken: null,
      startOtpAttempts: 0,
      startOtpLockedUntil: null,
      statusHistory: {
        create: {
          oldStatus: booking.status,
          newStatus: booking.status,
          changedBy: userId,
          changedByRole: 'EMPLOYEE',
          reason: 'Customer start OTP verified on site. Upload 4 before photos to begin work.',
        },
      },
    },
  });

  await notifyUsers(
    [booking.customer.userId],
    `Professional on site #${booking.bookingNumber}`,
    'Your service professional verified the start PIN and is capturing before photos. Work begins shortly.',
    { bookingId, type: 'booking:pin_verified' }
  );
  void emitBookingRefresh(bookingId, { reason: 'START_PIN_VERIFIED' });
  return updated;
}

/**
 * After start PIN (or desk arrival) + ≥4 before photos, officially begin work (IN_PROGRESS)
 * and issue the customer completion PIN.
 */
export async function beginWorkAfterBeforePhotos(userId: string, bookingId: string) {
  const { hasRequiredBeforePhotos, MIN_BEFORE_PHOTOS, countValidBeforePhotos } = await import(
    '../config/testing-workflow'
  );

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { employee: { select: { userId: true } }, customer: { select: { userId: true } } },
  });
  if (!booking) throw new DispatchError('NOT_FOUND', 'Order not found', 404);
  if (booking.employee?.userId !== userId) {
    throw new DispatchError('FORBIDDEN', 'Only the assigned professional can start this job', 403);
  }
  if (booking.status === 'IN_PROGRESS') {
    return booking;
  }
  if (booking.status !== 'ARRIVED') {
    throw new DispatchError(
      'INVALID_TRANSITION',
      `Cannot begin work while booking is ${booking.status}. Mark arrived and verify the start PIN first.`,
      409
    );
  }

  const deskManaged =
    booking.bookingSource === 'SALES_MANAGER' || booking.bookingSource === 'PHONE_HUB';
  if (!booking.qrVerifiedAt && !deskManaged) {
    throw new DispatchError(
      'BAD_REQUEST',
      'Verify the customer start PIN before uploading before photos and starting work',
      400
    );
  }
  if (!hasRequiredBeforePhotos(booking.beforePhotoUrls)) {
    throw new DispatchError(
      'PHOTOS_REQUIRED',
      `Upload at least ${MIN_BEFORE_PHOTOS} before photographs to show site condition. Currently ${countValidBeforePhotos(booking.beforePhotoUrls)} valid photograph(s) are stored.`,
      400
    );
  }

  const completionToken = generateCompletionOtp();
  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      status: 'IN_PROGRESS',
      qrVerifiedAt: booking.qrVerifiedAt || new Date(),
      qrChallengeToken: null,
      completionOtpToken: completionToken,
      completionOtpExpiresAt: addSeconds(new Date(), env.START_OTP_EXPIRY_MINUTES * 60),
      completionOtpVerifiedAt: null,
      completionOtpAttempts: 0,
      statusHistory: {
        create: {
          oldStatus: booking.status,
          newStatus: 'IN_PROGRESS',
          changedBy: userId,
          changedByRole: 'EMPLOYEE',
          reason: 'Before photographs uploaded. Work officially commenced.',
        },
      },
    },
  });

  await notifyUsers(
    [booking.customer.userId],
    `Service started #${booking.bookingNumber}`,
    'Your service professional captured before photos and started the work. A completion PIN is ready when the job ends.',
    { bookingId, type: 'booking:started' }
  );
  void emitBookingRefresh(bookingId, { reason: 'SERVICE_STARTED' });
  return updated;
}

export async function issueCompletionOtp(bookingId: string, forceNew = false) {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) throw new DispatchError('NOT_FOUND', 'Booking not found', 404);
  if (!booking.qrVerifiedAt) {
    throw new DispatchError('BAD_REQUEST', 'Start PIN must be verified before a completion PIN is issued', 400);
  }
  if (booking.completionOtpVerifiedAt) {
    throw new DispatchError('OTP_ALREADY_USED', 'Completion PIN has already been used', 400);
  }
  if (!['IN_PROGRESS', 'AWAITING_CUSTOMER_CONFIRMATION'].includes(booking.status)) {
    throw new DispatchError('BAD_REQUEST', `Cannot issue a completion PIN while booking is ${booking.status}`, 400);
  }
  const existing = booking.completionOtpToken;
  const expired = booking.completionOtpExpiresAt
    ? booking.completionOtpExpiresAt.getTime() < Date.now()
    : false;
  if (!forceNew && existing && !expired) {
    return existing;
  }
  const token = generateCompletionOtp();
  await prisma.booking.update({
    where: { id: bookingId },
    data: {
      completionOtpToken: token,
      completionOtpExpiresAt: addSeconds(new Date(), env.START_OTP_EXPIRY_MINUTES * 60),
      completionOtpAttempts: 0,
    },
  });
  return token;
}

/**
 * Professional enters the customer's completion PIN to finish a customer-app booking.
 * Returns true when the PIN matches (caller then advances booking status).
 */
export async function assertCompletionOtpForExpert(
  userId: string,
  bookingId: string,
  rawOtp: unknown
): Promise<void> {
  const otp = normalizeCompletionOtp(rawOtp);
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { employee: { select: { userId: true } } },
  });
  if (!booking) throw new DispatchError('NOT_FOUND', 'Order not found', 404);
  if (booking.employee?.userId !== userId) {
    throw new DispatchError('FORBIDDEN', 'Only the assigned professional can verify the completion PIN', 403);
  }
  if (booking.completionOtpVerifiedAt) {
    return; // already verified in a prior attempt that didn't finish status flip
  }
  if (!isValidCompletionOtp(otp)) {
    throw new DispatchError('INVALID_OTP', 'Enter the 4-digit completion PIN shown on the customer app', 400);
  }
  if (!booking.completionOtpToken) {
    // Lazy-issue if start was verified but token missing (older bookings).
    const issued = await issueCompletionOtp(bookingId, true);
    if (issued !== otp) {
      throw new DispatchError(
        'INVALID_OTP',
        'Completion PIN refreshed. Ask the customer to open the booking and share the new code.',
        400
      );
    }
  } else if (booking.completionOtpExpiresAt && booking.completionOtpExpiresAt.getTime() < Date.now()) {
    throw new DispatchError('OTP_EXPIRED', 'Completion PIN expired. Ask the customer to refresh it.', 400);
  } else if (booking.completionOtpToken !== otp) {
    const attempts = (booking.completionOtpAttempts || 0) + 1;
    await prisma.booking.update({
      where: { id: bookingId },
      data: { completionOtpAttempts: attempts },
    });
    throw new DispatchError(
      'INVALID_OTP',
      'Completion PIN does not match. Ask the customer for the 4-digit end code',
      400
    );
  }

  await prisma.booking.update({
    where: { id: bookingId },
    data: {
      completionOtpVerifiedAt: new Date(),
      completionOtpToken: null,
      completionOtpAttempts: 0,
    },
  });
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

export async function confirmUpiCollection(userId: string, bookingId: string, utrRaw: unknown) {
  const utr = normalizeUtr(utrRaw);
  if (!isValidUtr(utr)) {
    throw new DispatchError(
      'INVALID_UTR',
      'Enter the 12-22 character UPI transaction reference (UTR) from the payment app',
      400
    );
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      employee: { select: { userId: true } },
      payments: { select: { id: true, transactionRef: true, status: true, method: true } },
    },
  });
  if (!booking) throw new DispatchError('NOT_FOUND', 'Order not found', 404);
  if (booking.employee?.userId !== userId) {
    throw new DispatchError('FORBIDDEN', 'Only the assigned professional can confirm UPI collection', 403);
  }
  if (!['IN_PROGRESS', 'AWAITING_CUSTOMER_CONFIRMATION', 'AWAITING_PAYMENT'].includes(booking.status)) {
    throw new DispatchError('BAD_REQUEST', 'UPI can be confirmed after the service has started', 400);
  }

  const amount = formatRupeeAmount(booking.totalAmount);
  const existing = booking.payments.find(
    (p) => p.status === 'PAID' && (p.transactionRef === utr || p.method === 'UPI' || p.method === 'CASH')
  );
  if (booking.paymentStatus === 'PAID' || existing) {
    return {
      bookingId,
      paymentStatus: 'PAID',
      amount,
      utr: existing?.transactionRef || utr,
      alreadyRecorded: true,
    };
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          bookingId,
          transactionRef: utr,
          amount,
          status: 'PAID',
          method: 'UPI',
          gatewayResponse: {
            collectorUserId: userId,
            collectionType: 'UPI_UTR',
            confirmedAt: new Date().toISOString(),
          },
        },
      });
      await tx.booking.update({
        where: { id: bookingId },
        data: {
          paymentStatus: 'PAID',
          paymentMethod: 'UPI',
          statusHistory: {
            create: {
              oldStatus: booking.status,
              newStatus: booking.status,
              changedBy: userId,
              changedByRole: 'EMPLOYEE',
              reason: `UPI collected and reconciled with UTR ${utr} for ₹${amount}`,
            },
          },
        },
      });
    });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      const other = await prisma.payment.findUnique({ where: { transactionRef: utr }, select: { bookingId: true } });
      if (other?.bookingId === bookingId) {
        return { bookingId, paymentStatus: 'PAID', amount, utr, alreadyRecorded: true };
      }
      throw new DispatchError('DUPLICATE_UTR', 'This UTR is already recorded on another order', 409);
    }
    throw err;
  }

  void emitBookingRefresh(bookingId, { reason: 'UPI_PAID' });
  return {
    bookingId,
    paymentStatus: 'PAID',
    amount,
    utr,
    alreadyRecorded: false,
    note: 'Service completion is separate from payment status.',
  };
}

export async function setProfessionalAvailability(userId: string, isAvailable: boolean, acceptingRequests?: boolean) {
  const profile = await prisma.employeeProfile.findUnique({ where: { userId } });
  if (!profile) throw new DispatchError('FORBIDDEN', 'Only service professionals can update availability', 403);
  const goingOnline = isAvailable || acceptingRequests === true;
  if (goingOnline && !profile.hubCheckedInAt) {
    throw new DispatchError(
      'HUB_CHECKIN_REQUIRED',
      'Check in at your hub location first. Your app stays locked until you are inside the hub work radius.',
      409
    );
  }
  return prisma.employeeProfile.update({
    where: { id: profile.id },
    data: {
      isAvailable,
      acceptingRequests: acceptingRequests ?? isAvailable,
    },
    select: { id: true, isAvailable: true, acceptingRequests: true, hubCheckedInAt: true },
  });
}

function metersBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversineKm(lat1, lon1, lat2, lon2) * 1000;
}

export async function getHubAttendanceStatus(userId: string) {
  const profile = await prisma.employeeProfile.findUnique({
    where: { userId },
    select: {
      id: true,
      workRadiusMeters: true,
      hubCheckedInAt: true,
      hubCheckedOutAt: true,
      lastHubCheckInAt: true,
      lastHubCheckOutAt: true,
      shiftOverdueNotifiedAt: true,
      lateWorkerFlaggedAt: true,
      isAvailable: true,
      acceptingRequests: true,
      vendor: {
        select: {
          id: true,
          companyName: true,
          latitude: true,
          longitude: true,
          serviceRadiusKm: true,
          location: true,
        },
      },
    },
  });
  if (!profile) throw new DispatchError('FORBIDDEN', 'Only Working Professionals and Sales Managers can use hub attendance', 403);
  const workRadiusMeters = profile.workRadiusMeters > 0 ? profile.workRadiusMeters : DEFAULT_WORK_RADIUS_METERS;
  const checkedIn = Boolean(profile.hubCheckedInAt);
  const timing = computeShiftTiming(profile.hubCheckedInAt);
  const isLateWorker = isLateWorkerFlagged(profile.lateWorkerFlaggedAt);
  return {
    checkedIn,
    canGoOnline: checkedIn,
    workRadiusMeters,
    hubServiceRadiusKm: profile.vendor.serviceRadiusKm ?? 15,
    hub: {
      id: profile.vendor.id,
      name: profile.vendor.companyName,
      location: profile.vendor.location,
      latitude: profile.vendor.latitude,
      longitude: profile.vendor.longitude,
    },
    hubCheckedInAt: profile.hubCheckedInAt,
    hubCheckedOutAt: profile.hubCheckedOutAt,
    lastHubCheckInAt: profile.lastHubCheckInAt,
    lastHubCheckOutAt: profile.lastHubCheckOutAt,
    workedHours: timing.workedHours,
    minShiftHours: MIN_SHIFT_HOURS,
    shiftHours: SHIFT_HOURS,
    graceHours: GRACE_HOURS,
    shiftEndsAt: timing.shiftEndsAt,
    graceEndsAt: timing.graceEndsAt,
    isShiftOverdue: checkedIn && timing.isShiftOverdue,
    isInGrace: checkedIn && timing.isInGrace,
    needsReturnToHub: checkedIn && timing.needsReturnToHub,
    isLateWorker: checkedIn && isLateWorker,
    canCheckOut: checkedIn && timing.canCheckOut,
    isAvailable: profile.isAvailable,
    acceptingRequests: profile.acceptingRequests,
  };
}

export async function hubCheckIn(userId: string, latitude: number, longitude: number) {
  if (!isValidCoordinate(latitude, longitude)) {
    throw new DispatchError('BAD_REQUEST', 'Valid GPS coordinates are required for hub check-in', 400);
  }
  const profile = await prisma.employeeProfile.findUnique({
    where: { userId },
    select: {
      id: true,
      workRadiusMeters: true,
      hubCheckedInAt: true,
      vendor: { select: { latitude: true, longitude: true, companyName: true } },
    },
  });
  if (!profile) throw new DispatchError('FORBIDDEN', 'Only Working Professionals and Sales Managers can check in', 403);
  if (profile.hubCheckedInAt) {
    return getHubAttendanceStatus(userId);
  }
  const hubLat = profile.vendor.latitude;
  const hubLng = profile.vendor.longitude;
  if (!isValidCoordinate(hubLat, hubLng)) {
    throw new DispatchError('HUB_LOCATION_MISSING', 'Hub GPS is not set. Ask Super Admin / Development Manager to pin the hub.', 409);
  }
  const radiusM = profile.workRadiusMeters > 0 ? profile.workRadiusMeters : DEFAULT_WORK_RADIUS_METERS;
  const distanceM = metersBetween(latitude, longitude, hubLat as number, hubLng as number);
  if (distanceM > radiusM) {
    throw new DispatchError(
      'OUTSIDE_HUB_RADIUS',
      `You must be within ${Math.round(radiusM)} m of ${profile.vendor.companyName} to check in. You are about ${Math.round(distanceM)} m away.`,
      409
    );
  }
  const now = new Date();
  const checkInDeadline = new Date(now);
  checkInDeadline.setHours(CHECK_IN_START_HOUR, CHECK_IN_GRACE_MINUTES, 0, 0);
  const lateCheckIn = now > checkInDeadline;

  const full = await prisma.employeeProfile.update({
    where: { id: profile.id },
    data: {
      hubCheckedInAt: now,
      hubCheckedOutAt: null,
      lastHubCheckInAt: now,
      shiftOverdueNotifiedAt: null,
      lateWorkerFlaggedAt: null,
      lastLatitude: latitude,
      lastLongitude: longitude,
      lastLocationAt: now,
      isAvailable: true,
      acceptingRequests: true,
    },
    include: {
      user: { select: { name: true } },
      vendor: { select: { userId: true, companyName: true } },
    },
  });

  if (lateCheckIn && full.vendor?.userId) {
    const { notifyUsers } = await import('./notify.service');
    void notifyUsers(
      [full.vendor.userId],
      'Late hub check-in',
      `${full.user.name} checked in after 09:30 at ${full.vendor.companyName}.`,
      { type: 'attendance:late_check_in', employeeUserId: userId }
    );
  }

  return getHubAttendanceStatus(userId);
}

export async function hubCheckOut(userId: string, latitude: number, longitude: number) {
  if (!isValidCoordinate(latitude, longitude)) {
    throw new DispatchError('BAD_REQUEST', 'Valid GPS coordinates are required for hub check-out', 400);
  }
  const profile = await prisma.employeeProfile.findUnique({
    where: { userId },
    select: {
      id: true,
      workRadiusMeters: true,
      hubCheckedInAt: true,
      vendor: { select: { latitude: true, longitude: true, companyName: true } },
    },
  });
  if (!profile) throw new DispatchError('FORBIDDEN', 'Only Working Professionals and Sales Managers can check out', 403);
  if (!profile.hubCheckedInAt) {
    throw new DispatchError('NOT_CHECKED_IN', 'You are not checked in at the hub', 409);
  }
  // Block checkout while an active field job is still in progress.
  const activeJob = await prisma.booking.findFirst({
    where: {
      OR: [{ employeeId: profile.id }, { helperEmployeeId: profile.id }],
      status: { in: ['ON_THE_WAY', 'ARRIVED', 'IN_PROGRESS'] },
    },
    select: { id: true, bookingNumber: true },
  });
  if (activeJob) {
    throw new DispatchError(
      'ACTIVE_JOB',
      `Finish booking #${activeJob.bookingNumber} before checking out.`,
      409
    );
  }
  void MIN_SHIFT_HOURS;
  const hubLat = profile.vendor.latitude;
  const hubLng = profile.vendor.longitude;
  if (!isValidCoordinate(hubLat, hubLng)) {
    throw new DispatchError('HUB_LOCATION_MISSING', 'Hub GPS is not set', 409);
  }
  const radiusM = profile.workRadiusMeters > 0 ? profile.workRadiusMeters : DEFAULT_WORK_RADIUS_METERS;
  const distanceM = metersBetween(latitude, longitude, hubLat as number, hubLng as number);
  if (distanceM > radiusM) {
    throw new DispatchError(
      'OUTSIDE_HUB_RADIUS',
      `Return to within ${Math.round(radiusM)} m of ${profile.vendor.companyName} to check out. You are about ${Math.round(distanceM)} m away.`,
      409
    );
  }
  const now = new Date();
  await prisma.employeeProfile.update({
    where: { id: profile.id },
    data: {
      hubCheckedInAt: null,
      hubCheckedOutAt: now,
      lastHubCheckOutAt: now,
      shiftOverdueNotifiedAt: null,
      lateWorkerFlaggedAt: null,
      lastLatitude: latitude,
      lastLongitude: longitude,
      lastLocationAt: now,
      isAvailable: false,
      acceptingRequests: false,
    },
  });
  return getHubAttendanceStatus(userId);
}

/** Periodic GPS ping while the professional is hub-checked-in (vendor live map). */
export async function pingHubLocation(userId: string, latitude: number, longitude: number) {
  if (!isValidCoordinate(latitude, longitude)) {
    throw new DispatchError('BAD_REQUEST', 'Valid GPS coordinates are required', 400);
  }
  const profile = await prisma.employeeProfile.findUnique({
    where: { userId },
    select: { id: true, hubCheckedInAt: true },
  });
  if (!profile) {
    throw new DispatchError('FORBIDDEN', 'Only Working Professionals and Sales Managers can ping hub location', 403);
  }
  if (!profile.hubCheckedInAt) {
    throw new DispatchError('NOT_CHECKED_IN', 'You must be checked in at the hub to share location', 409);
  }
  const now = new Date();
  await prisma.employeeProfile.update({
    where: { id: profile.id },
    data: {
      lastLatitude: latitude,
      lastLongitude: longitude,
      lastLocationAt: now,
    },
  });
  return {
    ok: true,
    lastLatitude: latitude,
    lastLongitude: longitude,
    lastLocationAt: now,
  };
}
