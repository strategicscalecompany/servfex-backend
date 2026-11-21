import { BookingStatus, SlotHoldStatus, SlotType } from '@prisma/client';
import { prisma } from '../config/prisma';
import {
  DAY_END_HOUR,
  DAY_START_HOUR,
  EXPRESS_LOOKAHEAD_HOURS,
  SHIFT_HOURS,
  SLOT_GAP_MINUTES,
  SLOT_STEP_MINUTES,
  TRAVEL_BUFFER_MINUTES,
  atLocalTime,
  formatTimeSlotLabel,
  intervalsOverlap,
  parseDurationMinutes,
  resolveBookingDurationMinutes,
  ymdInBookingTz,
} from '../config/scheduling';
import { findEligibleEmployeeIds, resolveRequiredProfessionals } from './tag.eligibility';
import { ACTIVE_JOB_STATUSES } from './dispatch.rules';

export interface SlotCandidate {
  scheduledDate: string;
  startAt: Date;
  endAt: Date;
  label: string;
  slotType: SlotType;
  requiredProfessionals: number;
  availablePros: number;
}

const BUSY_STATUSES: BookingStatus[] = [
  ...ACTIVE_JOB_STATUSES,
  'AWAITING_CUSTOMER_CONFIRMATION',
  'AWAITING_PAYMENT',
];

async function loadBusyIntervals(
  employeeIds: string[],
  dayStart: Date,
  dayEnd: Date,
  excludeBookingId?: string | null
): Promise<Map<string, Array<{ start: Date; end: Date }>>> {
  const map = new Map<string, Array<{ start: Date; end: Date }>>();
  if (employeeIds.length === 0) return map;
  for (const id of employeeIds) map.set(id, []);

  const dayYmd = dayStart.toISOString().slice(0, 10);
  const overlapOr = [
    {
      scheduledStartAt: { lt: dayEnd },
      scheduledEndAt: { gt: dayStart },
    },
    {
      scheduledStartAt: null,
      scheduledDate: dayYmd,
    },
  ] as const;
  const excludeId = excludeBookingId?.trim() || null;

  // Split primary-role vs crew queries — nested crewMembers.some is slow on Mongo.
  const [bookings, crewRows] = await Promise.all([
    prisma.booking.findMany({
      where: {
        status: { in: BUSY_STATUSES },
        ...(excludeId ? { id: { not: excludeId } } : {}),
        OR: [{ employeeId: { in: employeeIds } }, { helperEmployeeId: { in: employeeIds } }],
        AND: [{ OR: [...overlapOr] }],
      },
      select: {
        employeeId: true,
        helperEmployeeId: true,
        scheduledStartAt: true,
        scheduledEndAt: true,
      },
    }),
    prisma.bookingCrewMember.findMany({
      where: {
        employeeId: { in: employeeIds },
        status: 'ASSIGNED',
        booking: {
          status: { in: BUSY_STATUSES },
          ...(excludeId ? { id: { not: excludeId } } : {}),
          OR: [...overlapOr],
        },
      },
      select: {
        employeeId: true,
        booking: {
          select: {
            scheduledStartAt: true,
            scheduledEndAt: true,
          },
        },
      },
    }),
  ]);

  const pushBusy = (
    id: string | null | undefined,
    start: Date | null,
    end: Date | null
  ) => {
    if (!id || !map.has(id)) return;
    map.get(id)!.push({
      start: start || dayStart,
      end: end || dayEnd,
    });
  };

  for (const b of bookings) {
    pushBusy(b.employeeId, b.scheduledStartAt, b.scheduledEndAt);
    pushBusy(b.helperEmployeeId, b.scheduledStartAt, b.scheduledEndAt);
  }
  for (const row of crewRows) {
    pushBusy(row.employeeId, row.booking.scheduledStartAt, row.booking.scheduledEndAt);
  }

  return map;
}

function isFree(
  intervals: Array<{ start: Date; end: Date }>,
  start: Date,
  end: Date
): boolean {
  return !intervals.some((iv) =>
    intervalsOverlap(start, end, iv.start, iv.end, TRAVEL_BUFFER_MINUTES)
  );
}

/**
 * Pro can cover [start,end] when not busy on overlapping bookings.
 * Slot capacity is hub available pros — not gated by hub check-in.
 */
function canCoverSlot(params: {
  intervals: Array<{ start: Date; end: Date }>;
  startAt: Date;
  endAt: Date;
}): boolean {
  return isFree(params.intervals, params.startAt, params.endAt);
}

export async function countFreeEligiblePros(params: {
  vendorId: string;
  categoryId: string;
  subCategoryId?: string | null;
  packageId?: string | null;
  startAt: Date;
  endAt: Date;
  /** Ignored for customer slots — capacity uses available hub pros only. */
  requireCheckedIn?: boolean;
  excludeHoldCapacity?: boolean;
}): Promise<number> {
  const eligibleIds = await findEligibleEmployeeIds({
    vendorId: params.vendorId,
    categoryId: params.categoryId,
    subCategoryId: params.subCategoryId,
    packageId: params.packageId,
    requireCheckedIn: false,
  });
  if (eligibleIds.length === 0) return 0;

  const dateYmd = ymdInBookingTz(params.startAt);
  const windowStart = atLocalTime(dateYmd, DAY_START_HOUR);
  const windowEnd = atLocalTime(dateYmd, DAY_END_HOUR + 3);
  const busy = await loadBusyIntervals(eligibleIds, windowStart, windowEnd);
  let free = 0;
  for (const id of eligibleIds) {
    if (
      canCoverSlot({
        intervals: busy.get(id) || [],
        startAt: params.startAt,
        endAt: params.endAt,
      })
    ) {
      free++;
    }
  }

  // Customer browse/confirm no longer reserves via pre-holds. Hold subtraction is opt-in only.
  if (params.excludeHoldCapacity === false) {
    const holdRows = await prisma.slotHold.findMany({
      where: {
        vendorId: params.vendorId,
        status: SlotHoldStatus.ACTIVE,
        expiresAt: { gt: new Date() },
        scheduledStartAt: { lt: params.endAt },
        scheduledEndAt: { gt: params.startAt },
      },
      select: { requiredProfessionals: true },
    });
    const reserved = holdRows.reduce((s, h) => s + (h.requiredProfessionals || 1), 0);
    free = Math.max(0, free - reserved);
  }

  return free;
}

const SLOT_TAKEN_MESSAGE =
  'Sorry, this slot was booked by someone else a fraction of a second before. Please select another slot as soon as possible before someone else gets it.';

/**
 * Confirm-time capacity: bookings only (no pre-holds).
 * Free pros minus shortfall from overlapping jobs that still need crew.
 */
export async function assertTimedSlotCapacity(params: {
  vendorId: string;
  categoryId: string;
  subCategoryId?: string | null;
  packageId?: string | null;
  startAt: Date;
  endAt: Date;
  required: number;
}): Promise<void> {
  const required = Math.max(1, params.required);
  const free = await countFreeEligiblePros({
    vendorId: params.vendorId,
    categoryId: params.categoryId,
    subCategoryId: params.subCategoryId,
    packageId: params.packageId,
    startAt: params.startAt,
    endAt: params.endAt,
    excludeHoldCapacity: true,
  });

  const overlapping = await prisma.booking.findMany({
    where: {
      vendorId: params.vendorId,
      status: { in: BUSY_STATUSES },
      scheduledStartAt: { lt: params.endAt },
      scheduledEndAt: { gt: params.startAt },
    },
    select: {
      requiredProfessionals: true,
      employeeId: true,
      helperEmployeeId: true,
      crewMembers: {
        where: { status: 'ASSIGNED' },
        select: { id: true },
      },
    },
  });

  let reservedShortfall = 0;
  for (const b of overlapping) {
    const need = Math.max(1, b.requiredProfessionals || 1);
    const assigned = new Set<string>();
    if (b.employeeId) assigned.add(b.employeeId);
    if (b.helperEmployeeId) assigned.add(b.helperEmployeeId);
    // crew rows may duplicate lead/helper — capacity shortfall uses max(need - distinct, 0)
    const assignedCount = Math.max(assigned.size, b.crewMembers.length);
    reservedShortfall += Math.max(0, need - assignedCount);
  }

  if (free - reservedShortfall < required) {
    const err = new Error(SLOT_TAKEN_MESSAGE) as Error & { code: string; httpStatus: number };
    err.code = 'SLOT_TAKEN';
    err.httpStatus = 409;
    throw err;
  }
}

export { SLOT_TAKEN_MESSAGE };

export async function generateAvailableSlots(params: {
  vendorId: string;
  categoryId: string;
  subCategoryId?: string | null;
  packageId?: string | null;
  durationMinutes: number;
  dateYmd: string;
  now?: Date;
  /** When rescheduling, ignore this booking so its current slot does not block capacity. */
  excludeBookingId?: string | null;
}): Promise<SlotCandidate[]> {
  const now = params.now ?? new Date();
  const dayStart = atLocalTime(params.dateYmd, DAY_START_HOUR);
  const dayEnd = atLocalTime(params.dateYmd, DAY_END_HOUR);
  const durationMs = params.durationMinutes * 60 * 1000;

  // Compare against India calendar day — not the EC2/UTC machine clock's local date.
  const isToday = ymdInBookingTz(now) === params.dateYmd;
  // Earliest bookable start: now + lead time (never offer a slot that already started).
  const earliestStartMs = now.getTime() + SLOT_GAP_MINUTES * 60 * 1000;

  // Capacity = hub pros assigned to the catalog (not check-in / not user.status gated).
  // BOM unavailable (isAvailable/acceptingRequests false) drops a pro until restore or check-in.
  const MIN_EXTRA_REMAINING_MS = 45 * 60 * 1000;
  const lateClose = atLocalTime(params.dateYmd, DAY_END_HOUR + 3); // 22:00 IST
  const busyHorizon = isToday
    ? new Date(Math.max(dayEnd.getTime(), now.getTime()) + SHIFT_HOURS * 60 * 60 * 1000)
    : lateClose;

  const [required, eligibleIds] = await Promise.all([
    resolveRequiredProfessionals({
      vendorId: params.vendorId,
      packageId: params.packageId,
    }),
    findEligibleEmployeeIds({
      vendorId: params.vendorId,
      categoryId: params.categoryId,
      subCategoryId: params.subCategoryId,
      packageId: params.packageId,
      requireCheckedIn: false,
    }),
  ]);

  // Capacity from real bookings only — pre-holds no longer hide slots from other customers.
  const [busy, completedEarly] = await Promise.all([
    loadBusyIntervals(eligibleIds, dayStart, busyHorizon, params.excludeBookingId),
    isToday
      ? prisma.booking.findMany({
          where: {
            vendorId: params.vendorId,
            status: { in: ['COMPLETED', 'AWAITING_CUSTOMER_CONFIRMATION', 'AWAITING_PAYMENT'] },
            scheduledDate: params.dateYmd,
            scheduledEndAt: { gt: now },
            customerConfirmedAt: { not: null },
          },
          select: {
            scheduledEndAt: true,
            employeeId: true,
          },
          take: 50,
        })
      : Promise.resolve(
          [] as Array<{ scheduledEndAt: Date | null; employeeId: string | null }>
        ),
  ]);

  // Duration-based packing: next start = previous end + 15m (e.g. 3h → 6:15 then 9:30).
  let loopEndMs = dayEnd.getTime();
  const remainingPastDayEnd = lateClose.getTime() - dayEnd.getTime();
  if (remainingPastDayEnd >= MIN_EXTRA_REMAINING_MS) {
    const lastStart = lateClose.getTime() - durationMs;
    if (lastStart + 1 > loopEndMs) loopEndMs = lastStart + 1;
  }

  const countFreeForWindow = (startAt: Date, endAt: Date): number => {
    let freeCount = 0;
    for (const id of eligibleIds) {
      if (
        canCoverSlot({
          intervals: busy.get(id) || [],
          startAt,
          endAt,
        })
      ) {
        freeCount++;
      }
    }
    return freeCount;
  };

  const slots: SlotCandidate[] = [];
  const stepMs = durationMs + SLOT_GAP_MINUTES * 60 * 1000;
  const alignMs = SLOT_STEP_MINUTES * 60 * 1000;
  let loopStartMs = dayStart.getTime();
  if (isToday) {
    const snapped = Math.ceil(earliestStartMs / alignMs) * alignMs;
    loopStartMs = Math.max(dayStart.getTime(), snapped);
  }
  for (let t = loopStartMs; t < loopEndMs; t += stepMs) {
    const startAt = new Date(t);
    const endAt = new Date(t + durationMs);
    if (isToday && (startAt.getTime() < earliestStartMs || endAt.getTime() <= now.getTime())) {
      continue;
    }
    const freeCount = countFreeForWindow(startAt, endAt);
    if (freeCount >= required) {
      slots.push({
        scheduledDate: params.dateYmd,
        startAt,
        endAt,
        label: formatTimeSlotLabel(startAt, endAt),
        slotType: SlotType.NORMAL,
        requiredProfessionals: required,
        availablePros: freeCount,
      });
    }
  }

  // Express: reuse already-loaded busy/hold state — no per-slot DB round-trips.
  if (isToday && completedEarly.length > 0) {
    const lookaheadEnd = new Date(now.getTime() + EXPRESS_LOOKAHEAD_HOURS * 60 * 60 * 1000);
    for (const job of completedEarly) {
      if (!job.scheduledEndAt || !job.employeeId) continue;
      const freeStart = now;
      const freeEnd = job.scheduledEndAt;
      if (freeEnd.getTime() - freeStart.getTime() < durationMs) continue;
      if (freeStart >= lookaheadEnd) continue;

      const startAt = new Date(
        Math.ceil(freeStart.getTime() / (SLOT_STEP_MINUTES * 60 * 1000)) *
          (SLOT_STEP_MINUTES * 60 * 1000)
      );
      const endAt = new Date(startAt.getTime() + durationMs);
      if (endAt > freeEnd) continue;

      const freeCount = countFreeForWindow(startAt, endAt);
      if (freeCount >= required) {
        slots.push({
          scheduledDate: params.dateYmd,
          startAt,
          endAt,
          label: formatTimeSlotLabel(startAt, endAt),
          slotType: SlotType.EXPRESS,
          requiredProfessionals: required,
          availablePros: freeCount,
        });
      }
    }
  }

  // Deduplicate by start time preferring EXPRESS label when both exist
  const byStart = new Map<number, SlotCandidate>();
  for (const s of slots) {
    const key = s.startAt.getTime();
    const existing = byStart.get(key);
    if (!existing || (s.slotType === SlotType.EXPRESS && existing.slotType !== SlotType.EXPRESS)) {
      byStart.set(key, s);
    }
  }
  return [...byStart.values()].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

export async function listAvailableDates(params: {
  vendorId: string;
  categoryId: string;
  subCategoryId?: string | null;
  packageId?: string | null;
  durationMinutes: number;
  fromDateYmd: string;
  days?: number;
}): Promise<string[]> {
  const days = params.days ?? 7;
  const dates: string[] = [];
  const [y, m, d] = params.fromDateYmd.split('-').map(Number);
  for (let i = 0; i < days; i++) {
    const dt = new Date(y, m - 1, d + i);
    const ymd = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const slots = await generateAvailableSlots({
      vendorId: params.vendorId,
      categoryId: params.categoryId,
      subCategoryId: params.subCategoryId,
      packageId: params.packageId,
      durationMinutes: params.durationMinutes,
      dateYmd: ymd,
    });
    if (slots.length > 0) dates.push(ymd);
  }
  return dates;
}

export { parseDurationMinutes, resolveBookingDurationMinutes };
