import { BookingStatus, SlotHoldStatus, SlotType } from '@prisma/client';
import { prisma } from '../config/prisma';
import {
  DAY_END_HOUR,
  DAY_START_HOUR,
  EXPRESS_LOOKAHEAD_HOURS,
  SLOT_GAP_MINUTES,
  SLOT_STEP_MINUTES,
  TRAVEL_BUFFER_MINUTES,
  atLocalTime,
  formatTimeSlotLabel,
  intervalsOverlap,
  parseDurationMinutes,
  resolveBookingDurationMinutes,
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
  dayEnd: Date
): Promise<Map<string, Array<{ start: Date; end: Date }>>> {
  const map = new Map<string, Array<{ start: Date; end: Date }>>();
  if (employeeIds.length === 0) return map;

  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: BUSY_STATUSES },
      OR: [
        { employeeId: { in: employeeIds } },
        { helperEmployeeId: { in: employeeIds } },
        { crewMembers: { some: { employeeId: { in: employeeIds }, status: 'ASSIGNED' } } },
      ],
      AND: [
        {
          OR: [
            {
              scheduledStartAt: { lt: dayEnd },
              scheduledEndAt: { gt: dayStart },
            },
            {
              scheduledStartAt: null,
              scheduledDate: dayStart.toISOString().slice(0, 10),
            },
          ],
        },
      ],
    },
    select: {
      employeeId: true,
      helperEmployeeId: true,
      scheduledStartAt: true,
      scheduledEndAt: true,
      scheduledDate: true,
      scheduledTimeSlot: true,
      crewMembers: { where: { status: 'ASSIGNED' }, select: { employeeId: true } },
    },
  });

  const holds = await prisma.slotHold.findMany({
    where: {
      status: SlotHoldStatus.ACTIVE,
      expiresAt: { gt: new Date() },
      scheduledStartAt: { lt: dayEnd },
      scheduledEndAt: { gt: dayStart },
    },
    select: {
      scheduledStartAt: true,
      scheduledEndAt: true,
      requiredProfessionals: true,
      vendorId: true,
    },
  });

  for (const id of employeeIds) map.set(id, []);

  for (const b of bookings) {
    let start = b.scheduledStartAt;
    let end = b.scheduledEndAt;
    if (!start || !end) {
      // Legacy string slots: treat as blocking the whole planned day for that date.
      start = dayStart;
      end = dayEnd;
    }
    const ids = new Set<string>();
    if (b.employeeId) ids.add(b.employeeId);
    if (b.helperEmployeeId) ids.add(b.helperEmployeeId);
    for (const c of b.crewMembers) ids.add(c.employeeId);
    for (const id of ids) {
      if (!map.has(id)) continue;
      map.get(id)!.push({ start, end });
    }
  }

  // Active holds reduce pool capacity globally for the vendor interval (not pinned to a pro yet).
  // Tracked separately by callers via countFreePros.
  void holds;

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

export async function countFreeEligiblePros(params: {
  vendorId: string;
  categoryId: string;
  subCategoryId?: string | null;
  packageId?: string | null;
  startAt: Date;
  endAt: Date;
  requireCheckedIn?: boolean;
  excludeHoldCapacity?: boolean;
}): Promise<number> {
  const eligibleIds = await findEligibleEmployeeIds({
    vendorId: params.vendorId,
    categoryId: params.categoryId,
    subCategoryId: params.subCategoryId,
    packageId: params.packageId,
    requireCheckedIn: params.requireCheckedIn,
  });
  if (eligibleIds.length === 0) return 0;

  const dayStart = atLocalTime(
    params.startAt.toISOString().slice(0, 10) === params.startAt.toLocaleDateString('en-CA')
      ? params.startAt.toLocaleDateString('en-CA')
      : `${params.startAt.getFullYear()}-${String(params.startAt.getMonth() + 1).padStart(2, '0')}-${String(params.startAt.getDate()).padStart(2, '0')}`,
    DAY_START_HOUR
  );
  // Use local YMD from startAt
  const y = params.startAt.getFullYear();
  const m = String(params.startAt.getMonth() + 1).padStart(2, '0');
  const d = String(params.startAt.getDate()).padStart(2, '0');
  const dateYmd = `${y}-${m}-${d}`;
  const windowStart = atLocalTime(dateYmd, DAY_START_HOUR);
  const windowEnd = atLocalTime(dateYmd, DAY_END_HOUR);

  const busy = await loadBusyIntervals(eligibleIds, windowStart, windowEnd);
  let free = 0;
  for (const id of eligibleIds) {
    if (isFree(busy.get(id) || [], params.startAt, params.endAt)) free++;
  }

  if (!params.excludeHoldCapacity) {
    const activeHolds = await prisma.slotHold.count({
      where: {
        vendorId: params.vendorId,
        status: SlotHoldStatus.ACTIVE,
        expiresAt: { gt: new Date() },
        scheduledStartAt: { lt: params.endAt },
        scheduledEndAt: { gt: params.startAt },
      },
    });
    // Each hold reserves requiredProfessionals from the free pool (approx).
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
    void activeHolds;
    free = Math.max(0, free - reserved);
  }

  return free;
}

export async function generateAvailableSlots(params: {
  vendorId: string;
  categoryId: string;
  subCategoryId?: string | null;
  packageId?: string | null;
  durationMinutes: number;
  dateYmd: string;
  now?: Date;
}): Promise<SlotCandidate[]> {
  const now = params.now ?? new Date();
  const required = await resolveRequiredProfessionals({
    vendorId: params.vendorId,
    packageId: params.packageId,
  });
  const dayStart = atLocalTime(params.dateYmd, DAY_START_HOUR);
  const dayEnd = atLocalTime(params.dateYmd, DAY_END_HOUR);
  const durationMs = params.durationMinutes * 60 * 1000;

  const isToday =
    now.getFullYear() === dayStart.getFullYear() &&
    now.getMonth() === dayStart.getMonth() &&
    now.getDate() === dayStart.getDate();

  // Capacity for today, tomorrow, and the rest of the week is driven by
  // professionals who are hub-checked-in right now (today's attendance).
  const eligibleIds = await findEligibleEmployeeIds({
    vendorId: params.vendorId,
    categoryId: params.categoryId,
    subCategoryId: params.subCategoryId,
    packageId: params.packageId,
    requireCheckedIn: true,
  });
  // Slots may finish slightly after DAY_END; load busy through the latest possible end.
  const busyHorizon = new Date(dayEnd.getTime() + durationMs);
  const busy = await loadBusyIntervals(eligibleIds, dayStart, busyHorizon);

  const slots: SlotCandidate[] = [];
  // Offer sequential windows of service duration with a fixed gap between starts
  // (e.g. 5h job: 09:00–14:00, then 14:15–19:15). Start must be before DAY_END;
  // end may finish slightly after 19:00.
  const stepMs = durationMs + SLOT_GAP_MINUTES * 60 * 1000;
  for (let t = dayStart.getTime(); t < dayEnd.getTime(); t += stepMs) {
    const startAt = new Date(t);
    const endAt = new Date(t + durationMs);
    if (isToday && startAt.getTime() < now.getTime() + SLOT_GAP_MINUTES * 60 * 1000) continue;

    let freeCount = 0;
    for (const id of eligibleIds) {
      if (isFree(busy.get(id) || [], startAt, endAt)) freeCount++;
    }

    const holdRows = await prisma.slotHold.findMany({
      where: {
        vendorId: params.vendorId,
        status: SlotHoldStatus.ACTIVE,
        expiresAt: { gt: now },
        scheduledStartAt: { lt: endAt },
        scheduledEndAt: { gt: startAt },
      },
      select: { requiredProfessionals: true },
    });
    const reserved = holdRows.reduce((s, h) => s + (h.requiredProfessionals || 1), 0);
    freeCount = Math.max(0, freeCount - reserved);

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

  // Express: early-finished jobs free residual intervals same day within lookahead.
  if (isToday) {
    const lookaheadEnd = new Date(now.getTime() + EXPRESS_LOOKAHEAD_HOURS * 60 * 60 * 1000);
    const completedEarly = await prisma.booking.findMany({
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
        updatedAt: true,
      },
      take: 50,
    });

    for (const job of completedEarly) {
      if (!job.scheduledEndAt || !job.employeeId) continue;
      // Approximate early free window: from now to original end if job already completed.
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

      const freeCount = await countFreeEligiblePros({
        vendorId: params.vendorId,
        categoryId: params.categoryId,
        subCategoryId: params.subCategoryId,
        packageId: params.packageId,
        startAt,
        endAt,
        requireCheckedIn: true,
      });
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
