import { ymdInBookingTz, atLocalTime, DAY_START_HOUR, DAY_END_HOUR } from '../config/scheduling';

const PRE_START_STATUSES = new Set(['PENDING', 'ACCEPTED', 'ASSIGNED']);
/** Field statuses that count as "still working" for overrun SLA. */
export const OPEN_FIELD_JOB_STATUSES = [
  'ON_THE_WAY',
  'ARRIVED',
  'IN_PROGRESS',
  'AWAITING_CUSTOMER_CONFIRMATION',
  'AWAITING_PAYMENT',
] as const;

/** Max minutes past scheduled end before the job must be completed (no longer shown as Ongoing). */
export const JOB_OVERRUN_GRACE_MINUTES = 30;

/**
 * Parse leading wall-clock from labels like "2:00 PM - 3:00 PM" / "10:00 AM - 12:00 PM".
 */
export function parseSlotStartAt(dateYmd: string, slotLabel: string | null | undefined): Date | null {
  if (!slotLabel) return null;
  const m = slotLabel.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  return wallClockToDate(dateYmd, m[1], m[2], m[3]);
}

/** Parse trailing end wall-clock from "9:45 PM - 10:45 PM". */
export function parseSlotEndAt(dateYmd: string, slotLabel: string | null | undefined): Date | null {
  if (!slotLabel) return null;
  const matches = [...slotLabel.matchAll(/(\d{1,2}):(\d{2})\s*(AM|PM)/gi)];
  if (matches.length < 2) return null;
  const m = matches[matches.length - 1];
  return wallClockToDate(dateYmd, m[1], m[2], m[3]);
}

function wallClockToDate(
  dateYmd: string,
  hourStr: string,
  minuteStr: string,
  ampmRaw: string
): Date | null {
  let hour = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);
  const ampm = ampmRaw.toUpperCase();
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return atLocalTime(dateYmd, hour, minute);
}

/** Authoritative start instant for SLA checks. */
export function resolveBookingScheduledStart(booking: {
  scheduledDate: string;
  scheduledTimeSlot?: string | null;
  scheduledStartAt?: Date | null;
}): Date {
  if (booking.scheduledStartAt && !Number.isNaN(booking.scheduledStartAt.getTime())) {
    return booking.scheduledStartAt;
  }
  const fromLabel = parseSlotStartAt(booking.scheduledDate, booking.scheduledTimeSlot);
  if (fromLabel) return fromLabel;
  return atLocalTime(booking.scheduledDate, DAY_START_HOUR, 0);
}

/** Authoritative end instant for overrun / grace checks. */
export function resolveBookingScheduledEnd(booking: {
  scheduledDate: string;
  scheduledTimeSlot?: string | null;
  scheduledStartAt?: Date | null;
  scheduledEndAt?: Date | null;
}): Date {
  if (booking.scheduledEndAt && !Number.isNaN(booking.scheduledEndAt.getTime())) {
    return booking.scheduledEndAt;
  }
  const fromLabel = parseSlotEndAt(booking.scheduledDate, booking.scheduledTimeSlot);
  if (fromLabel) return fromLabel;
  const start = resolveBookingScheduledStart(booking);
  // Fallback: 60 minutes after start, capped at day end.
  const guessed = new Date(start.getTime() + 60 * 60 * 1000);
  const dayEnd = atLocalTime(booking.scheduledDate, DAY_END_HOUR, 0);
  return guessed.getTime() <= dayEnd.getTime() ? guessed : dayEnd;
}

export function jobGraceDeadline(booking: {
  scheduledDate: string;
  scheduledTimeSlot?: string | null;
  scheduledStartAt?: Date | null;
  scheduledEndAt?: Date | null;
}): Date {
  const end = resolveBookingScheduledEnd(booking);
  return new Date(end.getTime() + JOB_OVERRUN_GRACE_MINUTES * 60 * 1000);
}

/** True when now is past scheduled end + 30m grace (job must complete; not "Ongoing"). */
export function isJobPastGrace(
  booking: {
    scheduledDate: string;
    scheduledTimeSlot?: string | null;
    scheduledStartAt?: Date | null;
    scheduledEndAt?: Date | null;
  },
  now: Date = new Date()
): boolean {
  return now.getTime() > jobGraceDeadline(booking).getTime();
}

/** True when the booking's planned calendar day is before today (IST). */
export function isBookingScheduleDayExpired(
  scheduledDate: string,
  now: Date = new Date()
): boolean {
  return scheduledDate < ymdInBookingTz(now);
}

/** Pro may only start travel/work on the scheduled IST day (or a later day after BOM reschedule). */
export function assertBookingDayAllowsStart(
  booking: { scheduledDate: string; bookingNumber?: string | null },
  now: Date = new Date()
): void {
  if (isBookingScheduleDayExpired(booking.scheduledDate, now)) {
    const err = new Error(
      `Booking #${booking.bookingNumber || ''} has passed its scheduled day (${booking.scheduledDate}). Ask the Operations Manager to reschedule before starting.`
    ) as Error & { code: string; statusCode: number };
    err.code = 'SCHEDULE_EXPIRED';
    err.statusCode = 409;
    throw err;
  }
}

export function isPreStartBookingStatus(status: string): boolean {
  return PRE_START_STATUSES.has(status);
}

export function isOpenFieldJobStatus(status: string): boolean {
  return (OPEN_FIELD_JOB_STATUSES as readonly string[]).includes(status);
}
