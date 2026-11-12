import { AssignmentMethod, CrewMemberRole, CrewMemberStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { TRAVEL_BUFFER_MINUTES, intervalsOverlap } from '../config/scheduling';
import { findEligibleEmployeeIds } from './tag.eligibility';
import { ACTIVE_JOB_STATUSES, haversineKm, isValidCoordinate } from './dispatch.rules';
import { notifyUsers } from './notify.service';

type Tx = Prisma.TransactionClient;

async function employeeBusy(
  tx: Tx,
  employeeId: string,
  startAt: Date,
  endAt: Date,
  excludeBookingId?: string
): Promise<boolean> {
  const rows = await tx.booking.findMany({
    where: {
      id: excludeBookingId ? { not: excludeBookingId } : undefined,
      status: { in: ACTIVE_JOB_STATUSES },
      OR: [
        { employeeId },
        { helperEmployeeId: employeeId },
        { crewMembers: { some: { employeeId, status: CrewMemberStatus.ASSIGNED } } },
      ],
    },
    select: {
      scheduledStartAt: true,
      scheduledEndAt: true,
      scheduledDate: true,
    },
  });
  for (const r of rows) {
    if (r.scheduledStartAt && r.scheduledEndAt) {
      if (intervalsOverlap(startAt, endAt, r.scheduledStartAt, r.scheduledEndAt, TRAVEL_BUFFER_MINUTES)) {
        return true;
      }
    } else if (r.scheduledDate === startAt.toISOString().slice(0, 10)) {
      return true;
    }
  }
  return false;
}

export async function pickCrewForSlot(params: {
  tx?: Tx;
  vendorId: string;
  categoryId: string;
  subCategoryId?: string | null;
  packageId?: string | null;
  startAt: Date;
  endAt: Date;
  required: number;
  serviceLat?: number | null;
  serviceLng?: number | null;
  excludeBookingId?: string;
  preferCheckedIn?: boolean;
}): Promise<string[]> {
  const db = params.tx || prisma;
  const eligible = await findEligibleEmployeeIds({
    vendorId: params.vendorId,
    categoryId: params.categoryId,
    subCategoryId: params.subCategoryId,
    packageId: params.packageId,
    requireCheckedIn: false,
  });

  const profiles = await db.employeeProfile.findMany({
    where: { id: { in: eligible } },
    select: {
      id: true,
      lastAssignedAt: true,
      completedJobs: true,
      hubCheckedInAt: true,
      lastLatitude: true,
      lastLongitude: true,
    },
  });

  const scored: Array<{ id: string; score: number }> = [];
  for (const p of profiles) {
    if (await employeeBusy(db, p.id, params.startAt, params.endAt, params.excludeBookingId)) {
      continue;
    }
    let score = 0;
    if (p.hubCheckedInAt) score += 40;
    else if (params.preferCheckedIn) score -= 10;
    if (
      isValidCoordinate(params.serviceLat, params.serviceLng) &&
      isValidCoordinate(p.lastLatitude, p.lastLongitude)
    ) {
      const dist = haversineKm(
        params.serviceLat as number,
        params.serviceLng as number,
        p.lastLatitude as number,
        p.lastLongitude as number
      );
      score += Math.max(0, 30 - dist);
    }
    const last = p.lastAssignedAt ? p.lastAssignedAt.getTime() : 0;
    score += Math.min(20, (Date.now() - last) / (1000 * 60 * 60)); // prefer less recently assigned
    score -= Math.min(10, p.completedJobs / 50);
    scored.push({ id: p.id, score });
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, params.required).map((s) => s.id);
}

export async function assignCrewToBooking(params: {
  bookingId: string;
  employeeIds: string[];
  assignedBy: string;
  method?: AssignmentMethod;
}) {
  if (params.employeeIds.length === 0) return null;

  const [leadId, ...rest] = params.employeeIds;
  const now = new Date();

  const booking = await prisma.$transaction(async (tx) => {
    const updated = await tx.booking.update({
      where: { id: params.bookingId },
      data: {
        employeeId: leadId,
        status: 'ASSIGNED',
        assignmentMethod: params.method || AssignmentMethod.AUTO,
        assignedAt: now,
        helperEmployeeId: rest[0] || null,
        helperTaggedAt: rest[0] ? now : null,
      },
      include: {
        service: { select: { name: true } },
        employee: { include: { user: { select: { id: true, name: true } } } },
        vendor: { select: { userId: true } },
      },
    });

    await tx.bookingCrewMember.deleteMany({ where: { bookingId: params.bookingId } });
    await tx.bookingCrewMember.createMany({
      data: params.employeeIds.map((employeeId, idx) => ({
        bookingId: params.bookingId,
        employeeId,
        role: idx === 0 ? CrewMemberRole.LEAD : CrewMemberRole.MEMBER,
        status: CrewMemberStatus.ASSIGNED,
      })),
    });

    for (const employeeId of params.employeeIds) {
      await tx.bookingAssignment.create({
        data: {
          bookingId: params.bookingId,
          employeeId,
          method: params.method || AssignmentMethod.AUTO,
          status: 'OFFERED',
          assignedBy: params.assignedBy,
          reason: 'Timed slot auto-assign',
          offeredAt: now,
        },
      });
      await tx.employeeProfile.update({
        where: { id: employeeId },
        data: { lastAssignedAt: now },
      });
    }

    await tx.bookingStatusHistory.create({
      data: {
        bookingId: params.bookingId,
        oldStatus: 'ACCEPTED',
        newStatus: 'ASSIGNED',
        changedBy: params.assignedBy,
        changedByRole: 'SUPER_ADMIN',
        reason: `Auto-assigned ${params.employeeIds.length} professional(s) for timed slot`,
      },
    });

    return updated;
  });

  const pros = await prisma.employeeProfile.findMany({
    where: { id: { in: params.employeeIds } },
    select: { userId: true },
  });
  void notifyUsers(
    pros.map((p) => p.userId),
    `New timed job #${booking.bookingNumber}`,
    `${booking.service.name} assigned for ${booking.scheduledDate} (${booking.scheduledTimeSlot}).`,
    { bookingId: booking.id, type: 'booking:assignment' }
  );

  return booking;
}

/** Mark absent + optional in-app substitute when free. Offline pair is ops-only (no fetch). */
export async function markCrewAbsentAndMaybeSubstitute(params: {
  bookingId: string;
  absentEmployeeId: string;
  actorUserId: string;
  substituteEmployeeId?: string | null;
}) {
  const booking = await prisma.booking.findUnique({
    where: { id: params.bookingId },
    include: {
      service: { select: { categoryId: true, subCategoryId: true, name: true } },
      crewMembers: true,
    },
  });
  if (!booking?.vendorId || !booking.scheduledStartAt || !booking.scheduledEndAt) {
    throw new Error('Booking not found or missing timed window');
  }

  const now = new Date();
  await prisma.bookingCrewMember.updateMany({
    where: { bookingId: params.bookingId, employeeId: params.absentEmployeeId },
    data: { status: CrewMemberStatus.ABSENT, absentAt: now },
  });

  if (params.substituteEmployeeId) {
    // Only allow if free + eligible
    const busy = await employeeBusy(
      prisma,
      params.substituteEmployeeId,
      booking.scheduledStartAt,
      booking.scheduledEndAt,
      booking.id
    );
    if (busy) {
      throw new Error('Substitute professional is not free for this interval');
    }
    const eligible = await findEligibleEmployeeIds({
      vendorId: booking.vendorId,
      categoryId: booking.service.categoryId,
      subCategoryId: booking.service.subCategoryId,
      packageId: booking.packageId,
      requireCheckedIn: true,
    });
    if (!eligible.includes(params.substituteEmployeeId)) {
      throw new Error('Substitute is not catalog-eligible or not checked in');
    }

    await prisma.bookingCrewMember.create({
      data: {
        bookingId: params.bookingId,
        employeeId: params.substituteEmployeeId,
        role: CrewMemberRole.MEMBER,
        status: CrewMemberStatus.ASSIGNED,
        replacedEmployeeId: params.absentEmployeeId,
        substitutedBy: params.actorUserId,
        substitutedAt: now,
        note: 'In-app silent substitute',
      },
    });

    if (booking.employeeId === params.absentEmployeeId) {
      await prisma.booking.update({
        where: { id: booking.id },
        data: { employeeId: params.substituteEmployeeId },
      });
    } else if (booking.helperEmployeeId === params.absentEmployeeId) {
      await prisma.booking.update({
        where: { id: booking.id },
        data: { helperEmployeeId: params.substituteEmployeeId, helperTaggedAt: now },
      });
    }

    const sub = await prisma.employeeProfile.findUnique({
      where: { id: params.substituteEmployeeId },
      select: { userId: true },
    });
    if (sub) {
      void notifyUsers(
        [sub.userId],
        `Crew substitute #${booking.bookingNumber}`,
        `You were added to ${booking.service.name} (${booking.scheduledTimeSlot}).`,
        { bookingId: booking.id, type: 'booking:assignment' }
      );
    }
    return { mode: 'IN_APP_SUBSTITUTE' as const };
  }

  // Offline pair: do not fetch or create anyone — booking keeps checked-in lead only.
  if (booking.employeeId === params.absentEmployeeId) {
    const remaining = booking.crewMembers.find(
      (c) => c.employeeId !== params.absentEmployeeId && c.status === CrewMemberStatus.ASSIGNED
    );
    if (remaining) {
      await prisma.booking.update({
        where: { id: booking.id },
        data: { employeeId: remaining.employeeId, helperEmployeeId: null },
      });
    }
  } else if (booking.helperEmployeeId === params.absentEmployeeId) {
    await prisma.booking.update({
      where: { id: booking.id },
      data: { helperEmployeeId: null, helperTaggedAt: null },
    });
  }

  return { mode: 'OFFLINE_PAIR' as const };
}

export async function listFreeCheckedInSubstitutes(params: {
  bookingId: string;
}): Promise<Array<{ id: string; name: string; userId: string }>> {
  const booking = await prisma.booking.findUnique({
    where: { id: params.bookingId },
    include: {
      service: { select: { categoryId: true, subCategoryId: true } },
      crewMembers: true,
    },
  });
  if (!booking?.vendorId || !booking.scheduledStartAt || !booking.scheduledEndAt) return [];

  const eligible = await findEligibleEmployeeIds({
    vendorId: booking.vendorId,
    categoryId: booking.service.categoryId,
    subCategoryId: booking.service.subCategoryId,
    packageId: booking.packageId,
    requireCheckedIn: true,
  });
  const crewIds = new Set(booking.crewMembers.map((c) => c.employeeId));
  const out: Array<{ id: string; name: string; userId: string }> = [];
  for (const id of eligible) {
    if (crewIds.has(id)) continue;
    if (await employeeBusy(prisma, id, booking.scheduledStartAt, booking.scheduledEndAt, booking.id)) {
      continue;
    }
    const emp = await prisma.employeeProfile.findUnique({
      where: { id },
      select: { id: true, userId: true, user: { select: { name: true } } },
    });
    if (emp) out.push({ id: emp.id, name: emp.user.name, userId: emp.userId });
  }
  return out;
}
