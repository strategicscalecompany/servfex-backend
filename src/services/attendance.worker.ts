import { prisma } from '../config/prisma';
import { logger } from '../config/logger';
import { notifyUsers } from './notify.service';
import { SHIFT_HOURS, CHECK_IN_START_HOUR, CHECK_IN_GRACE_MINUTES } from './execution.service';
import { CrewMemberStatus } from '@prisma/client';

const ATTENDANCE_SWEEP_INTERVAL_MS = 60_000;

let attendanceTimer: NodeJS.Timeout | null = null;
let isSweeping = false;

/**
 * Sweep:
 * - After check-in + 10h without checkout: notify pro + HOM once.
 * - After 09:30: flag multi-pro bookings where an assigned crew member never checked in.
 */
export async function sweepHubAttendance(clock: () => Date = () => new Date()): Promise<number> {
  if (isSweeping) return 0;
  isSweeping = true;
  try {
    const now = clock();
    const overdueBefore = new Date(now.getTime() - SHIFT_HOURS * 60 * 60 * 1000);

    const checkedIn = await prisma.employeeProfile.findMany({
      where: { hubCheckedInAt: { not: null } },
      select: {
        id: true,
        userId: true,
        hubCheckedInAt: true,
        shiftOverdueNotifiedAt: true,
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
      take: 100,
      orderBy: { hubCheckedInAt: 'asc' },
    });

    let processed = 0;
    for (const emp of checkedIn) {
      if (!emp.hubCheckedInAt) continue;
      const checkInAt = new Date(emp.hubCheckedInAt);
      const name = emp.user?.name?.trim() || 'Working Professional';
      const homIds = [
        emp.vendor.userId,
        ...emp.vendor.managers.map((m) => m.userId),
      ].filter(Boolean);

      try {
        if (!emp.shiftOverdueNotifiedAt && checkInAt <= overdueBefore) {
          await prisma.employeeProfile.update({
            where: { id: emp.id },
            data: { shiftOverdueNotifiedAt: now },
          });

          await notifyUsers(
            [emp.userId],
            'Please check out at hub',
            `Your ${SHIFT_HOURS}h day has ended. Return to the hub and check out after finishing your last job.`,
            { type: 'attendance:shift_overdue' }
          );
          if (homIds.length) {
            await notifyUsers(
              homIds,
              'Professional has not checked out',
              `${name} has not checked out after ${SHIFT_HOURS} hours at ${emp.vendor.companyName}.`,
              { type: 'attendance:missing_checkout', employeeUserId: emp.userId }
            );
          }
          processed++;
        }
      } catch (err) {
        logger.error({ err, employeeId: emp.id }, 'Attendance sweep failed for employee');
      }
    }

    // Missing crew after check-in window (09:30 local)
    const deadline = new Date(now);
    deadline.setHours(CHECK_IN_START_HOUR, CHECK_IN_GRACE_MINUTES, 0, 0);
    if (now >= deadline) {
      const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
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
  logger.info('Hub attendance sweeper started (10h cycle + crew shortfall)');
}

export function stopAttendanceWorker() {
  if (attendanceTimer) {
    clearInterval(attendanceTimer);
    attendanceTimer = null;
  }
}
