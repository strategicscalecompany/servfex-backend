import { prisma } from '../config/prisma';
import { logger } from '../config/logger';
import { notifyUsers } from './notify.service';
import { emitBookingRefresh } from '../utils/realtime';
import { ymdInBookingTz } from '../config/scheduling';
import {
  isBookingScheduleDayExpired,
  isJobPastGrace,
  isOpenFieldJobStatus,
  isPreStartBookingStatus,
  JOB_OVERRUN_GRACE_MINUTES,
  OPEN_FIELD_JOB_STATUSES,
  resolveBookingScheduledEnd,
  resolveBookingScheduledStart,
} from './booking-sla.service';

const SLA_SWEEP_INTERVAL_MS = 60_000;
const BATCH = 80;

let slaTimer: NodeJS.Timeout | null = null;
let isSweeping = false;

async function bomUserIdsForVendor(vendorId: string | null | undefined): Promise<string[]> {
  if (!vendorId) return [];
  const vendor = await prisma.vendorProfile.findUnique({
    where: { id: vendorId },
    select: {
      userId: true,
      managers: {
        where: { kind: 'OPERATIONS', user: { status: 'ACTIVE', deletedAt: null } },
        select: { userId: true },
      },
    },
  });
  if (!vendor) return [];
  return [vendor.userId, ...vendor.managers.map((m) => m.userId)].filter(Boolean) as string[];
}

/**
 * 1) Same-day missed start → notify pro + BOM.
 * 2) Calendar day crossed without start → notify; pro start blocked elsewhere.
 * 3) Open field job past scheduled end + 30m grace → ask pro to complete; warn BOM.
 */
export async function sweepBookingSla(clock: () => Date = () => new Date()): Promise<number> {
  if (isSweeping) return 0;
  isSweeping = true;
  let processed = 0;
  try {
    const now = clock();
    const todayYmd = ymdInBookingTz(now);

    processed += await sweepMissedStarts(now, todayYmd);
    processed += await sweepJobOverruns(now);

    return processed;
  } catch (err) {
    logger.error({ err }, 'Error running booking SLA sweeper');
    return processed;
  } finally {
    isSweeping = false;
  }
}

async function sweepMissedStarts(now: Date, todayYmd: string): Promise<number> {
  let processed = 0;
  const candidates = await prisma.booking.findMany({
    where: {
      status: { in: ['PENDING', 'ACCEPTED', 'ASSIGNED'] },
      OR: [{ missedStartNotifiedAt: null }, { scheduleExpiredNotifiedAt: null }],
    },
    select: {
      id: true,
      bookingNumber: true,
      status: true,
      vendorId: true,
      employeeId: true,
      scheduledDate: true,
      scheduledTimeSlot: true,
      scheduledStartAt: true,
      missedStartNotifiedAt: true,
      scheduleExpiredNotifiedAt: true,
      employee: { select: { userId: true, user: { select: { name: true } } } },
    },
    take: BATCH,
    orderBy: { scheduledStartAt: 'asc' },
  });

  for (const booking of candidates) {
    if (!isPreStartBookingStatus(booking.status)) continue;

    const startAt = resolveBookingScheduledStart(booking);
    const dayExpired = isBookingScheduleDayExpired(booking.scheduledDate, now);
    const startMissed = startAt.getTime() <= now.getTime();
    const bomIds = await bomUserIdsForVendor(booking.vendorId);
    const proName = booking.employee?.user?.name?.trim() || 'Professional';
    const proUserId = booking.employee?.userId ?? null;
    const label = `#${booking.bookingNumber || booking.id.slice(-6)}`;
    const slot = `${booking.scheduledDate} · ${booking.scheduledTimeSlot || ''}`.trim();

    if (dayExpired && !booking.scheduleExpiredNotifiedAt) {
      await prisma.booking.update({
        where: { id: booking.id },
        data: {
          scheduleExpiredNotifiedAt: now,
          ...(booking.missedStartNotifiedAt ? {} : { missedStartNotifiedAt: now }),
        },
      });

      if (bomIds.length) {
        await notifyUsers(
          bomIds,
          `Reschedule required ${label}`,
          `${label} was scheduled for ${slot} and was never started. The professional cannot start it now — reschedule to a free slot (auto-assign will run).`,
          {
            type: 'booking:schedule_expired',
            bookingId: booking.id,
            bookingNumber: booking.bookingNumber || '',
          }
        );
      }
      if (proUserId) {
        await notifyUsers(
          [proUserId],
          `Job day passed ${label}`,
          `${label} (${slot}) can no longer be started. Wait for Operations to reschedule.`,
          {
            type: 'booking:schedule_expired',
            bookingId: booking.id,
            bookingNumber: booking.bookingNumber || '',
          }
        );
      }
      void emitBookingRefresh(booking.id, { reason: 'SCHEDULE_EXPIRED' });
      processed++;
      continue;
    }

    if (
      !dayExpired &&
      startMissed &&
      !booking.missedStartNotifiedAt &&
      booking.scheduledDate <= todayYmd
    ) {
      await prisma.booking.update({
        where: { id: booking.id },
        data: { missedStartNotifiedAt: now },
      });

      if (proUserId) {
        await notifyUsers(
          [proUserId],
          `Start overdue ${label}`,
          `${label} was due at ${booking.scheduledTimeSlot || 'its slot'}. Start the job or Operations will reschedule.`,
          {
            type: 'booking:missed_start',
            bookingId: booking.id,
            bookingNumber: booking.bookingNumber || '',
          }
        );
      }
      if (bomIds.length) {
        await notifyUsers(
          bomIds,
          `Missed start ${label}`,
          `${proName} has not started ${label} (${slot}). Reschedule to another professional/time if needed.`,
          {
            type: 'booking:missed_start',
            bookingId: booking.id,
            bookingNumber: booking.bookingNumber || '',
            employeeUserId: proUserId || '',
          }
        );
      }
      void emitBookingRefresh(booking.id, { reason: 'MISSED_START' });
      processed++;
    }
  }
  return processed;
}

async function sweepJobOverruns(now: Date): Promise<number> {
  let processed = 0;
  const candidates = await prisma.booking.findMany({
    where: {
      status: { in: [...OPEN_FIELD_JOB_STATUSES] },
      jobOverrunNotifiedAt: null,
    },
    select: {
      id: true,
      bookingNumber: true,
      status: true,
      vendorId: true,
      scheduledDate: true,
      scheduledTimeSlot: true,
      scheduledStartAt: true,
      scheduledEndAt: true,
      employee: { select: { userId: true, user: { select: { name: true } } } },
    },
    take: BATCH,
    orderBy: { scheduledEndAt: 'asc' },
  });

  for (const booking of candidates) {
    if (!isOpenFieldJobStatus(booking.status)) continue;
    if (!isJobPastGrace(booking, now)) continue;

    const endAt = resolveBookingScheduledEnd(booking);
    await prisma.booking.update({
      where: { id: booking.id },
      data: { jobOverrunNotifiedAt: now },
    });

    const bomIds = await bomUserIdsForVendor(booking.vendorId);
    const proName = booking.employee?.user?.name?.trim() || 'Professional';
    const proUserId = booking.employee?.userId ?? null;
    const label = `#${booking.bookingNumber || booking.id.slice(-6)}`;
    const slot = `${booking.scheduledDate} · ${booking.scheduledTimeSlot || ''}`.trim();
    const endLabel = endAt.toLocaleTimeString('en-IN', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata',
    });

    if (proUserId) {
      await notifyUsers(
        [proUserId],
        `Complete job now ${label}`,
        `${label} ended at ${endLabel} (+${JOB_OVERRUN_GRACE_MINUTES}m grace). Finish and complete it, then move to your next booking.`,
        {
          type: 'booking:job_overrun',
          bookingId: booking.id,
          bookingNumber: booking.bookingNumber || '',
        }
      );
    }
    if (bomIds.length) {
      await notifyUsers(
        bomIds,
        `Job overrun ${label}`,
        `${proName} is still on ${label} (${slot}) more than ${JOB_OVERRUN_GRACE_MINUTES} minutes past the expected end. Taking longer than expected — follow up so they complete and free the next slot.`,
        {
          type: 'booking:job_overrun',
          bookingId: booking.id,
          bookingNumber: booking.bookingNumber || '',
          employeeUserId: proUserId || '',
        }
      );
    }
    void emitBookingRefresh(booking.id, { reason: 'JOB_OVERRUN' });
    processed++;
  }
  return processed;
}

export function startBookingSlaWorker() {
  if (slaTimer) return;
  slaTimer = setInterval(() => {
    void sweepBookingSla();
  }, SLA_SWEEP_INTERVAL_MS);
  logger.info(
    `Booking SLA sweeper started (missed start + day-expired + end+${JOB_OVERRUN_GRACE_MINUTES}m overrun)`
  );
}

export function stopBookingSlaWorker() {
  if (slaTimer) {
    clearInterval(slaTimer);
    slaTimer = null;
  }
}
