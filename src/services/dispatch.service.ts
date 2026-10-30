import { Prisma, BookingStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { emitBookingRefresh, emitUserEvent } from '../utils/realtime';
import { cancelDispatchTimer, scheduleDispatch } from './dispatch.scheduler';
import {
  ACTIVE_JOB_STATUSES,
  ESCALATE_AFTER_ATTEMPTS,
  MAX_ACTIVE_JOBS_PER_EXPERT,
  MAX_AUTO_ASSIGN_ATTEMPTS,
  addSeconds,
  haversineKm,
  isValidCoordinate,
  isValidExpertTravelTransition,
  rankEligibleExperts,
  rankExpertsByScore,
  usesCustomerAssignmentWorkflow,
  usesDirectExpertAssignment,
  type ExpertCandidate,
  type ScoredExpertCandidate,
} from './dispatch.rules';
import { isTestingWorkflowEnabled } from '../config/testing-workflow';
import { toMoney } from '../utils/money';
import { notifyUsers } from './notify.service';
import { DispatchError } from './dispatch.errors';

export { DispatchError };

type Tx = Prisma.TransactionClient;

const TX_OPTIONS = { maxWait: 10000, timeout: 20000 };

// ---------------------------------------------------------------------------
// Transaction occupancy (the atomicity primitive behind "only one expert wins")
// ---------------------------------------------------------------------------

/**
 * Pins the booking document in the current Mongo transaction snapshot, then callers RE-READ and
 * apply conditional updateMany so only one concurrent actor can win the pre-transition state.
 * `skipLocked` is retained for call-site compatibility; Mongo has no SKIP LOCKED, so a missing
 * document returns false and a present document returns true.
 */
export async function lockBooking(tx: Tx, bookingId: string, _skipLocked = false): Promise<boolean> {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    select: { id: true },
  });
  return Boolean(booking);
}

async function lockEmployee(tx: Tx, employeeId: string): Promise<void> {
  await tx.employeeProfile.findUnique({
    where: { id: employeeId },
    select: { id: true },
  });
}

// ---------------------------------------------------------------------------
// Workload
// ---------------------------------------------------------------------------

/** Open jobs an expert already holds in the same date + time slot (double-booking prevention). */
async function countActiveJobsInSlot(
  tx: Tx,
  employeeId: string,
  slot: { scheduledDate: string; scheduledTimeSlot: string; excludeBookingId: string }
): Promise<number> {
  return tx.booking.count({
    where: {
      employeeId,
      id: { not: slot.excludeBookingId },
      status: { in: ACTIVE_JOB_STATUSES },
      scheduledDate: slot.scheduledDate,
      scheduledTimeSlot: slot.scheduledTimeSlot,
    },
  });
}

// ---------------------------------------------------------------------------
// Post-commit side effects (sockets never fire for a transaction that rolled back)
// ---------------------------------------------------------------------------

interface Effects {
  refreshBookingId?: string;
  reason?: string;
  offerToUserId?: string | null;
  extraUserIds?: Array<string | null | undefined>;
}

/**
 * Arms (or cancels) the precise in-process timer from the PERSISTED due time. The database is the source of
 * truth; this only reduces latency. If it is lost (restart), the sweeper picks the booking up.
 */
export async function syncDispatchTimer(bookingId: string): Promise<void> {
  try {
    const b = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { status: true, dispatchDueAt: true },
    });
    if (b && b.dispatchDueAt && (b.status === 'PENDING' || b.status === 'ASSIGNED')) {
      scheduleDispatch(bookingId, b.dispatchDueAt);
    } else {
      cancelDispatchTimer(bookingId);
    }
  } catch (err) {
    logger.warn({ err, bookingId }, 'Failed to sync dispatch timer (sweeper will cover it)');
  }
}

async function runEffects(effects: Effects): Promise<void> {
  if (!effects.refreshBookingId) return;
  await syncDispatchTimer(effects.refreshBookingId);
  if (effects.offerToUserId) {
    emitUserEvent(
      'booking:assignment',
      { bookingId: effects.refreshBookingId, reason: effects.reason },
      [effects.offerToUserId]
    );
    void notifyUsers(
      [effects.offerToUserId],
      'New order assigned',
      'You have a new service request. Open ServFex to accept or reject it.',
      { bookingId: effects.refreshBookingId, type: 'booking:assignment' }
    );
  }
  await emitBookingRefresh(effects.refreshBookingId, {
    reason: effects.reason,
    extraUserIds: [effects.offerToUserId, ...(effects.extraUserIds ?? [])],
  });
}

async function notifyAdmins(tx: Tx, title: string, message: string): Promise<void> {
  const admins = await tx.user.findMany({
    where: { role: 'SUPER_ADMIN', status: 'ACTIVE', deletedAt: null },
    select: { id: true },
  });
  if (admins.length === 0) return;
  await tx.notification.createMany({
    data: admins.map((a) => ({ title, message, target: 'SPECIFIC_USER' as const, targetUserId: a.id })),
  });
}

async function recordHistory(
  tx: Tx,
  bookingId: string,
  oldStatus: BookingStatus | null,
  newStatus: BookingStatus,
  changedBy: string,
  changedByRole: 'CUSTOMER' | 'VENDOR' | 'EMPLOYEE' | 'SUPER_ADMIN',
  reason: string
): Promise<void> {
  await tx.bookingStatusHistory.create({
    data: { bookingId, oldStatus, newStatus, changedBy, changedByRole, reason },
  });
}

const BOOKING_FOR_DISPATCH = {
  id: true,
  bookingNumber: true,
  status: true,
  vendorId: true,
  employeeId: true,
  scheduledDate: true,
  scheduledTimeSlot: true,
  dispatchDueAt: true,
  dispatchAttempts: true,
  assignmentMethod: true,
  assignmentStrategy: true,
  outOfRadiusDispatch: true,
  bookingSource: true,
  serviceId: true,
  serviceLatitude: true,
  serviceLongitude: true,
  address: { select: { latitude: true, longitude: true, city: true } },
  service: { select: { name: true } },
  customer: { select: { userId: true } },
  vendor: { select: { userId: true, companyName: true, warehouseName: true } },
} satisfies Prisma.BookingSelect;

export type DispatchBooking = Prisma.BookingGetPayload<{ select: typeof BOOKING_FOR_DISPATCH }>;

export async function readBookingForDispatch(tx: Tx, bookingId: string): Promise<DispatchBooking | null> {
  return tx.booking.findUnique({ where: { id: bookingId }, select: BOOKING_FOR_DISPATCH });
}

// ---------------------------------------------------------------------------
// Offering a booking to ONE expert (shared by manual + automatic assignment)
// ---------------------------------------------------------------------------

export interface OfferParams {
  booking: DispatchBooking;
  employee: { id: string; userId: string; userName: string };
  method: 'PROVIDER' | 'AUTO';
  assignedBy: string; // userId or 'SYSTEM'
  changedByRole: 'VENDOR' | 'SUPER_ADMIN';
  reason: string;
  now: Date;
  expertPayout?: Prisma.Decimal | null;
  dispatchNote?: string | null;
}

/**
 * Must be called with the booking row already locked. The conditional updateMany is the second line of
 * defence: it only succeeds while the booking is still claimable, so even a bug elsewhere cannot make two
 * experts win the same booking. AUTO may only claim a booking that is still PENDING (it can never override
 * a provider's assignment); PROVIDER may also re-assign an ASSIGNED-but-not-yet-accepted booking.
 */
export async function offerToExpertInTx(tx: Tx, p: OfferParams): Promise<void> {
  const { booking, employee, now } = p;

  await lockEmployee(tx, employee.id);

  const clash = await countActiveJobsInSlot(tx, employee.id, {
    scheduledDate: booking.scheduledDate,
    scheduledTimeSlot: booking.scheduledTimeSlot,
    excludeBookingId: booking.id,
  });
  if (clash >= MAX_ACTIVE_JOBS_PER_EXPERT) {
    throw new DispatchError('EXPERT_BUSY', `${employee.userName} already has a job in this time slot`, 409);
  }

  const claimed = await tx.booking.updateMany({
    where: {
      id: booking.id,
      status: p.method === 'AUTO' ? 'PENDING' : { in: ['PENDING', 'ASSIGNED'] },
    },
    data: {
      employeeId: employee.id,
      status: 'ASSIGNED',
      assignmentMethod: p.method,
      assignedAt: now,
      dispatchDueAt: addSeconds(now, env.EXPERT_ACCEPT_WINDOW_SECONDS),
      ...(booking.vendorId ? { vendorId: booking.vendorId } : {}),
      ...(p.expertPayout ? { expertPayout: toMoney(p.expertPayout) } : {}),
      ...(p.dispatchNote ? { notes: p.dispatchNote } : {}),
    },
  });
  if (claimed.count !== 1) {
    throw new DispatchError('ASSIGNMENT_CONFLICT', 'This booking was just assigned by someone else', 409);
  }

  // Invalidate any earlier outstanding offer (re-assignment) and record the new one.
  await tx.bookingAssignment.updateMany({
    where: { bookingId: booking.id, status: 'OFFERED' },
    data: { status: 'CANCELLED', respondedAt: now },
  });
  await tx.bookingAssignment.create({
    data: {
      bookingId: booking.id,
      employeeId: employee.id,
      method: p.method,
      status: 'OFFERED',
      assignedBy: p.assignedBy,
      reason: p.reason,
      offeredAt: now,
    },
  });
  await tx.employeeProfile.update({ where: { id: employee.id }, data: { lastAssignedAt: now } });
  await recordHistory(tx, booking.id, booking.status, 'ASSIGNED', p.assignedBy, p.changedByRole, p.reason);

  await notifyOffer(tx, p);
}

async function notifyOffer(tx: Tx, p: OfferParams): Promise<void> {
  const { booking, employee } = p;
  const warehouse = booking.vendor?.warehouseName || booking.vendor?.companyName || 'your warehouse';

  await tx.notification.create({
    data: {
      title: `New Job Assignment #${booking.bookingNumber}`,
      message: `You have been assigned ${booking.service.name} from ${warehouse}. Please accept or reject within ${Math.round(env.EXPERT_ACCEPT_WINDOW_SECONDS / 60)} minutes.`,
      target: 'SPECIFIC_USER',
      targetUserId: employee.userId,
    },
  });
  await tx.notification.create({
    data: {
      title: `Your service professional has been assigned`,
      message: `${employee.userName} has been assigned to your ${booking.service.name} booking. They will reach your location at the estimated arrival time.`,
      target: 'SPECIFIC_USER',
      targetUserId: booking.customer.userId,
    },
  });
  if (p.method === 'AUTO' && booking.vendor?.userId) {
    await tx.notification.create({
      data: {
        title: `Auto-assigned #${booking.bookingNumber}`,
        message: `No expert was assigned within ${env.PROVIDER_RESPONSE_WINDOW_SECONDS}s, so ${employee.userName} was auto-assigned.`,
        target: 'SPECIFIC_USER',
        targetUserId: booking.vendor.userId,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Automatic assignment
// ---------------------------------------------------------------------------

type AutoAssignOutcome = 'ASSIGNED' | 'NO_EXPERT' | 'EXHAUSTED';

function bookingServicePoint(booking: DispatchBooking): { lat: number; lng: number } | null {
  const lat = booking.serviceLatitude ?? booking.address?.latitude ?? null;
  const lng = booking.serviceLongitude ?? booking.address?.longitude ?? null;
  return isValidCoordinate(lat, lng) ? { lat: lat as number, lng: lng as number } : null;
}

async function loadExpertCandidates(
  tx: Tx,
  booking: DispatchBooking
): Promise<{ candidates: ExpertCandidate[]; nameById: Map<string, string> }> {
  if (!booking.vendorId) {
    return { candidates: [], nameById: new Map() };
  }
  const experts = await tx.employeeProfile.findMany({
    where: {
      vendorId: booking.vendorId,
      ...(isTestingWorkflowEnabled() ? { expertKind: 'SERVICE_PROFESSIONAL' } : {}),
    },
    select: {
      id: true,
      userId: true,
      isAvailable: true,
      acceptingRequests: true,
      lastAssignedAt: true,
      completedJobs: true,
      expertKind: true,
      user: { select: { name: true, status: true, deletedAt: true } },
      vendor: { select: { isActive: true } },
    },
  });

  const expertIds = experts.map((e) => e.id);
  const [busy, previous] = await Promise.all([
    expertIds.length
      ? tx.booking.groupBy({
          by: ['employeeId'],
          where: {
            employeeId: { in: expertIds },
            id: { not: booking.id },
            status: { in: ACTIVE_JOB_STATUSES },
            scheduledDate: booking.scheduledDate,
            scheduledTimeSlot: booking.scheduledTimeSlot,
          },
          _count: { _all: true },
        })
      : Promise.resolve([] as Array<{ employeeId: string | null; _count: { _all: number } }>),
    tx.bookingAssignment.findMany({
      where: { bookingId: booking.id, status: { in: ['REJECTED', 'EXPIRED'] } },
      select: { employeeId: true },
    }),
  ]);

  const busyByExpert = new Map(busy.map((b) => [b.employeeId as string, b._count._all]));
  const excluded = new Set(previous.map((a) => a.employeeId));

  const candidates: ExpertCandidate[] = experts.map((e) => ({
    id: e.id,
    userId: e.userId,
    isAvailable: e.isAvailable,
    acceptingRequests: e.acceptingRequests,
    vendorActive: e.vendor?.isActive !== false,
    userActive: e.user.status === 'ACTIVE' && e.user.deletedAt === null,
    lastAssignedAt: e.lastAssignedAt,
    completedJobs: e.completedJobs,
    activeJobs: busyByExpert.get(e.id) ?? 0,
    excludedForBooking: excluded.has(e.id),
  }));

  return { candidates, nameById: new Map(experts.map((e) => [e.id, e.user.name])) };
}

async function loadNearbyScoredExperts(
  tx: Tx,
  booking: DispatchBooking
): Promise<{ ranked: ScoredExpertCandidate[]; nameById: Map<string, string> }> {
  const point = bookingServicePoint(booking);
  const maxKm = env.OUT_OF_RADIUS_MAX_DISTANCE_KM;
  const vendors = await tx.vendorProfile.findMany({
    where: { isActive: true, kycStatus: { not: 'REJECTED' } },
    select: {
      id: true,
      isActive: true,
      latitude: true,
      longitude: true,
      vendorServices: { where: { isActive: true }, select: { serviceId: true } },
      employees: {
        where: {
          expertKind: 'SERVICE_PROFESSIONAL',
          isAvailable: true,
          acceptingRequests: true,
        },
        select: {
          id: true,
          userId: true,
          isAvailable: true,
          acceptingRequests: true,
          lastAssignedAt: true,
          completedJobs: true,
          lastLatitude: true,
          lastLongitude: true,
          lastLocationAt: true,
          user: { select: { name: true, status: true, deletedAt: true } },
        },
      },
    },
  });

  const expertIds = vendors.flatMap((v) => v.employees.map((e) => e.id));
  const [busy, previous] = await Promise.all([
    expertIds.length
      ? tx.booking.groupBy({
          by: ['employeeId'],
          where: {
            employeeId: { in: expertIds },
            id: { not: booking.id },
            status: { in: ACTIVE_JOB_STATUSES },
            scheduledDate: booking.scheduledDate,
            scheduledTimeSlot: booking.scheduledTimeSlot,
          },
          _count: { _all: true },
        })
      : Promise.resolve([] as Array<{ employeeId: string | null; _count: { _all: number } }>),
    tx.bookingAssignment.findMany({
      where: { bookingId: booking.id, status: { in: ['REJECTED', 'EXPIRED'] } },
      select: { employeeId: true },
    }),
  ]);
  const busyByExpert = new Map(busy.map((b) => [b.employeeId as string, b._count._all]));
  const excluded = new Set(previous.map((a) => a.employeeId));
  const nameById = new Map<string, string>();
  const scoredInput: Array<Omit<ScoredExpertCandidate, 'score' | 'etaMinutes'> & { etaMinutes?: number | null }> = [];

  for (const vendor of vendors) {
    const offersService =
      vendor.vendorServices.length === 0 || vendor.vendorServices.some((vs) => vs.serviceId === booking.serviceId);
    if (!offersService) continue;
    for (const expert of vendor.employees) {
      nameById.set(expert.id, expert.user.name);
      const originLat = expert.lastLatitude ?? vendor.latitude;
      const originLng = expert.lastLongitude ?? vendor.longitude;
      const distanceKm =
        point && isValidCoordinate(originLat, originLng)
          ? haversineKm(point.lat, point.lng, originLat as number, originLng as number)
          : null;
      if (distanceKm != null && distanceKm > maxKm) continue;
      scoredInput.push({
        id: expert.id,
        userId: expert.userId,
        vendorId: vendor.id,
        isAvailable: expert.isAvailable,
        acceptingRequests: expert.acceptingRequests,
        vendorActive: vendor.isActive,
        userActive: expert.user.status === 'ACTIVE' && expert.user.deletedAt === null,
        lastAssignedAt: expert.lastAssignedAt,
        completedJobs: expert.completedJobs,
        activeJobs: busyByExpert.get(expert.id) ?? 0,
        excludedForBooking: excluded.has(expert.id),
        offersService,
        distanceKm,
      });
    }
  }

  return {
    ranked: rankExpertsByScore(scoredInput, {
      maxDistanceKm: maxKm,
      speedKmh: env.AVG_TRAVEL_SPEED_KMH,
    }),
    nameById,
  };
}

async function offerAutoPick(
  tx: Tx,
  booking: DispatchBooking,
  pick: { id: string; userId: string },
  nameById: Map<string, string>,
  now: Date,
  reason: string
): Promise<boolean> {
  try {
    await offerToExpertInTx(tx, {
      booking,
      employee: { id: pick.id, userId: pick.userId, userName: nameById.get(pick.id) ?? 'Expert' },
      method: 'AUTO',
      assignedBy: 'SYSTEM',
      changedByRole: 'SUPER_ADMIN',
      reason,
      now,
    });
    await tx.booking.update({
      where: { id: booking.id },
      data: { dispatchAttempts: 0 },
    });
    return true;
  } catch (err) {
    if (err instanceof DispatchError && (err.code === 'EXPERT_BUSY' || err.code === 'ASSIGNMENT_CONFLICT')) {
      return false;
    }
    throw err;
  }
}

async function autoAssignInTx(tx: Tx, booking: DispatchBooking, now: Date): Promise<AutoAssignOutcome> {
  const windowReason = `Auto-assigned after ${env.PROVIDER_RESPONSE_WINDOW_SECONDS}s without provider action`;
  const nearbyReason = booking.outOfRadiusDispatch
    ? 'Auto-assigned nearest eligible professional (customer outside vendor service radius)'
    : 'Auto-assigned nearest eligible professional after warehouse pool was empty';

  if (booking.vendorId && !booking.outOfRadiusDispatch) {
    const { candidates, nameById } = await loadExpertCandidates(tx, booking);
    for (const pick of rankEligibleExperts(candidates)) {
      const won = await offerAutoPick(tx, booking, pick, nameById, now, windowReason);
      if (won) return 'ASSIGNED';
    }
  }

  const { ranked, nameById } = await loadNearbyScoredExperts(tx, booking);
  for (const pick of ranked) {
    const won = await offerAutoPick(
      tx,
      { ...booking, vendorId: booking.vendorId || pick.vendorId },
      pick,
      nameById,
      now,
      nearbyReason
    );
    if (won) {
      if (!booking.vendorId) {
        await tx.booking.update({
          where: { id: booking.id },
          data: { vendorId: pick.vendorId, outOfRadiusDispatch: true, assignmentStrategy: 'NEAREST_EXPERT' },
        });
      }
      return 'ASSIGNED';
    }
  }

  return booking.dispatchAttempts + 1 >= MAX_AUTO_ASSIGN_ATTEMPTS ? 'EXHAUSTED' : 'NO_EXPERT';
}

async function handleNoExpertInTx(
  tx: Tx,
  booking: DispatchBooking,
  now: Date,
  outcome: AutoAssignOutcome
): Promise<void> {
  const attempts = booking.dispatchAttempts + 1;
  const exhausted = outcome === 'EXHAUSTED';

  await tx.booking.update({
    where: { id: booking.id },
    data: {
      status: 'PENDING',
      dispatchAttempts: attempts,
      // Exhausted bookings stop being polled and wait for the admin desk.
      dispatchDueAt: exhausted ? null : addSeconds(now, env.AUTO_ASSIGN_RETRY_SECONDS),
    },
  });

  if (attempts === 1) {
    // First failure only, so repeated retries / duplicate events never spam anyone.
    await tx.notification.create({
      data: {
        title: `Finding an expert #${booking.bookingNumber}`,
        message: 'All experts nearby are busy right now. We are still looking and will assign one as soon as possible.',
        target: 'SPECIFIC_USER',
        targetUserId: booking.customer.userId,
      },
    });
    if (booking.vendor?.userId) {
      await tx.notification.create({
        data: {
          title: `No expert available #${booking.bookingNumber}`,
          message: `No eligible expert in your warehouse is free for ${booking.service.name} (${booking.scheduledDate}, ${booking.scheduledTimeSlot}). Free up an expert or assign manually.`,
          target: 'SPECIFIC_USER',
          targetUserId: booking.vendor.userId,
        },
      });
    }
  }

  if (attempts === ESCALATE_AFTER_ATTEMPTS || exhausted) {
    await notifyAdmins(
      tx,
      `Escalation: unassigned booking #${booking.bookingNumber}`,
      exhausted
        ? `Auto-assignment gave up after ${attempts} attempts. Manual intervention required.`
        : `No expert has been available for ${attempts} attempts. Please intervene.`
    );
  }
}

// ---------------------------------------------------------------------------
// Idempotent dispatch tick (the ONLY entry point used by the timer and the sweeper)
// ---------------------------------------------------------------------------

export type DispatchResult =
  | 'SKIPPED_NOT_FOUND'
  | 'SKIPPED_LOCKED'
  | 'SKIPPED_NOT_DUE'
  | 'SKIPPED_STATE_CHANGED'
  | 'SKIPPED_TESTING_WORKFLOW'
  | 'SKIPPED_DIRECT_ASSIGNMENT'
  | 'AUTO_ASSIGNED'
  | 'NO_EXPERT'
  | 'OFFER_EXPIRED';

/**
 * Re-checks everything on the server under a row lock, so it is safe to call any number of times,
 * concurrently, from any process, after a restart, or for a booking that was already handled:
 *  - PENDING + due            -> try auto-assignment (provider did nothing within the window)
 *  - ASSIGNED + offer expired -> expire the offer and immediately try the next expert
 *  - anything else            -> no-op (provider/expert already progressed it, or it was cancelled)
 */
export async function processBookingDispatch(
  bookingId: string,
  clock: () => Date = () => new Date()
): Promise<DispatchResult> {
  let result: DispatchResult = 'SKIPPED_STATE_CHANGED';
  const effects: Effects = {};

  await prisma.$transaction(async (tx) => {
    const locked = await lockBooking(tx, bookingId, true);
    if (!locked) {
      const exists = await tx.booking.count({ where: { id: bookingId } });
      result = exists ? 'SKIPPED_LOCKED' : 'SKIPPED_NOT_FOUND';
      return;
    }

    const now = clock();
    const booking = await readBookingForDispatch(tx, bookingId);
    if (!booking) {
      result = 'SKIPPED_NOT_FOUND';
      return;
    }
    if (!booking.dispatchDueAt || booking.dispatchDueAt.getTime() > now.getTime()) {
      result = 'SKIPPED_NOT_DUE';
      return;
    }
    if (
      booking.assignmentStrategy === 'DIRECT_EXPERT' ||
      usesDirectExpertAssignment(booking.bookingSource) ||
      !usesCustomerAssignmentWorkflow(booking.bookingSource)
    ) {
      await tx.booking.updateMany({
        where: { id: bookingId },
        data: { dispatchDueAt: null },
      });
      logger.info({ bookingId, source: booking.bookingSource }, 'Auto-dispatch skipped for manager/direct assignment booking');
      result = 'SKIPPED_DIRECT_ASSIGNMENT';
      return;
    }
    if (isTestingWorkflowEnabled() && booking.bookingSource === 'SALES_MANAGER') {
      await tx.booking.updateMany({
        where: { id: bookingId, bookingSource: 'SALES_MANAGER' },
        data: { dispatchDueAt: null },
      });
      logger.info({ bookingId }, 'Auto-dispatch skipped for Sales Manager booking (Provider assigns)');
      result = 'SKIPPED_TESTING_WORKFLOW';
      return;
    }
    if (booking.status !== 'PENDING' && booking.status !== 'ASSIGNED') {
      result = 'SKIPPED_STATE_CHANGED';
      return;
    }

    let working: DispatchBooking = booking;
    let expired = false;

    if (booking.status === 'ASSIGNED') {
      // Offer expired without a response: free the expert and continue with the rest of the pool.
      await tx.bookingAssignment.updateMany({
        where: { bookingId, status: 'OFFERED' },
        data: { status: 'EXPIRED', respondedAt: now },
      });
      await tx.booking.update({
        where: { id: bookingId },
        data: { status: 'PENDING', employeeId: null, assignmentMethod: null, dispatchDueAt: now },
      });
      await recordHistory(
        tx, bookingId, 'ASSIGNED', 'PENDING', 'SYSTEM', 'SUPER_ADMIN',
        'Expert did not respond in time; offer expired'
      );
      effects.extraUserIds = [booking.vendor?.userId];
      expired = true;
      working = { ...booking, status: 'PENDING', employeeId: null, assignmentMethod: null };
    }

    const outcome = await autoAssignInTx(tx, working, now);
    if (outcome === 'ASSIGNED') {
      const assigned = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { employee: { select: { userId: true } } },
      });
      effects.offerToUserId = assigned?.employee?.userId ?? null;
      effects.reason = 'EXPERT_AUTO_ASSIGNED';
      result = 'AUTO_ASSIGNED';
    } else {
      await handleNoExpertInTx(tx, working, now, outcome);
      effects.reason = 'NO_EXPERT_AVAILABLE';
      result = expired ? 'OFFER_EXPIRED' : 'NO_EXPERT';
    }
    effects.refreshBookingId = bookingId;
  }, TX_OPTIONS);

  await runEffects(effects);
  return result;
}

// ---------------------------------------------------------------------------
// Provider (manual) assignment
// ---------------------------------------------------------------------------

export interface ManualAssignInput {
  bookingId: string;
  vendorId: string;
  vendorUserId: string;
  employeeIdOrUserId: string;
  expertPayout?: number | null;
  note?: string | null;
}

/**
 * Provider picks a specific expert from ITS OWN warehouse. Loses cleanly (409 ASSIGNMENT_CONFLICT) when the
 * auto-assign worker or an expert acceptance got there first. Invalidates the pending fallback because the
 * booking leaves PENDING and `dispatchDueAt` moves to the expert-accept deadline.
 */
export async function assignExpertManually(input: ManualAssignInput) {
  const now = new Date();
  const effects: Effects = { refreshBookingId: input.bookingId, reason: 'EXPERT_ASSIGNED' };

  const updated = await prisma.$transaction(async (tx) => {
    await lockBooking(tx, input.bookingId);
    const booking = await readBookingForDispatch(tx, input.bookingId);
    if (!booking || booking.vendorId !== input.vendorId) {
      throw new DispatchError('NOT_FOUND', 'Order not found', 404);
    }
    if (booking.status !== 'PENDING' && booking.status !== 'ASSIGNED') {
      throw new DispatchError(
        'ASSIGNMENT_CONFLICT',
        `Booking is already ${booking.status} and can no longer be assigned`,
        409
      );
    }

    const employee = await tx.employeeProfile.findFirst({
      where: {
        vendorId: input.vendorId,
        OR: [{ id: input.employeeIdOrUserId }, { userId: input.employeeIdOrUserId }],
      },
      include: { user: { select: { name: true, status: true, deletedAt: true } } },
    });
    if (!employee) {
      throw new DispatchError('EXPERT_NOT_IN_WAREHOUSE', 'Expert does not belong to your warehouse', 400);
    }
    if (isTestingWorkflowEnabled() && employee.expertKind === 'SALES_MANAGER') {
      throw new DispatchError(
        'EXPERT_NOT_ELIGIBLE',
        `${employee.user.name} is a Sales Manager and cannot be assigned a service job`,
        400
      );
    }
    if (!employee.isAvailable || employee.user.status !== 'ACTIVE' || employee.user.deletedAt) {
      throw new DispatchError('EXPERT_UNAVAILABLE', `${employee.user.name} is currently unavailable`, 409);
    }

    const note = (input.note || '').trim();
    await offerToExpertInTx(tx, {
      booking,
      employee: { id: employee.id, userId: employee.userId, userName: employee.user.name },
      method: 'PROVIDER',
      assignedBy: input.vendorUserId,
      changedByRole: 'VENDOR',
      reason: note || `Assigned ${employee.user.name} by provider`,
      now,
      expertPayout: input.expertPayout ? new Prisma.Decimal(input.expertPayout.toFixed(2)) : null,
      dispatchNote: note ? `[Dispatch Note]: ${note}` : null,
    });

    effects.offerToUserId = employee.userId;
    return tx.booking.findUnique({
      where: { id: input.bookingId },
      include: {
        employee: { include: { user: { select: { name: true, phone: true } } } },
        service: true,
        customer: { include: { user: true } },
      },
    });
  }, TX_OPTIONS);

  await runEffects(effects);
  return updated;
}

// ---------------------------------------------------------------------------
// Expert acceptance
// ---------------------------------------------------------------------------

async function loadExpertContext(tx: Tx, userId: string) {
  const profile = await tx.employeeProfile.findUnique({
    where: { userId },
    include: { user: { select: { name: true } } },
  });
  if (!profile) throw new DispatchError('FORBIDDEN', 'Only experts can respond to assignments', 403);
  if (isTestingWorkflowEnabled() && profile.expertKind === 'SALES_MANAGER') {
    throw new DispatchError('FORBIDDEN', 'Sales Managers cannot accept or complete service jobs', 403);
  }
  return profile;
}

/**
 * Only the CURRENTLY assigned expert may accept, only while the booking is ASSIGNED. A stale offer
 * (re-assigned, expired, cancelled) is refused with 409 instead of silently succeeding.
 * Repeating the call after success is idempotent (returns success, no duplicate events).
 */
export async function acceptAssignment(userId: string, bookingId: string, etaMinutes?: number | null) {
  const now = new Date();
  const effects: Effects = { refreshBookingId: bookingId, reason: 'EXPERT_ACCEPTED' };
  const confirmedEta =
    typeof etaMinutes === 'number' && Number.isFinite(etaMinutes)
      ? Math.max(1, Math.min(Math.round(etaMinutes), 240))
      : null;

  const result = await prisma.$transaction(async (tx) => {
    const expert = await loadExpertContext(tx, userId);
    await lockBooking(tx, bookingId);
    const booking = await readBookingForDispatch(tx, bookingId);
    if (!booking) throw new DispatchError('NOT_FOUND', 'Order not found', 404);

    if (booking.employeeId !== expert.id) {
      throw new DispatchError(
        'NOT_ASSIGNED_TO_YOU',
        'This booking is not assigned to you (it may have been reassigned or taken).',
        409
      );
    }
    if (booking.status === 'ACCEPTED') return { alreadyAccepted: true };
    if (booking.status !== 'ASSIGNED') {
      throw new DispatchError('BOOKING_NOT_ACCEPTABLE', `Booking is ${booking.status} and cannot be accepted`, 409);
    }

    const flipped = await tx.booking.updateMany({
      where: { id: bookingId, status: 'ASSIGNED', employeeId: expert.id },
      data: {
        status: 'ACCEPTED',
        acceptedAt: now,
        dispatchDueAt: null,
        dispatchAttempts: 0,
        locationSharingEnabled: true,
        ...(confirmedEta ? { etaMinutes: confirmedEta, etaConfirmedAt: now } : {}),
      },
    });
    if (flipped.count !== 1) {
      throw new DispatchError('ASSIGNMENT_CONFLICT', 'Assignment changed while accepting. Please refresh.', 409);
    }
    await tx.bookingAssignment.updateMany({
      where: { bookingId, employeeId: expert.id, status: 'OFFERED' },
      data: { status: 'ACCEPTED', respondedAt: now },
    });
    await recordHistory(tx, bookingId, 'ASSIGNED', 'ACCEPTED', userId, 'EMPLOYEE', `Order accepted by ${expert.user.name}`);

    const etaText = confirmedEta ? ` They will reach your location in about ${confirmedEta} minutes.` : ' They will reach your location at the estimated arrival time.';
    await tx.notification.create({
      data: {
        title: 'Your service professional has been assigned',
        message: `${expert.user.name} accepted your ${booking.service.name} booking.${etaText}`,
        target: 'SPECIFIC_USER',
        targetUserId: booking.customer.userId,
      },
    });
    if (booking.vendor?.userId) {
      await tx.notification.create({
        data: {
          title: `Job Accepted #${booking.bookingNumber}`,
          message: `Expert ${expert.user.name} has accepted order #${booking.bookingNumber} (${booking.service.name}).`,
          target: 'SPECIFIC_USER',
          targetUserId: booking.vendor.userId,
        },
      });
    }
    return { alreadyAccepted: false };
  }, TX_OPTIONS);

  if (result.alreadyAccepted) effects.refreshBookingId = undefined;
  void runEffects(effects);
  cancelDispatchTimer(bookingId);
  return result;
}

// ---------------------------------------------------------------------------
// Expert rejection
// ---------------------------------------------------------------------------

/**
 * Expert declines the offer. The booking returns to the pool and is re-dispatched immediately
 * (excluding the rejecting expert). Repeating the call is idempotent.
 */
export async function rejectAssignment(userId: string, bookingId: string, reason?: string | null) {
  const now = new Date();
  const effects: Effects = { refreshBookingId: bookingId, reason: 'EXPERT_REJECTED' };

  const outcome = await prisma.$transaction(async (tx) => {
    const expert = await loadExpertContext(tx, userId);
    await lockBooking(tx, bookingId);
    const booking = await readBookingForDispatch(tx, bookingId);
    if (!booking) throw new DispatchError('NOT_FOUND', 'Order not found', 404);

    if (booking.employeeId !== expert.id) {
      // Already released (earlier call, expiry or reassignment): nothing to do, nothing leaked.
      return { released: false };
    }
    if (booking.status !== 'ASSIGNED') {
      throw new DispatchError(
        'BOOKING_NOT_REJECTABLE',
        `Booking is already ${booking.status}. Ask your provider to unassign you.`,
        409
      );
    }

    await tx.bookingAssignment.updateMany({
      where: { bookingId, employeeId: expert.id, status: 'OFFERED' },
      data: { status: 'REJECTED', respondedAt: now, reason: reason?.trim() || 'Rejected by expert' },
    });
    const keepDirect = usesDirectExpertAssignment(booking.bookingSource) || booking.assignmentStrategy === 'DIRECT_EXPERT';
    await tx.booking.update({
      where: { id: bookingId },
      data: {
        status: 'PENDING',
        employeeId: null,
        assignmentMethod: null,
        locationSharingEnabled: false,
        dispatchDueAt: keepDirect ? null : now,
        dispatchAttempts: 0,
      },
    });
    await recordHistory(
      tx, bookingId, 'ASSIGNED', 'PENDING', userId, 'EMPLOYEE',
      `Rejected by ${expert.user.name}${reason ? `: ${reason.trim()}` : ''}`
    );
    if (booking.vendor?.userId) {
      await tx.notification.create({
        data: {
          title: `Expert declined #${booking.bookingNumber}`,
          message: `${expert.user.name} declined the job. We are finding another expert automatically; you can also assign one manually.`,
          target: 'SPECIFIC_USER',
          targetUserId: booking.vendor.userId,
        },
      });
    }
    return { released: true };
  }, TX_OPTIONS);

  if (!outcome.released) return outcome;

  void runEffects(effects);
  const rejected = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { bookingSource: true },
  });
  if (
    usesDirectExpertAssignment(rejected?.bookingSource) ||
    (isTestingWorkflowEnabled() && rejected?.bookingSource === 'SALES_MANAGER')
  ) {
    logger.info({ bookingId }, 'Rejection left manager-created booking PENDING without auto-dispatch');
    return outcome;
  }
  // Re-offer right away; if this fails the sweeper retries because dispatchDueAt is already due.
  processBookingDispatch(bookingId).catch((err) =>
    logger.warn({ err, bookingId }, 'Immediate re-dispatch after rejection failed (sweeper will retry)')
  );
  return outcome;
}

// ---------------------------------------------------------------------------
// Expert travel status (ON_THE_WAY / ARRIVED)
// ---------------------------------------------------------------------------

/** Strictly ACCEPTED -> ON_THE_WAY -> ARRIVED, only by the assigned expert. Repeats are idempotent. */
export async function advanceTravelStatus(userId: string, bookingId: string, target: 'ON_THE_WAY' | 'ARRIVED') {
  const now = new Date();
  const effects: Effects = {
    refreshBookingId: bookingId,
    reason: target === 'ON_THE_WAY' ? 'EXPERT_ON_THE_WAY' : 'EXPERT_ARRIVED',
  };

  const result = await prisma.$transaction(async (tx) => {
    const expert = await loadExpertContext(tx, userId);
    await lockBooking(tx, bookingId);
    const booking = await readBookingForDispatch(tx, bookingId);
    if (!booking) throw new DispatchError('NOT_FOUND', 'Order not found', 404);
    if (booking.employeeId !== expert.id) {
      throw new DispatchError('NOT_ASSIGNED_TO_YOU', 'This booking is not assigned to you.', 403);
    }
    if (booking.status === target) return { changed: false };
    if (!isValidExpertTravelTransition(booking.status, target)) {
      throw new DispatchError(
        'INVALID_TRANSITION',
        `Cannot move booking from ${booking.status} to ${target}`,
        409
      );
    }

    await tx.booking.update({
      where: { id: bookingId },
      data: target === 'ON_THE_WAY' ? { status: target, onTheWayAt: now } : { status: target, arrivedAt: now },
    });
    await recordHistory(
      tx, bookingId, booking.status, target, userId, 'EMPLOYEE',
      target === 'ON_THE_WAY' ? `${expert.user.name} is on the way` : `${expert.user.name} has arrived`
    );
    await tx.notification.create({
      data: {
        title: target === 'ON_THE_WAY' ? `Expert is on the way #${booking.bookingNumber}` : `Expert has arrived #${booking.bookingNumber}`,
        message:
          target === 'ON_THE_WAY'
            ? `${expert.user.name} is heading to your location.`
            : 'Your service professional has arrived. Please be available to start your service.',
        target: 'SPECIFIC_USER',
        targetUserId: booking.customer.userId,
      },
    });
    return { changed: true };
  }, TX_OPTIONS);

  if (!result.changed) return result;
  void runEffects(effects);
  return result;
}

/** Called after a customer/admin cancellation so no stale timer or offer survives. */
export async function releaseDispatchOnCancel(bookingId: string): Promise<void> {
  cancelDispatchTimer(bookingId);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await lockBooking(tx, bookingId);
    await tx.bookingAssignment.updateMany({
      where: { bookingId, status: 'OFFERED' },
      data: { status: 'CANCELLED', respondedAt: now },
    });
    await tx.booking.updateMany({
      where: { id: bookingId, status: { in: ['CANCELLED', 'DECLINED', 'COMPLETED'] } },
      data: {
        dispatchDueAt: null,
        locationSharingEnabled: false,
        professionalLastLatitude: null,
        professionalLastLongitude: null,
        professionalLastLocationAt: null,
      },
    });
  }, TX_OPTIONS);
}

