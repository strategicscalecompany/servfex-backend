import { BookingStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { atLocalTime, ymdInBookingTz } from '../config/scheduling';
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
import {
  assertChainBeforePhotosReady,
  assertChainCompletionPhotosReady,
  loadVisitChain,
  sumChainAmount,
  syncSharedCompletionOtpToChain,
  syncSharedStartOtpToChain,
} from './booking-visit-chain';

const DEFAULT_WORK_RADIUS_METERS = 200;
/** Checkout allowed anytime after check-in once jobs are done (ops may end early). */
const MIN_SHIFT_HOURS = 0;
/**
 * Hub day is 09:00–18:00 IST (not “check-in + N hours”).
 * SHIFT_HOURS is the nominal length for client display / copy.
 */
export const CHECK_IN_START_HOUR = 9;
export const SHIFT_END_HOUR = 18;
export const SHIFT_HOURS = SHIFT_END_HOUR - CHECK_IN_START_HOUR; // 9
/** Minutes after shift end (or last job while overdue) to return and check out. */
export const POST_SHIFT_RETURN_MINUTES = 30;
/** @deprecated Use POST_SHIFT_RETURN_MINUTES; kept for older clients reading graceHours. */
export const GRACE_HOURS = POST_SHIFT_RETURN_MINUTES / 60;
export const CHECK_IN_GRACE_MINUTES = 30;
/** Not checked in by this IST hour → Absent for BOM roster (force check-in still allowed). */
export const ABSENT_CUTOFF_HOUR = 12;
export const ACTIVE_FIELD_JOB_STATUSES = ['ON_THE_WAY', 'ARRIVED', 'IN_PROGRESS'] as const;

export type CheckInWindowPhase = 'too_early' | 'open' | 'late';

export function getCheckInWindowBounds(now: Date = new Date()) {
  const ymd = ymdInBookingTz(now);
  const windowStart = atLocalTime(ymd, CHECK_IN_START_HOUR, 0);
  const windowEnd = atLocalTime(ymd, CHECK_IN_START_HOUR, CHECK_IN_GRACE_MINUTES);
  return { ymd, windowStart, windowEnd };
}

export function classifyCheckInWindow(now: Date = new Date()): CheckInWindowPhase {
  const { windowStart, windowEnd } = getCheckInWindowBounds(now);
  if (now < windowStart) return 'too_early';
  if (now <= windowEnd) return 'open';
  return 'late';
}

/** True when the pro never checked in and local IST time is past noon. */
export function isAbsentAfterNoon(
  checkedIn: boolean,
  now: Date = new Date()
): boolean {
  if (checkedIn) return false;
  const ymd = ymdInBookingTz(now);
  const noon = atLocalTime(ymd, ABSENT_CUTOFF_HOUR, 0);
  return now.getTime() >= noon.getTime();
}

/**
 * Red profile for BOM: late/absent force check-in flag, or missed post-shift return (suspended).
 * Late force check-in keeps the card red even while the pro is checked in.
 */
export function hasAttendanceRedFlag(opts: {
  lateWorkerFlaggedAt?: Date | string | null;
  isSuspended?: boolean;
}): boolean {
  return Boolean(opts.lateWorkerFlaggedAt) || Boolean(opts.isSuspended);
}

export function computeShiftTiming(
  hubCheckedInAt: Date | string | null | undefined,
  now: Date = new Date(),
  postShiftReturnDeadlineAt?: Date | string | null
) {
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
  const checkInAt = new Date(hubCheckedInAt);
  const checkInMs = checkInAt.getTime();
  const workedHours = (now.getTime() - checkInMs) / (1000 * 60 * 60);
  // Fixed hub day end 18:00 IST on the check-in calendar day (09:00–18:00).
  const shiftEndsAt = atLocalTime(ymdInBookingTz(checkInAt), SHIFT_END_HOUR, 0);
  const isShiftOverdue = now.getTime() >= shiftEndsAt.getTime();
  const deadline = postShiftReturnDeadlineAt
    ? new Date(postShiftReturnDeadlineAt)
    : isShiftOverdue
      ? new Date(shiftEndsAt.getTime() + POST_SHIFT_RETURN_MINUTES * 60 * 1000)
      : null;
  const isInGrace = Boolean(
    isShiftOverdue && deadline && now.getTime() < deadline.getTime()
  );
  return {
    workedHours: Math.round(workedHours * 10) / 10,
    shiftEndsAt,
    graceEndsAt: deadline,
    isShiftOverdue,
    isInGrace,
    needsReturnToHub: isShiftOverdue,
    // Checkout only after hub day ends (18:00 IST). Grace until 18:30 is the return window —
    // still allowed after 18:30 until force-checkout so the pro can finish if they arrive late.
    canCheckOut: isShiftOverdue,
  };
}

export function isLateWorkerFlagged(lateWorkerFlaggedAt: Date | string | null | undefined): boolean {
  return Boolean(lateWorkerFlaggedAt);
}

export async function findActiveFieldJob(employeeProfileId: string) {
  return prisma.booking.findFirst({
    where: {
      OR: [{ employeeId: employeeProfileId }, { helperEmployeeId: employeeProfileId }],
      status: { in: [...ACTIVE_FIELD_JOB_STATUSES] },
    },
    select: { id: true, bookingNumber: true, status: true },
  });
}

/**
 * Start (or keep) the 30m return-to-hub window once the pro is past 18:00 IST and idle.
 * - Idle at/after 18:00: grace ends at a fixed 18:30 IST (not a sliding clock).
 * - Left an active job after 18:30: grace is 30m from now so they can still return.
 * Applies to self check-in and BOM force check-in alike — no exemption.
 */
export async function maybeStartPostShiftReturnGrace(employeeProfileId: string, now: Date = new Date()) {
  const profile = await prisma.employeeProfile.findUnique({
    where: { id: employeeProfileId },
    select: {
      id: true,
      hubCheckedInAt: true,
      postShiftReturnDeadlineAt: true,
    },
  });
  if (!profile?.hubCheckedInAt) return null;
  if (profile.postShiftReturnDeadlineAt) return profile.postShiftReturnDeadlineAt;

  const timing = computeShiftTiming(profile.hubCheckedInAt, now);
  if (!timing.isShiftOverdue || !timing.shiftEndsAt) return null;

  const activeJob = await findActiveFieldJob(employeeProfileId);
  if (activeJob) return null;

  const fixedGraceEndMs =
    timing.shiftEndsAt.getTime() + POST_SHIFT_RETURN_MINUTES * 60 * 1000; // 18:30 IST
  // Still inside 18:00–18:30 → lock to 18:30. Already past 18:30 (e.g. job just finished) → 30m from now.
  const deadline = new Date(
    now.getTime() <= fixedGraceEndMs
      ? fixedGraceEndMs
      : now.getTime() + POST_SHIFT_RETURN_MINUTES * 60 * 1000
  );

  await prisma.employeeProfile.update({
    where: { id: employeeProfileId },
    data: { postShiftReturnDeadlineAt: deadline },
  });
  return deadline;
}

/**
 * Call when a booking leaves active field statuses for an assigned pro.
 * If they are already past 18:00 IST, start the 30m return window.
 */
export async function onEmployeeLeftActiveFieldJob(employeeProfileId: string | null | undefined) {
  if (!employeeProfileId) return;
  await maybeStartPostShiftReturnGrace(employeeProfileId);
}

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
  const chain = await loadVisitChain(bookingId);
  // Always anchor OTP to the booking being opened (and its contiguous visit only).
  const focus =
    chain.find((c) => c.id === bookingId) ||
    chain[0] ||
    (await prisma.booking.findUnique({ where: { id: bookingId } }));
  if (!focus) throw new DispatchError('NOT_FOUND', 'Booking not found', 404);
  if (focus.qrVerifiedAt) {
    throw new DispatchError('OTP_ALREADY_USED', 'Start OTP has already been used', 400);
  }
  const existing = focus.qrChallengeToken;
  const expired = focus.qrChallengeExpiresAt ? focus.qrChallengeExpiresAt.getTime() < Date.now() : false;
  if (!forceNew && existing && !expired) {
    return existing;
  }
  const token = generateStartOtp();
  const expiresAt = addSeconds(new Date(), env.START_OTP_EXPIRY_MINUTES * 60);
  await syncSharedStartOtpToChain(bookingId, token, expiresAt);
  return token;
}

export async function verifyStartOtpForExpert(userId: string, bookingId: string, rawOtp: unknown) {
  const otp = normalizeStartOtp(rawOtp);
  const chain = await loadVisitChain(bookingId);
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { employee: { select: { userId: true } }, customer: { select: { userId: true } } },
  });
  if (!booking) throw new DispatchError('NOT_FOUND', 'Order not found', 404);
  if (booking.employee?.userId !== userId) {
    throw new DispatchError('FORBIDDEN', 'Only the assigned professional can verify the start PIN', 403);
  }
  const primary = chain[0] || booking;
  if (primary.qrVerifiedAt || booking.qrVerifiedAt) {
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
    const secs = Math.max(
      1,
      Math.ceil((booking.startOtpLockedUntil.getTime() - Date.now()) / 1000)
    );
    const mm = Math.floor(secs / 60);
    const ss = String(secs % 60).padStart(2, '0');
    throw new DispatchError(
      'OTP_LOCKED',
      `Too many incorrect PIN attempts. Cool-down ${mm}:${ss} — try again after that.`,
      429
    );
  }
  if (!isValidStartOtp(otp)) {
    throw new DispatchError('INVALID_OTP', 'Enter the 4-digit start OTP shown on the customer app', 400);
  }
  // Prefer this job's token; fall back to contiguous-visit primary only when truly chained.
  const expectedToken =
    booking.qrChallengeToken ||
    (chain.length >= 2 ? primary.qrChallengeToken : null);
  const expectedExpires =
    booking.qrChallengeExpiresAt ||
    (chain.length >= 2 ? primary.qrChallengeExpiresAt : null);
  if (!expectedToken) {
    throw new DispatchError('BAD_REQUEST', 'No start OTP is active. Ask the customer to open the booking.', 400);
  }
  if (expectedExpires && expectedExpires.getTime() < Date.now()) {
    throw new DispatchError('OTP_EXPIRED', 'Start PIN expired. Ask the customer to refresh it.', 400);
  }
  if (expectedToken !== otp) {
    const attempts = (booking.startOtpAttempts || 0) + 1;
    const locked = attempts >= env.START_OTP_MAX_ATTEMPTS;
    const lockUntil = locked
      ? addSeconds(new Date(), env.START_OTP_LOCKOUT_MINUTES * 60)
      : null;
    await prisma.booking.update({
      where: { id: bookingId },
      data: {
        startOtpAttempts: attempts,
        startOtpLockedUntil: lockUntil,
      },
    });
    const remaining = Math.max(0, env.START_OTP_MAX_ATTEMPTS - attempts);
    const lockSecs = env.START_OTP_LOCKOUT_MINUTES * 60;
    const lockLabel = `${Math.floor(lockSecs / 60)}:${String(lockSecs % 60).padStart(2, '0')}`;
    throw new DispatchError(
      locked ? 'OTP_LOCKED' : 'INVALID_OTP',
      locked
        ? `Too many incorrect PIN attempts. Cool-down ${lockLabel} — try again after that.`
        : `Start OTP does not match. ${remaining} attempt${remaining === 1 ? '' : 's'} left before a ${env.START_OTP_LOCKOUT_MINUTES}-min cool-down.`,
      locked ? 429 : 400
    );
  }

  // PIN verified on the whole visit chain — stay ARRIVED until before photos per package.
  const now = new Date();
  const chainIds = chain.length >= 2 ? chain.map((c) => c.id) : [bookingId];
  await prisma.booking.updateMany({
    where: { id: { in: chainIds } },
    data: {
      qrVerifiedAt: now,
      qrChallengeToken: null,
      startOtpAttempts: 0,
      startOtpLockedUntil: null,
    },
  });
  for (const id of chainIds) {
    await prisma.bookingStatusHistory.create({
      data: {
        bookingId: id,
        oldStatus: booking.status,
        newStatus: booking.status,
        changedBy: userId,
        changedByRole: 'EMPLOYEE',
        reason:
          chainIds.length > 1
            ? 'Shared visit start OTP verified. Upload before photos for each package to begin work.'
            : 'Customer start OTP verified on site. Upload 4 before photos to begin work.',
      },
    });
    void emitBookingRefresh(id, { reason: 'START_PIN_VERIFIED' });
  }

  const updated = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
  await notifyUsers(
    [booking.customer.userId],
    `Professional on site #${booking.bookingNumber}`,
    'Your service professional verified the start PIN and is capturing before photos. Work begins shortly.',
    { bookingId, type: 'booking:pin_verified' }
  );
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

  if (!booking.qrVerifiedAt) {
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

  const chain = await loadVisitChain(bookingId);
  const completionToken = generateCompletionOtp();
  const expiresAt = addSeconds(new Date(), env.START_OTP_EXPIRY_MINUTES * 60);
  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      status: 'IN_PROGRESS',
      qrVerifiedAt: booking.qrVerifiedAt || new Date(),
      qrChallengeToken: null,
      completionOtpToken: completionToken,
      completionOtpExpiresAt: expiresAt,
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

  // One shared completion PIN for the contiguous visit only.
  if (chain.length >= 2) {
    await syncSharedCompletionOtpToChain(bookingId, completionToken, expiresAt);
  }

  await notifyUsers(
    [booking.customer.userId],
    `Service started #${booking.bookingNumber}`,
    'Your service professional captured before photos and started the work. A completion PIN is ready when the job ends.',
    { bookingId, type: 'booking:started' }
  );
  void emitBookingRefresh(bookingId, { reason: 'SERVICE_STARTED' });
  for (const sibling of chain) {
    if (sibling.id !== bookingId) void emitBookingRefresh(sibling.id, { reason: 'SERVICE_STARTED' });
  }
  return updated;
}

export async function issueCompletionOtp(bookingId: string, forceNew = false) {
  const chain = await loadVisitChain(bookingId);
  const booking = chain[0] || (await prisma.booking.findUnique({ where: { id: bookingId } }));
  if (!booking) throw new DispatchError('NOT_FOUND', 'Booking not found', 404);
  if (!booking.qrVerifiedAt) {
    throw new DispatchError('BAD_REQUEST', 'Start PIN must be verified before a completion PIN is issued', 400);
  }
  if (booking.completionOtpVerifiedAt) {
    throw new DispatchError('OTP_ALREADY_USED', 'Completion PIN has already been used', 400);
  }
  const anyInProgress = chain.some((c) =>
    ['IN_PROGRESS', 'AWAITING_CUSTOMER_CONFIRMATION'].includes(c.status)
  );
  if (!anyInProgress && !['IN_PROGRESS', 'AWAITING_CUSTOMER_CONFIRMATION'].includes(booking.status)) {
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
  const expiresAt = addSeconds(new Date(), env.START_OTP_EXPIRY_MINUTES * 60);
  await syncSharedCompletionOtpToChain(bookingId, token, expiresAt);
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
  const chain = await loadVisitChain(bookingId);
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { employee: { select: { userId: true } } },
  });
  if (!booking) throw new DispatchError('NOT_FOUND', 'Order not found', 404);
  if (booking.employee?.userId !== userId) {
    throw new DispatchError('FORBIDDEN', 'Only the assigned professional can verify the completion PIN', 403);
  }
  const primary = chain[0] || booking;
  if (primary.completionOtpVerifiedAt || booking.completionOtpVerifiedAt) {
    return; // already verified in a prior attempt that didn't finish status flip
  }
  if (!isValidCompletionOtp(otp)) {
    throw new DispatchError('INVALID_OTP', 'Enter the 4-digit completion PIN shown on the customer app', 400);
  }
  let expected = primary.completionOtpToken || booking.completionOtpToken;
  const expectedExpires = primary.completionOtpExpiresAt || booking.completionOtpExpiresAt;
  if (!expected) {
    // Lazy-issue if start was verified but token missing (older bookings).
    const issued = await issueCompletionOtp(bookingId, true);
    if (issued !== otp) {
      throw new DispatchError(
        'INVALID_OTP',
        'Completion PIN refreshed. Ask the customer to open the booking and share the new code.',
        400
      );
    }
    expected = issued;
  } else if (expectedExpires && expectedExpires.getTime() < Date.now()) {
    throw new DispatchError('OTP_EXPIRED', 'Completion PIN expired. Ask the customer to refresh it.', 400);
  } else if (expected !== otp) {
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

  const chainIds = chain.length >= 2 ? chain.map((c) => c.id) : [bookingId];
  await prisma.booking.updateMany({
    where: { id: { in: chainIds } },
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
      employee: {
        include: {
          user: { select: { id: true, name: true } },
          vendor: { select: { id: true, companyName: true, warehouseName: true, upiId: true } },
        },
      },
      vendor: { select: { id: true, companyName: true, warehouseName: true, upiId: true } },
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
  const hub = booking.vendor || booking.employee?.vendor || null;
  const upiId = normalizeUpiId(hub?.upiId);
  if (!isValidUpiId(upiId)) {
    throw new DispatchError(
      'UPI_REQUIRED',
      'Partner hub UPI is not set. Ask the Provider to save the hub UPI ID before collecting online payment',
      400
    );
  }
  const payeeName = hub?.warehouseName || hub?.companyName || 'ServFex Partner';
  const chain = await loadVisitChain(bookingId);
  const amount = chain.length >= 2 ? sumChainAmount(chain) : booking.totalAmount;
  const uri = buildUpiPaymentUri({
    upiId,
    payeeName,
    amount,
    transactionRef: booking.bookingNumber.replace(/[^a-zA-Z0-9]/g, '').slice(0, 35),
    note:
      chain.length >= 2
        ? `ServFex visit ${booking.bookingNumber} (${chain.length} services)`
        : `ServFex ${booking.service.name} ${booking.bookingNumber}`,
  });
  return {
    bookingId: booking.id,
    bookingNumber: booking.bookingNumber,
    amount,
    currency: 'INR',
    upiId,
    payeeName,
    uri,
    paymentStatus: booking.paymentStatus,
    isVisitChain: chain.length >= 2,
    siblingBookingIds: chain.length >= 2 ? chain.map((c) => c.id) : [],
    note: 'QR display is not payment confirmation. Mark paid only after verified collection or reconciliation.',
  };
}

/**
 * Authoritative payment UPI lives on the hub VendorProfile.
 * Allowed actors: hub partner (VENDOR) or an operations manager assigned to that hub.
 */
export async function saveProviderUpi(userId: string, upiIdRaw: unknown, vendorId?: string | null) {
  const upiId = normalizeUpiId(upiIdRaw);
  if (!isValidUpiId(upiId)) {
    throw new DispatchError('INVALID_UPI', 'Enter a valid UPI ID such as name@upi', 400);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      vendorProfile: { select: { id: true } },
      managerProfile: { select: { id: true, vendorId: true, kind: true, zone: true } },
      employeeProfile: { select: { id: true } },
    },
  });
  if (!user) throw new DispatchError('NOT_FOUND', 'User not found', 404);

  // Settlement UPI is editable only by Business Operation Manager via this portal API.
  // Super Admin edits hub UPI through /admin/vendors (create/update). Partners and pros cannot.
  if (user.role !== 'OPERATIONS_MANAGER' || !user.managerProfile) {
    throw new DispatchError(
      'FORBIDDEN',
      'Only Super Admin or Business Operation Manager can set the hub settlement UPI.',
      403
    );
  }
  if (user.managerProfile.kind && user.managerProfile.kind !== 'OPERATIONS') {
    throw new DispatchError(
      'FORBIDDEN',
      'Only Business Operation Manager can set the hub settlement UPI.',
      403
    );
  }

  const requested = (vendorId && vendorId.trim()) || user.managerProfile.vendorId || null;
  if (!requested) {
    throw new DispatchError('BAD_REQUEST', 'Select a hub before saving the partner UPI ID', 400);
  }

  // Ensure HOM is assigned to this hub (direct vendorId or zone CSV of UUIDs/names).
  const hubs = await prisma.vendorProfile.findMany({
    select: { id: true, companyName: true, warehouseName: true },
  });
  const zone = user.managerProfile.zone || '';
  const zoneParts = zone
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const allowed = new Set<string>();
  if (user.managerProfile.vendorId) allowed.add(user.managerProfile.vendorId);
  for (const hub of hubs) {
    if (zoneParts.includes(hub.id.toLowerCase())) allowed.add(hub.id);
    if (hub.companyName && zoneParts.includes(hub.companyName.trim().toLowerCase())) allowed.add(hub.id);
    if (hub.warehouseName && zoneParts.includes(hub.warehouseName.trim().toLowerCase())) allowed.add(hub.id);
  }
  if (allowed.size > 0 && !allowed.has(requested)) {
    throw new DispatchError('FORBIDDEN', 'You can only set UPI for a hub assigned to you', 403);
  }

  return prisma.vendorProfile.update({
    where: { id: requested },
    data: { upiId },
    select: { id: true, upiId: true, companyName: true },
  });
}

/** @deprecated Use saveProviderUpi — payment UPI is hub-owned. */
export async function saveProfessionalUpi(userId: string, upiIdRaw: unknown) {
  return saveProviderUpi(userId, upiIdRaw);
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

  const chain = await loadVisitChain(bookingId);
  const amount = formatRupeeAmount(chain.length >= 2 ? sumChainAmount(chain) : booking.totalAmount);
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

  const chainIds = chain.length >= 2 ? chain.map((c) => c.id) : [bookingId];
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
            visitChainIds: chainIds,
          },
        },
      });
      await tx.booking.updateMany({
        where: { id: { in: chainIds } },
        data: {
          paymentStatus: 'PAID',
          paymentMethod: 'UPI',
        },
      });
      for (const id of chainIds) {
        await tx.bookingStatusHistory.create({
          data: {
            bookingId: id,
            oldStatus: booking.status,
            newStatus: booking.status,
            changedBy: userId,
            changedByRole: 'EMPLOYEE',
            reason: `UPI collected and reconciled with UTR ${utr} for ₹${amount}${
              chainIds.length > 1 ? ` (visit chain ${chainIds.length} services)` : ''
            }`,
          },
        });
      }
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
  if (goingOnline && profile.bomUnavailableAt) {
    throw new DispatchError(
      'BOM_UNAVAILABLE',
      'Your manager marked you unavailable. Check in at the hub or ask them to restore availability.',
      409
    );
  }
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
      lateCheckInRequestedAt: true,
      postShiftReturnDeadlineAt: true,
      isAvailable: true,
      acceptingRequests: true,
      user: { select: { status: true } },
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
  const timing = computeShiftTiming(profile.hubCheckedInAt, new Date(), profile.postShiftReturnDeadlineAt);
  const isLateWorker = isLateWorkerFlagged(profile.lateWorkerFlaggedAt);
  const phase = classifyCheckInWindow();
  const suspended = profile.user.status === 'SUSPENDED';
  return {
    checkedIn,
    canGoOnline: checkedIn && !suspended,
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
    postShiftReturnMinutes: POST_SHIFT_RETURN_MINUTES,
    shiftEndsAt: timing.shiftEndsAt,
    graceEndsAt: timing.graceEndsAt,
    postShiftReturnDeadlineAt: profile.postShiftReturnDeadlineAt,
    isShiftOverdue: checkedIn && timing.isShiftOverdue,
    isInGrace: checkedIn && timing.isInGrace,
    needsReturnToHub: checkedIn && timing.needsReturnToHub,
    isLateWorker: (checkedIn && isLateWorker) || Boolean(profile.lateWorkerFlaggedAt && suspended),
    canCheckOut: checkedIn && timing.canCheckOut,
    isAvailable: profile.isAvailable,
    acceptingRequests: profile.acceptingRequests,
    checkInWindowPhase: phase,
    canSelfCheckIn: !checkedIn && !suspended && phase === 'open',
    canRequestLateCheckIn: !checkedIn && !suspended && phase === 'late' && !profile.lateCheckInRequestedAt,
    lateCheckInRequested: Boolean(profile.lateCheckInRequestedAt) && !checkedIn,
    lateCheckInRequestedAt: profile.lateCheckInRequestedAt,
    checkInWindowLabel: '09:00 – 09:30 IST',
    isSuspended: suspended,
    isAbsent: isAbsentAfterNoon(checkedIn),
    hasAttendanceRedFlag: hasAttendanceRedFlag({
      lateWorkerFlaggedAt: profile.lateWorkerFlaggedAt,
      isSuspended: suspended,
    }),
  };
}

async function assertInsideHubRadius(
  profile: {
    workRadiusMeters: number;
    vendor: { latitude: number | null; longitude: number | null; companyName: string };
  },
  latitude: number,
  longitude: number,
  action: 'check in' | 'check out' | 'request late check-in'
) {
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
      `You must be within ${Math.round(radiusM)} m of ${profile.vendor.companyName} to ${action}. You are about ${Math.round(distanceM)} m away.`,
      409
    );
  }
  return { radiusM, distanceM };
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
      user: { select: { status: true } },
      vendor: { select: { latitude: true, longitude: true, companyName: true } },
    },
  });
  if (!profile) throw new DispatchError('FORBIDDEN', 'Only Working Professionals and Sales Managers can check in', 403);
  if (profile.user.status === 'SUSPENDED') {
    throw new DispatchError('ACCOUNT_SUSPENDED', 'Your account is suspended. Contact your Business Operation Manager.', 403);
  }
  if (profile.hubCheckedInAt) {
    return getHubAttendanceStatus(userId);
  }

  const phase = classifyCheckInWindow();
  if (phase === 'too_early') {
    throw new DispatchError(
      'TOO_EARLY',
      'Hub check-in opens at 09:00 IST. Please wait until the window starts.',
      409
    );
  }
  if (phase === 'late') {
    throw new DispatchError(
      'LATE_CHECK_IN_REQUIRED',
      'Self check-in closed after 09:30 IST. Request a late check-in for BOM approval.',
      409
    );
  }

  await assertInsideHubRadius(profile, latitude, longitude, 'check in');

  const now = new Date();
  await prisma.employeeProfile.update({
    where: { id: profile.id },
    data: {
      hubCheckedInAt: now,
      hubCheckedOutAt: null,
      lastHubCheckInAt: now,
      shiftOverdueNotifiedAt: null,
      lateWorkerFlaggedAt: null,
      lateCheckInRequestedAt: null,
      postShiftReturnDeadlineAt: null,
      bomUnavailableAt: null,
      lastLatitude: latitude,
      lastLongitude: longitude,
      lastLocationAt: now,
      isAvailable: true,
      acceptingRequests: true,
    },
  });

  return getHubAttendanceStatus(userId);
}

/** After 09:30 IST: pro requests BOM force check-in (cannot self check-in). */
export async function requestLateHubCheckIn(userId: string, latitude: number, longitude: number) {
  if (!isValidCoordinate(latitude, longitude)) {
    throw new DispatchError('BAD_REQUEST', 'Valid GPS coordinates are required for late check-in request', 400);
  }
  const profile = await prisma.employeeProfile.findUnique({
    where: { userId },
    select: {
      id: true,
      workRadiusMeters: true,
      hubCheckedInAt: true,
      lateCheckInRequestedAt: true,
      user: { select: { name: true, status: true } },
      vendor: {
        select: {
          latitude: true,
          longitude: true,
          companyName: true,
          userId: true,
          managers: {
            where: { kind: 'OPERATIONS' },
            select: { userId: true },
          },
        },
      },
    },
  });
  if (!profile) throw new DispatchError('FORBIDDEN', 'Only Working Professionals and Sales Managers can request late check-in', 403);
  if (profile.user.status === 'SUSPENDED') {
    throw new DispatchError('ACCOUNT_SUSPENDED', 'Your account is suspended. Contact your Business Operation Manager.', 403);
  }
  if (profile.hubCheckedInAt) {
    return getHubAttendanceStatus(userId);
  }

  const phase = classifyCheckInWindow();
  if (phase === 'too_early') {
    throw new DispatchError('TOO_EARLY', 'Late check-in requests open after 09:30 IST.', 409);
  }
  if (phase === 'open') {
    throw new DispatchError(
      'CHECK_IN_WINDOW_OPEN',
      'Check-in window is still open until 09:30 IST. Use Check in at hub.',
      409
    );
  }

  await assertInsideHubRadius(profile, latitude, longitude, 'request late check-in');

  const now = new Date();
  if (!profile.lateCheckInRequestedAt) {
    await prisma.employeeProfile.update({
      where: { id: profile.id },
      data: {
        lateCheckInRequestedAt: now,
        lastLatitude: latitude,
        lastLongitude: longitude,
        lastLocationAt: now,
      },
    });

    const bomIds = [
      profile.vendor.userId,
      ...profile.vendor.managers.map((m) => m.userId),
    ].filter(Boolean) as string[];
    if (bomIds.length) {
      void notifyUsers(
        bomIds,
        'Late check-in request',
        `${profile.user.name} missed the 09:00–09:30 window at ${profile.vendor.companyName} and requested late check-in.`,
        { type: 'attendance:late_check_in_request', employeeUserId: userId, employeeProfileId: profile.id }
      );
    }
  } else {
    await prisma.employeeProfile.update({
      where: { id: profile.id },
      data: {
        lastLatitude: latitude,
        lastLongitude: longitude,
        lastLocationAt: now,
      },
    });
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
  const activeJob = await findActiveFieldJob(profile.id);
  if (activeJob) {
    throw new DispatchError(
      'ACTIVE_JOB',
      `Finish booking #${activeJob.bookingNumber} before checking out.`,
      409
    );
  }
  const now = new Date();
  const timing = computeShiftTiming(profile.hubCheckedInAt, now, undefined);
  if (!timing.canCheckOut) {
    throw new DispatchError(
      'SHIFT_NOT_ENDED',
      'Check-out opens at 18:00 IST when your shift ends (grace until 18:30). Stay online until then — even if you are at the hub.',
      409
    );
  }
  void MIN_SHIFT_HOURS;
  await assertInsideHubRadius(profile, latitude, longitude, 'check out');
  await prisma.employeeProfile.update({
    where: { id: profile.id },
    data: {
      hubCheckedInAt: null,
      hubCheckedOutAt: now,
      lastHubCheckOutAt: now,
      shiftOverdueNotifiedAt: null,
      lateWorkerFlaggedAt: null,
      lateCheckInRequestedAt: null,
      postShiftReturnDeadlineAt: null,
      lastLatitude: latitude,
      lastLongitude: longitude,
      lastLocationAt: now,
      isAvailable: false,
      acceptingRequests: false,
    },
  });
  return getHubAttendanceStatus(userId);
}

/**
 * Force checkout + suspend for missed post-shift return. Used by attendance sweeper.
 */
export async function forceCheckoutAndSuspend(employeeProfileId: string, reason: string) {
  const profile = await prisma.employeeProfile.findUnique({
    where: { id: employeeProfileId },
    select: {
      id: true,
      userId: true,
      hubCheckedInAt: true,
      user: { select: { name: true } },
      vendor: {
        select: {
          userId: true,
          companyName: true,
          managers: {
            where: { kind: 'OPERATIONS' },
            select: { userId: true },
          },
        },
      },
    },
  });
  if (!profile?.hubCheckedInAt) return false;

  const now = new Date();
  await prisma.$transaction([
    prisma.employeeProfile.update({
      where: { id: profile.id },
      data: {
        hubCheckedInAt: null,
        hubCheckedOutAt: now,
        lastHubCheckOutAt: now,
        shiftOverdueNotifiedAt: now,
        lateWorkerFlaggedAt: now,
        lateCheckInRequestedAt: null,
        postShiftReturnDeadlineAt: null,
        isAvailable: false,
        acceptingRequests: false,
      },
    }),
    prisma.user.update({
      where: { id: profile.userId },
      data: { status: 'SUSPENDED' },
    }),
  ]);

  const name = profile.user?.name?.trim() || 'Working Professional';
  const bomIds = [
    profile.vendor.userId,
    ...profile.vendor.managers.map((m) => m.userId),
  ].filter(Boolean) as string[];

  void notifyUsers(
    [profile.userId],
    'Account suspended — missed hub checkout',
    `${reason} Contact your Business Operation Manager to clear the red flag.`,
    { type: 'attendance:force_checkout_suspended' }
  );
  if (bomIds.length) {
    void notifyUsers(
      bomIds,
      'Red flag · missed hub checkout',
      `${name} was force checked out and suspended at ${profile.vendor.companyName}. ${reason} Please call them.`,
      {
        type: 'attendance:red_flag_missed_checkout',
        employeeUserId: profile.userId,
        employeeProfileId: profile.id,
      }
    );
  }
  return true;
}

/** Periodic GPS ping — allowed before check-in so HOM can force check-in when the pro is at the hub. */
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
    checkedIn: Boolean(profile.hubCheckedInAt),
    lastLatitude: latitude,
    lastLongitude: longitude,
    lastLocationAt: now,
  };
}

/**
 * BOM force check-in after 09:30 IST.
 * Discretionary: BOM may check in late/absent pros without requiring fresh GPS at the hub.
 * Still marks lateWorkerFlaggedAt so the profile stays red for the day.
 * Also clears attendance suspension from a prior missed checkout.
 * Does NOT exempt the pro from hub-day end: after 18:00 IST they still get 30m grace,
 * then force checkout + suspend + BOM warning if they miss checkout (same as self check-in).
 */
export async function homForceHubCheckIn(actorUserId: string, employeeProfileId: string) {
  const actor = await prisma.user.findUnique({
    where: { id: actorUserId },
    select: {
      role: true,
      managerProfile: { select: { vendorId: true, zone: true } },
    },
  });
  if (!actor || actor.role !== 'OPERATIONS_MANAGER') {
    throw new DispatchError('FORBIDDEN', 'Only Business Operation Managers (BOM) can force check-in', 403);
  }

  const now = new Date();
  const phase = classifyCheckInWindow(now);
  if (phase !== 'late') {
    throw new DispatchError(
      'TOO_EARLY',
      'Force check-in is only available after 09:30 IST. Ask the professional to check in themselves before then.',
      409
    );
  }

  const profile = await prisma.employeeProfile.findUnique({
    where: { id: employeeProfileId },
    select: {
      id: true,
      userId: true,
      vendorId: true,
      hubCheckedInAt: true,
      lastLatitude: true,
      lastLongitude: true,
      lastLocationAt: true,
      user: { select: { name: true, status: true } },
    },
  });
  if (!profile) throw new DispatchError('NOT_FOUND', 'Professional not found', 404);

  if (profile.hubCheckedInAt) {
    return getHubAttendanceStatus(profile.userId);
  }

  await assertHomOwnsEmployeeHub(actor.managerProfile, profile.vendorId);

  const hasGps = isValidCoordinate(profile.lastLatitude, profile.lastLongitude);

  await prisma.$transaction([
    prisma.employeeProfile.update({
      where: { id: profile.id },
      data: {
        hubCheckedInAt: now,
        hubCheckedOutAt: null,
        lastHubCheckInAt: now,
        shiftOverdueNotifiedAt: null,
        // Keep red profile for the rest of the shift — late / absent force check-in.
        lateWorkerFlaggedAt: now,
        lateCheckInRequestedAt: null,
        postShiftReturnDeadlineAt: null,
        bomUnavailableAt: null,
        ...(hasGps
          ? {
              lastLatitude: profile.lastLatitude,
              lastLongitude: profile.lastLongitude,
              lastLocationAt: now,
            }
          : {}),
        isAvailable: true,
        acceptingRequests: true,
      },
    }),
    prisma.user.update({
      where: { id: profile.userId },
      data: { status: 'ACTIVE' },
    }),
  ]);

  return getHubAttendanceStatus(profile.userId);
}

/**
 * BOM marks a Working Professional available/unavailable for slot capacity.
 * Unavailable pros stay out of eligibility until BOM restores them or they check in.
 */
export async function setBomEmployeeAvailability(
  actorUserId: string,
  employeeProfileId: string,
  available: boolean
) {
  const actor = await prisma.user.findUnique({
    where: { id: actorUserId },
    select: {
      role: true,
      managerProfile: { select: { vendorId: true, zone: true } },
    },
  });
  if (!actor || actor.role !== 'OPERATIONS_MANAGER') {
    throw new DispatchError('FORBIDDEN', 'Only Business Operation Managers can manage pro availability', 403);
  }

  const profile = await prisma.employeeProfile.findUnique({
    where: { id: employeeProfileId },
    select: {
      id: true,
      userId: true,
      vendorId: true,
      expertKind: true,
      hubCheckedInAt: true,
      user: { select: { name: true, status: true } },
    },
  });
  if (!profile) throw new DispatchError('NOT_FOUND', 'Professional not found', 404);
  if (profile.expertKind === 'SALES_MANAGER') {
    throw new DispatchError('BAD_REQUEST', 'Availability applies to Working Professionals only', 400);
  }

  await assertHomOwnsEmployeeHub(actor.managerProfile, profile.vendorId);

  const now = new Date();
  // Missed hub checkout auto-SUSPENDs the user. BOM restore must clear that too,
  // otherwise isAvailable=true but slots still exclude them (status !== ACTIVE).
  const updated = available
    ? (
        await prisma.$transaction([
          prisma.employeeProfile.update({
            where: { id: profile.id },
            data: {
              isAvailable: true,
              acceptingRequests: true,
              bomUnavailableAt: null,
            },
            select: {
              id: true,
              isAvailable: true,
              acceptingRequests: true,
              bomUnavailableAt: true,
              hubCheckedInAt: true,
              user: { select: { id: true, name: true } },
            },
          }),
          prisma.user.update({
            where: { id: profile.userId },
            data: { status: 'ACTIVE' },
          }),
        ])
      )[0]
    : await prisma.employeeProfile.update({
        where: { id: profile.id },
        data: {
          isAvailable: false,
          acceptingRequests: false,
          bomUnavailableAt: now,
        },
        select: {
          id: true,
          isAvailable: true,
          acceptingRequests: true,
          bomUnavailableAt: true,
          hubCheckedInAt: true,
          user: { select: { id: true, name: true } },
        },
      });

  return {
    employeeId: updated.id,
    name: updated.user.name,
    available: updated.isAvailable !== false && !updated.bomUnavailableAt,
    bomUnavailable: Boolean(updated.bomUnavailableAt),
    checkedIn: Boolean(updated.hubCheckedInAt),
  };
}

/** HOM force check-out — professional does not need to be at the hub. */
export async function homForceHubCheckOut(actorUserId: string, employeeProfileId: string) {
  const actor = await prisma.user.findUnique({
    where: { id: actorUserId },
    select: {
      role: true,
      managerProfile: { select: { vendorId: true, zone: true } },
    },
  });
  if (!actor || actor.role !== 'OPERATIONS_MANAGER') {
    throw new DispatchError('FORBIDDEN', 'Only Business Operation Managers can force check-out', 403);
  }

  const profile = await prisma.employeeProfile.findUnique({
    where: { id: employeeProfileId },
    select: {
      id: true,
      userId: true,
      vendorId: true,
      hubCheckedInAt: true,
      lastLatitude: true,
      lastLongitude: true,
    },
  });
  if (!profile) throw new DispatchError('NOT_FOUND', 'Professional not found', 404);
  if (!profile.hubCheckedInAt) {
    throw new DispatchError('NOT_CHECKED_IN', 'This professional is not checked in', 409);
  }

  await assertHomOwnsEmployeeHub(actor.managerProfile, profile.vendorId);

  const activeJob = await findActiveFieldJob(profile.id);
  if (activeJob) {
    throw new DispatchError(
      'ACTIVE_JOB',
      `Finish or reassign booking #${activeJob.bookingNumber} before force check-out.`,
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
      lateCheckInRequestedAt: null,
      postShiftReturnDeadlineAt: null,
      lastLocationAt: now,
      isAvailable: false,
      acceptingRequests: false,
    },
  });

  return getHubAttendanceStatus(profile.userId);
}

async function assertHomOwnsEmployeeHub(
  managerProfile: { vendorId: string | null; zone: string | null } | null | undefined,
  employeeVendorId: string
) {
  if (!managerProfile) {
    throw new DispatchError('FORBIDDEN', 'Manager hub assignment missing', 403);
  }
  const allowed = new Set<string>();
  if (managerProfile.vendorId) allowed.add(managerProfile.vendorId);
  for (const part of String(managerProfile.zone || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    if (/^[0-9a-f-]{36}$/i.test(part)) allowed.add(part);
  }
  if (allowed.size === 0 || !allowed.has(employeeVendorId)) {
    // Zone may contain hub names — resolve names to ids
    if (managerProfile.zone) {
      const names = String(managerProfile.zone)
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p && !/^[0-9a-f-]{36}$/i.test(p));
      if (names.length) {
        const hubs = await prisma.vendorProfile.findMany({
          where: {
            OR: [
              { companyName: { in: names, mode: 'insensitive' } },
              { warehouseName: { in: names, mode: 'insensitive' } },
            ],
          },
          select: { id: true },
        });
        for (const h of hubs) allowed.add(h.id);
      }
    }
  }
  if (!allowed.has(employeeVendorId)) {
    throw new DispatchError('FORBIDDEN', 'This professional is not on one of your assigned hubs', 403);
  }
}
