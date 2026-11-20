import { prisma } from '../config/prisma';
import { logger } from '../config/logger';
import { notifyUsers } from './notify.service';
import {
  CHECK_IN_START_HOUR,
  CHECK_IN_GRACE_MINUTES,
  POST_SHIFT_RETURN_MINUTES,
  ACTIVE_FIELD_JOB_STATUSES,
  computeShiftTiming,
  forceCheckoutAndSuspend,
  maybeStartPostShiftReturnGrace,
} from './execution.service';
import { ymdInBookingTz, atLocalTime } from '../config/scheduling';
import { CrewMemberStatus } from '@prisma/client';

const ATTENDANCE_SWEEP_INTERVAL_MS = 60_000;

let attendanceTimer: NodeJS.Timeout | null = null;
let isSweeping = false;

/**
 * Sweep (self check-in and BOM force check-in are treated the same):
 * - After hub day end 18:00 IST with no active job: 30m return grace (until 18:30).
 * - Miss that grace → force checkout + suspend + BOM warning.
 * - Active field jobs: wait until job ends, then 30m grace, then same punish.
 * - After 09:30 IST: flag multi-pro bookings where an assigned crew member never checked in.
 */
export async function sweepHubAttendance(clock: () => Date = () => new Date()): Promise<number> {
  if (isSweeping) return 0;
  isSweeping = true;
  try {
    const now = clock();

    const checkedIn = await prisma.employeeProfile.findMany({
      where: { hubCheckedInAt: { not: null } },
      select: {
        id: true,
        userId: true,
        hubCheckedInAt: true,
        shiftOverdueNotifiedAt: true,
        postShiftReturnDeadlineAt: true,
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
      take: 200,
      orderBy: { hubCheckedInAt: 'asc' },
    });

    let processed = 0;
    for (const emp of checkedIn) {
      if (!emp.hubCheckedInAt) continue;
      const timing = computeShiftTiming(emp.hubCheckedInAt, now, emp.postShiftReturnDeadlineAt);
      if (!timing.isShiftOverdue) continue;

      const name = emp.user?.name?.trim() || 'Working Professional';
      const bomIds = [
        emp.vendor.userId,
        ...emp.vendor.managers.map((m) => m.userId),
      ].filter(Boolean) as string[];

      try {
        const activeJob = await prisma.booking.findFirst({
          where: {
            OR: [{ employeeId: emp.id }, { helperEmployeeId: emp.id }],
            status: { in: [...ACTIVE_FIELD_JOB_STATUSES] },
          },
          select: { id: true, bookingNumber: true },
        });

        // Still on a field job — notify once, never punish yet.
        if (activeJob) {
          if (!emp.shiftOverdueNotifiedAt) {
            await prisma.employeeProfile.update({
              where: { id: emp.id },
              data: { shiftOverdueNotifiedAt: now },
            });
            await notifyUsers(
              [emp.userId],
              'Shift ended — finish current job',
              `Your hub day (09:00–18:00 IST) ended. Finish booking #${activeJob.bookingNumber}, then return to the hub within ${POST_SHIFT_RETURN_MINUTES} minutes to check out.`,
              { type: 'attendance:shift_overdue_on_job' }
            );
            if (bomIds.length) {
              await notifyUsers(
                bomIds,
                'Professional past shift on active job',
                `${name} is past 18:00 IST but still on #${activeJob.bookingNumber} at ${emp.vendor.companyName}.`,
                { type: 'attendance:shift_overdue_on_job', employeeUserId: emp.userId }
              );
            }
            processed++;
          }
          continue;
        }

        // Idle overdue: ensure 30m return deadline exists.
        // If already past 18:00+30m (e.g. overnight stuck session), punish immediately.
        const alreadyPastReturnWindow = Boolean(
          timing.shiftEndsAt &&
            now.getTime() >=
              timing.shiftEndsAt.getTime() + POST_SHIFT_RETURN_MINUTES * 60 * 1000 &&
            !emp.postShiftReturnDeadlineAt
        );

        let deadline = emp.postShiftReturnDeadlineAt
          ? new Date(emp.postShiftReturnDeadlineAt)
          : null;
        if (!deadline && !alreadyPastReturnWindow) {
          deadline = (await maybeStartPostShiftReturnGrace(emp.id, now)) || null;
          if (!emp.shiftOverdueNotifiedAt) {
            await prisma.employeeProfile.update({
              where: { id: emp.id },
              data: { shiftOverdueNotifiedAt: now },
            });
            await notifyUsers(
              [emp.userId],
              'Return to hub and check out',
              `Your hub day ended at 18:00 IST. You have ${POST_SHIFT_RETURN_MINUTES} minutes to return to the hub and check out.`,
              { type: 'attendance:shift_overdue' }
            );
            if (bomIds.length) {
              await notifyUsers(
                bomIds,
                'Warning · checkout grace started',
                `${name} is past 18:00 IST at ${emp.vendor.companyName}. They have until 18:30 IST to return and check out, or they will be force checked out and suspended.`,
                { type: 'attendance:missing_checkout', employeeUserId: emp.userId }
              );
            }
            processed++;
          }
        }

        const deadlineElapsed = deadline != null && now.getTime() >= deadline.getTime();
        if (alreadyPastReturnWindow || deadlineElapsed) {
          const ok = await forceCheckoutAndSuspend(
            emp.id,
            alreadyPastReturnWindow
              ? `Stayed checked in past 18:00 IST + ${POST_SHIFT_RETURN_MINUTES}m return window.`
              : `Missed ${POST_SHIFT_RETURN_MINUTES}-minute return window after hub day (ends 18:00 IST).`
          );
          if (ok) processed++;
        }
      } catch (err) {
        logger.error({ err, employeeId: emp.id }, 'Attendance sweep failed for employee');
      }
    }

    // Missing crew after check-in window (09:30 IST)
    const ymd = ymdInBookingTz(now);
    const deadline = atLocalTime(ymd, CHECK_IN_START_HOUR, CHECK_IN_GRACE_MINUTES);
    if (now >= deadline) {
      const todaysCrewJobs = await prisma.booking.findMany({
        where: {
          scheduledDate: ymd,
          requiredProfessionals: { gt: 1 },
          status: { in: ['ACCEPTED', 'ASSIGNED'] },
          crewMembers: { some: { status: CrewMemberStatus.ASSIGNED } },
        },
        select: {
          id: true,
          bookingNumber: true,
          vendorId: true,
          vendor: {
            select: {
              userId: true,
              managers: { where: { kind: 'OPERATIONS' }, select: { userId: true } },
            },
          },
          crewMembers: {
            where: { status: CrewMemberStatus.ASSIGNED },
            select: {
              employeeId: true,
              employee: {
                select: {
                  hubCheckedInAt: true,
                  user: { select: { name: true } },
                },
              },
            },
          },
        },
        take: 50,
      });

      for (const job of todaysCrewJobs) {
        const missing = job.crewMembers.filter((c) => !c.employee.hubCheckedInAt);
        if (missing.length === 0) continue;
        const notifyIds = [
          job.vendor?.userId,
          ...(job.vendor?.managers.map((m) => m.userId) || []),
        ].filter(Boolean) as string[];
        if (!notifyIds.length) continue;
        const names = missing.map((m) => m.employee.user.name).join(', ');
        await notifyUsers(
          notifyIds,
          `Crew shortfall #${job.bookingNumber}`,
          `${names} did not check in for a ${job.crewMembers.length}-person job. Pair a free checked-in pro if available, or continue with an off-app helper (not tracked in app).`,
          { type: 'attendance:crew_shortfall', bookingId: job.id }
        );
        processed++;
      }
    }

    return processed;
  } catch (err) {
    logger.error({ err }, 'Error running hub attendance sweeper');
    return 0;
  } finally {
    isSweeping = false;
  }
}

export function startAttendanceWorker() {
  if (attendanceTimer) return;
  attendanceTimer = setInterval(() => {
    void sweepHubAttendance();
  }, ATTENDANCE_SWEEP_INTERVAL_MS);
  logger.info('Hub attendance sweeper started (09:00–18:00 IST + 30m return + force suspend)');
}

export function stopAttendanceWorker() {
  if (attendanceTimer) {
    clearInterval(attendanceTimer);
    attendanceTimer = null;
  }
}
