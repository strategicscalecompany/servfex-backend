import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendError, sendSuccess } from '../utils/response';
import { logAuditEvent } from '../utils/audit';
import { BookingStatus, Prisma, UserRole } from '@prisma/client';
import { emitBookingEvent, emitBookingRefresh } from '../utils/realtime';

export const listBookingsQuerySchema = z.object({
  query: z.object({
    page: z.string().optional().default('1').transform((v) => Math.max(1, parseInt(v, 10))),
    limit: z.string().optional().default('20').transform((v) => Math.min(100, Math.max(1, parseInt(v, 10)))),
    status: z.enum([
      'PENDING',
      'ACCEPTED',
      'ASSIGNED',
      'ON_THE_WAY',
      'ARRIVED',
      'IN_PROGRESS',
      'AWAITING_CUSTOMER_CONFIRMATION',
      'AWAITING_PAYMENT',
      'COMPLETED',
      'CANCELLED',
      'DECLINED',
      'DISPUTED',
    ]).optional(),
    customerId: z.string().optional(),
    vendorId: z.string().optional(),
    employeeId: z.string().optional(),
    scheduledDate: z.string().optional(),
    search: z.string().optional(),
    sortBy: z.enum(['createdAt', 'scheduledDate', 'totalAmount']).optional().default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
  }),
});

export const assignVendorSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    vendorId: z.string().uuid(),
    reason: z.string().optional(),
  }),
});

export const assignEmployeeSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    employeeId: z.string().uuid(),
    reason: z.string().optional(),
  }),
});

export const changeStatusSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    newStatus: z.enum([
      'PENDING',
      'ACCEPTED',
      'ASSIGNED',
      'ON_THE_WAY',
      'ARRIVED',
      'IN_PROGRESS',
      'AWAITING_CUSTOMER_CONFIRMATION',
      'AWAITING_PAYMENT',
      'COMPLETED',
      'CANCELLED',
      'DECLINED',
      'DISPUTED',
    ]),
    reason: z.string().min(3, 'A reason is required for status changes'),
  }),
});

export const rescheduleBookingSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
    scheduledTimeSlot: z.string().min(3),
    reason: z.string().min(3, 'A reason is required for rescheduling'),
  }),
});

export const overridePriceSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    basePrice: z.number().min(0).optional(),
    taxes: z.number().min(0).optional(),
    discountAmount: z.number().min(0).optional(),
    extraCharges: z.number().min(0).optional(),
    reason: z.string().min(3, 'A reason is required for price override'),
  }),
});

export const cancelBookingSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    reason: z.string().min(3, 'A cancellation reason is required'),
  }),
});

// Allowed Standard Forward State Transitions
const VALID_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  PENDING: ['ACCEPTED', 'ASSIGNED', 'CANCELLED', 'DECLINED'],
  ACCEPTED: ['ASSIGNED', 'ON_THE_WAY', 'CANCELLED'],
  ASSIGNED: ['ACCEPTED', 'ON_THE_WAY', 'CANCELLED'],
  ON_THE_WAY: ['ARRIVED', 'CANCELLED'],
  ARRIVED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['AWAITING_CUSTOMER_CONFIRMATION', 'COMPLETED', 'DISPUTED'],
  AWAITING_CUSTOMER_CONFIRMATION: ['AWAITING_PAYMENT', 'COMPLETED', 'DISPUTED'],
  AWAITING_PAYMENT: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  DECLINED: [],
  DISPUTED: ['COMPLETED', 'CANCELLED'],
};

export const getBookings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { status, customerId, vendorId, employeeId, scheduledDate, search } = req.query as any;
    const pageNum = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '15'), 10) || 15));
    const skip = (pageNum - 1) * limitNum;

    const sortField = ['createdAt', 'scheduledDate', 'totalAmount'].includes(String(req.query.sortBy))
      ? String(req.query.sortBy)
      : 'createdAt';
    const sortDirection: 'asc' | 'desc' = req.query.sortOrder === 'asc' ? 'asc' : 'desc';

    const where: any = {};

    if (status && status !== 'ALL') {
      where.status = status;
    }
    if (customerId) {
      where.customerId = customerId;
    }
    if (vendorId) {
      where.vendorId = vendorId;
    }
    if (employeeId) {
      where.employeeId = employeeId;
    }
    if (scheduledDate) {
      where.scheduledDate = scheduledDate;
    }

    if (search) {
      where.OR = [
        { bookingNumber: { contains: search, mode: 'insensitive' } },
        { customer: { user: { name: { contains: search, mode: 'insensitive' } } } },
        { service: { name: { contains: search, mode: 'insensitive' } } },
        { vendor: { companyName: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [total, bookings] = await Promise.all([
      prisma.booking.count({ where }),
      prisma.booking.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { [sortField]: sortDirection },
        include: {
          customer: {
            include: {
              user: { select: { name: true, phone: true, email: true } },
            },
          },
          service: { select: { id: true, name: true, iconName: true } },
          package: { select: { id: true, title: true } },
          vendor: { select: { id: true, companyName: true } },
          employee: {
            include: {
              user: { select: { name: true, phone: true } },
            },
          },
          address: true,
        },
      }),
    ]);

    sendSuccess(res, bookings, 200, {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (error) {
    next(error);
  }
};

export const getBookingById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;

    const booking = await prisma.booking.findUnique({
      where: { id },
      include: {
        customer: {
          include: {
            user: { select: { id: true, name: true, phone: true, email: true, profilePhotoUrl: true } },
          },
        },
        service: true,
        package: true,
        vendor: {
          include: {
            user: { select: { name: true, phone: true } },
          },
        },
        employee: {
          include: {
            user: { select: { name: true, phone: true, profilePhotoUrl: true } },
          },
        },
        address: true,
        statusHistory: {
          orderBy: { createdAt: 'desc' },
        },
        payments: {
          orderBy: { createdAt: 'desc' },
        },
        refunds: {
          orderBy: { createdAt: 'desc' },
        },
        review: true,
      },
    });

    if (!booking) {
      sendError(res, 'BOOKING_NOT_FOUND', 'Booking not found', 404);
      return;
    }

    sendSuccess(res, booking);
  } catch (error) {
    next(error);
  }
};

/**
 * Notifies the assigned vendor (DB notification) and pushes a realtime update to the
 * admin desk, the vendor owner and the customer. Call after the transaction commits.
 */
async function notifyVendorAssignment(
  booking: { id: string; bookingNumber: string; status: string; vendorId: string | null; customerId: string },
  vendorId: string
): Promise<void> {
  const [vendor, full] = await Promise.all([
    prisma.vendorProfile.findUnique({ where: { id: vendorId }, select: { userId: true } }),
    prisma.booking.findUnique({
      where: { id: booking.id },
      select: {
        scheduledDate: true,
        scheduledTimeSlot: true,
        service: { select: { name: true } },
        customer: { select: { userId: true } },
      },
    }),
  ]);
  if (vendor) {
    await prisma.notification.create({
      data: {
        title: `New job assigned #${booking.bookingNumber}`,
        message: `${full?.service.name ?? 'Service'} on ${full?.scheduledDate ?? ''} (${full?.scheduledTimeSlot ?? ''}) has been assigned to you.`,
        target: 'SPECIFIC_USER',
        targetUserId: vendor.userId,
      },
    });
  }
  emitBookingEvent(
    'booking:updated',
    { bookingId: booking.id, bookingNumber: booking.bookingNumber, status: booking.status, vendorId },
    [vendor?.userId, full?.customer.userId]
  );
}

export const assignVendor = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { vendorId, reason } = req.body;

    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) {
      sendError(res, 'BOOKING_NOT_FOUND', 'Booking not found', 404);
      return;
    }

    const vendor = await prisma.vendorProfile.findUnique({ where: { id: vendorId } });
    if (!vendor) {
      sendError(res, 'VENDOR_NOT_FOUND', 'Vendor not found', 404);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const shouldAdvanceToAccepted = booking.status === 'PENDING' || booking.status === 'DECLINED';
      const b = await tx.booking.update({
        where: { id },
        data: {
          vendorId,
          // If status was PENDING or DECLINED, auto advance to ACCEPTED
          status: shouldAdvanceToAccepted ? 'ACCEPTED' : booking.status,
        },
      });

      if (shouldAdvanceToAccepted) {
        await tx.bookingStatusHistory.create({
          data: {
            bookingId: id,
            oldStatus: booking.status,
            newStatus: 'ACCEPTED',
            changedBy: req.user!.userId,
            changedByRole: 'SUPER_ADMIN',
            reason: reason || 'Vendor assigned by Super Admin',
          },
        });
      }

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'BOOKING_VENDOR_ASSIGNED',
        entityType: 'Booking',
        entityId: id,
        before: { vendorId: booking.vendorId },
        after: { vendorId },
        reason: reason || 'Assigned by Super Admin',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return b;
    });

    await notifyVendorAssignment(updated, vendorId);

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
};

function calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

export const getEligibleVendors = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const booking = await prisma.booking.findUnique({
      where: { id },
      include: {
        service: { include: { category: true } },
        address: true,
      },
    });

    if (!booking) {
      sendError(res, 'BOOKING_NOT_FOUND', 'Booking not found', 404);
      return;
    }

    // Business timezone start of today
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

    const vendors = await prisma.vendorProfile.findMany({
      where: {
        isActive: true,
        kycStatus: 'APPROVED',
      },
      include: {
        user: { select: { name: true, phone: true, email: true, status: true } },
        employees: {
          include: { user: { select: { name: true, phone: true, status: true } } },
        },
        vendorServices: {
          include: { service: { select: { id: true, name: true, categoryId: true } } },
        },
        bookings: {
          where: {
            status: { in: ['PENDING', 'ACCEPTED', 'ASSIGNED', 'ON_THE_WAY', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED'] },
          },
          select: { id: true, status: true, updatedAt: true, scheduledDate: true },
        },
      },
    });

    const evaluatedVendors = vendors.map((vendor) => {
      const supportsExactService = vendor.vendorServices.some((vs) => vs.serviceId === booking.serviceId && vs.isActive);
      const supportsCategory = vendor.vendorServices.some(
        (vs) => vs.service.categoryId === booking.service.categoryId && vs.isActive
      );
      const isServiceCompatible = supportsExactService || supportsCategory || vendor.vendorServices.length === 0;

      const completedToday = vendor.bookings.filter(
        (b) => b.status === 'COMPLETED' && new Date(b.updatedAt) >= startOfToday
      ).length;

      const activeJobs = vendor.bookings.filter((b) =>
        ['ACCEPTED', 'ASSIGNED', 'ON_THE_WAY', 'ARRIVED', 'IN_PROGRESS'].includes(b.status)
      ).length;

      const pendingJobs = vendor.bookings.filter((b) => b.status === 'PENDING').length;

      const totalEmployees = vendor.employees.length;
      const availableEmployees = vendor.employees.filter((e) => e.isAvailable).length;

      let distanceKm: number | null = null;
      if (
        booking.address?.latitude != null &&
        booking.address?.longitude != null &&
        vendor.latitude != null &&
        vendor.longitude != null
      ) {
        distanceKm = calculateDistanceKm(
          booking.address.latitude,
          booking.address.longitude,
          vendor.latitude,
          vendor.longitude
        );
      }

      let score = 100;
      const scoringBreakdown: string[] = [];

      if (!isServiceCompatible) {
        score -= 80;
        scoringBreakdown.push('Does not list required service or category (-80)');
      } else if (supportsExactService) {
        score += 20;
        scoringBreakdown.push('Direct catalog service match (+20)');
      }

      const ratingBoost = Math.round((vendor.rating || 5.0) * 4);
      score += ratingBoost;
      scoringBreakdown.push(`Quality rating ${vendor.rating || 5.0} (+${ratingBoost})`);

      if (availableEmployees > 0) {
        score += availableEmployees * 10;
        scoringBreakdown.push(`${availableEmployees} available technicians (+${availableEmployees * 10})`);
      } else {
        score -= 25;
        scoringBreakdown.push('No available technicians reported (-25)');
      }

      if (distanceKm != null) {
        if (distanceKm <= 5) {
          score += 25;
          scoringBreakdown.push(`Immediate proximity ${distanceKm}km (+25)`);
        } else if (distanceKm <= 15) {
          score += 15;
          scoringBreakdown.push(`Close service area ${distanceKm}km (+15)`);
        } else if (distanceKm <= 35) {
          score += 5;
          scoringBreakdown.push(`Regional range ${distanceKm}km (+5)`);
        } else {
          score -= 30;
          scoringBreakdown.push(`Far service distance ${distanceKm}km (-30)`);
        }
      }

      if (activeJobs > 0) {
        const loadPenalty = activeJobs * 12;
        score -= loadPenalty;
        scoringBreakdown.push(`${activeJobs} currently active jobs (-${loadPenalty})`);
      }

      if (completedToday > 0) {
        const fairnessPenalty = completedToday * 6;
        score -= fairnessPenalty;
        scoringBreakdown.push(`${completedToday} jobs completed today (-${fairnessPenalty})`);
      }

      return {
        vendorId: vendor.id,
        companyName: vendor.companyName,
        contactName: vendor.user.name,
        contactPhone: vendor.user.phone,
        contactEmail: vendor.user.email,
        location: vendor.location,
        rating: vendor.rating,
        reviewCount: vendor.reviewCount,
        commissionRate: vendor.commissionRate,
        isServiceCompatible,
        totalEmployees,
        availableEmployees,
        completedToday,
        activeJobs,
        pendingJobs,
        distanceKm,
        score: Math.max(0, score),
        scoringBreakdown,
      };
    });

    evaluatedVendors.sort((a, b) => b.score - a.score);

    sendSuccess(res, {
      bookingId: id,
      requestedService: booking.service.name,
      customerAddress: booking.address,
      eligibleVendors: evaluatedVendors,
    });
  } catch (error) {
    next(error);
  }
};

export const autoAssignVendor = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { reason: customReason } = req.body || {};

    const booking = await prisma.booking.findUnique({
      where: { id },
      include: {
        service: { include: { category: true } },
        address: true,
      },
    });

    if (!booking) {
      sendError(res, 'BOOKING_NOT_FOUND', 'Booking not found', 404);
      return;
    }

    if (booking.status !== 'PENDING' && !['DECLINED', 'PENDING'].includes(booking.status)) {
      sendError(res, 'INVALID_ACTION', `Booking is in ${booking.status} state and cannot be auto-assigned`, 400);
      return;
    }

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

    const vendors = await prisma.vendorProfile.findMany({
      where: {
        isActive: true,
        kycStatus: 'APPROVED',
      },
      include: {
        user: { select: { name: true, phone: true } },
        employees: true,
        vendorServices: {
          include: { service: { select: { id: true, categoryId: true } } },
        },
        bookings: {
          where: {
            status: { in: ['PENDING', 'ACCEPTED', 'ASSIGNED', 'ON_THE_WAY', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED'] },
          },
          select: { id: true, status: true, updatedAt: true },
        },
      },
    });

    if (vendors.length === 0) {
      sendError(res, 'NO_ACTIVE_VENDORS', 'No active approved vendors found on platform', 404);
      return;
    }

    const ranked = vendors
      .map((vendor) => {
        const supportsExactService = vendor.vendorServices.some((vs) => vs.serviceId === booking.serviceId && vs.isActive);
        const supportsCategory = vendor.vendorServices.some(
          (vs) => vs.service.categoryId === booking.service.categoryId && vs.isActive
        );
        const isCompatible = supportsExactService || supportsCategory || vendor.vendorServices.length === 0;

        const completedToday = vendor.bookings.filter(
          (b) => b.status === 'COMPLETED' && new Date(b.updatedAt) >= startOfToday
        ).length;

        const activeJobs = vendor.bookings.filter((b) =>
          ['ACCEPTED', 'ASSIGNED', 'ON_THE_WAY', 'ARRIVED', 'IN_PROGRESS'].includes(b.status)
        ).length;

        const availableEmployees = vendor.employees.filter((e) => e.isAvailable).length;

        let distanceKm: number | null = null;
        if (
          booking.address?.latitude != null &&
          booking.address?.longitude != null &&
          vendor.latitude != null &&
          vendor.longitude != null
        ) {
          distanceKm = calculateDistanceKm(
            booking.address.latitude,
            booking.address.longitude,
            vendor.latitude,
            vendor.longitude
          );
        }

        let score = 100;
        if (!isCompatible) score -= 80;
        else if (supportsExactService) score += 20;

        score += Math.round((vendor.rating || 5.0) * 4);
        score += availableEmployees * 10;
        if (distanceKm != null) {
          if (distanceKm <= 5) score += 25;
          else if (distanceKm <= 15) score += 15;
          else if (distanceKm > 35) score -= 30;
        }
        score -= activeJobs * 12;
        score -= completedToday * 6;

        return {
          vendor,
          score,
          isCompatible,
          activeJobs,
          completedToday,
          distanceKm,
        };
      })
      .filter((v) => v.isCompatible)
      .sort((a, b) => b.score - a.score);

    if (ranked.length === 0) {
      sendError(res, 'NO_ELIGIBLE_VENDOR', 'No eligible vendor found for this service area and category', 404);
      return;
    }

    const bestMatch = ranked[0];
    const explanationReason =
      customReason ||
      `Automatic assignment engine selected ${bestMatch.vendor.companyName} (Score: ${bestMatch.score}, Active Jobs: ${bestMatch.activeJobs}, Distance: ${bestMatch.distanceKm != null ? bestMatch.distanceKm + 'km' : 'N/A'})`;

    const updated = await prisma.$transaction(async (tx) => {
      const b = await tx.booking.update({
        where: { id },
        data: {
          vendorId: bestMatch.vendor.id,
          status: 'ACCEPTED',
        },
      });

      await tx.bookingStatusHistory.create({
        data: {
          bookingId: id,
          oldStatus: booking.status,
          newStatus: 'ACCEPTED',
          changedBy: req.user?.userId || 'SYSTEM_AUTO_ASSIGN',
          changedByRole: 'SUPER_ADMIN',
          reason: explanationReason,
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'BOOKING_AUTO_ASSIGNED',
        entityType: 'Booking',
        entityId: id,
        before: { vendorId: booking.vendorId, status: booking.status },
        after: { vendorId: bestMatch.vendor.id, status: 'ACCEPTED' },
        reason: explanationReason,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return b;
    });

    await notifyVendorAssignment(updated, bestMatch.vendor.id);

    sendSuccess(res, {
      booking: updated,
      assignedVendor: {
        id: bestMatch.vendor.id,
        companyName: bestMatch.vendor.companyName,
        score: bestMatch.score,
        reason: explanationReason,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const assignEmployee = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { employeeId, reason } = req.body;

    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) {
      sendError(res, 'BOOKING_NOT_FOUND', 'Booking not found', 404);
      return;
    }

    const employee = await prisma.employeeProfile.findUnique({ where: { id: employeeId } });
    if (!employee) {
      sendError(res, 'EMPLOYEE_NOT_FOUND', 'Employee not found', 404);
      return;
    }

    // SERVER-SIDE CONCURRENCY / DOUBLE-BOOKING CHECK
    const overlappingBooking = await prisma.booking.findFirst({
      where: {
        id: { not: id },
        employeeId,
        scheduledDate: booking.scheduledDate,
        scheduledTimeSlot: booking.scheduledTimeSlot,
        status: { in: ['ASSIGNED', 'ON_THE_WAY', 'ARRIVED', 'IN_PROGRESS'] },
      },
    });

    if (overlappingBooking) {
      sendError(
        res,
        'CONCURRENT_BOOKING_CONFLICT',
        `Technician is already booked for ${booking.scheduledTimeSlot} on ${booking.scheduledDate} (Booking: ${overlappingBooking.bookingNumber})`,
        409
      );
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const b = await tx.booking.update({
        where: { id },
        data: {
          employeeId,
          status: 'ASSIGNED',
        },
      });

      await tx.bookingStatusHistory.create({
        data: {
          bookingId: id,
          oldStatus: booking.status,
          newStatus: 'ASSIGNED',
          changedBy: req.user!.userId,
          changedByRole: 'SUPER_ADMIN',
          reason: reason || 'Employee assigned by Super Admin',
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'BOOKING_EMPLOYEE_ASSIGNED',
        entityType: 'Booking',
        entityId: id,
        before: { employeeId: booking.employeeId, status: booking.status },
        after: { employeeId, status: 'ASSIGNED' },
        reason: reason || 'Assigned by Super Admin',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return b;
    });

    await emitBookingRefresh(id);
    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
};

export const changeBookingStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { newStatus, reason } = req.body;

    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) {
      sendError(res, 'BOOKING_NOT_FOUND', 'Booking not found', 404);
      return;
    }

    if (booking.status === newStatus) {
      sendSuccess(res, booking);
      return;
    }

    // Check if transition is valid or explicit Super Admin override
    const allowedNext = VALID_TRANSITIONS[booking.status] || [];
    const isStandardTransition = allowedNext.includes(newStatus);
    const actionLabel = isStandardTransition
      ? 'BOOKING_STATUS_CHANGED'
      : 'BOOKING_STATUS_SUPER_ADMIN_OVERRIDE';

    const updated = await prisma.$transaction(async (tx) => {
      const b = await tx.booking.update({
        where: { id },
        data: { status: newStatus },
      });

      await tx.bookingStatusHistory.create({
        data: {
          bookingId: id,
          oldStatus: booking.status,
          newStatus,
          changedBy: req.user!.userId,
          changedByRole: 'SUPER_ADMIN',
          reason: isStandardTransition ? reason : `[ADMIN OVERRIDE] ${reason}`,
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: actionLabel,
        entityType: 'Booking',
        entityId: id,
        before: { status: booking.status },
        after: { status: newStatus },
        reason,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return b;
    });

    await emitBookingRefresh(id);
    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
};

export const rescheduleBooking = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { scheduledDate, scheduledTimeSlot, reason } = req.body;

    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) {
      sendError(res, 'BOOKING_NOT_FOUND', 'Booking not found', 404);
      return;
    }

    if (booking.status === 'COMPLETED' || booking.status === 'CANCELLED') {
      sendError(res, 'CANNOT_RESCHEDULE', `Cannot reschedule a ${booking.status} booking`, 400);
      return;
    }

    // Concurrency check if employee is assigned
    if (booking.employeeId) {
      const conflict = await prisma.booking.findFirst({
        where: {
          id: { not: id },
          employeeId: booking.employeeId,
          scheduledDate,
          scheduledTimeSlot,
          status: { in: ['ASSIGNED', 'ON_THE_WAY', 'ARRIVED', 'IN_PROGRESS'] },
        },
      });

      if (conflict) {
        sendError(
          res,
          'CONCURRENT_BOOKING_CONFLICT',
          `The assigned technician has an existing booking in the requested slot (${scheduledDate} ${scheduledTimeSlot})`,
          409
        );
        return;
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const b = await tx.booking.update({
        where: { id },
        data: {
          scheduledDate,
          scheduledTimeSlot,
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'BOOKING_RESCHEDULED',
        entityType: 'Booking',
        entityId: id,
        before: { scheduledDate: booking.scheduledDate, scheduledTimeSlot: booking.scheduledTimeSlot },
        after: { scheduledDate, scheduledTimeSlot },
        reason,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return b;
    });

    await emitBookingRefresh(id);
    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
};

export const overrideBookingPrice = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { basePrice, taxes, discountAmount, extraCharges, reason } = req.body;

    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) {
      sendError(res, 'BOOKING_NOT_FOUND', 'Booking not found', 404);
      return;
    }

    // AUTHORITATIVE SERVER-SIDE FINANCIAL INVARIANT:
    // totalAmount = basePrice + taxes + extraCharges - discountAmount
    const newBase = basePrice !== undefined ? new Prisma.Decimal(basePrice) : booking.basePrice;
    const newTaxes = taxes !== undefined ? new Prisma.Decimal(taxes) : booking.taxes;
    const newDiscount = discountAmount !== undefined ? new Prisma.Decimal(discountAmount) : booking.discountAmount;
    const newExtra = extraCharges !== undefined ? new Prisma.Decimal(extraCharges) : booking.extraCharges;

    const calculatedTotal = newBase.plus(newTaxes).plus(newExtra).minus(newDiscount);

    if (calculatedTotal.isNegative()) {
      sendError(res, 'INVALID_TOTAL_AMOUNT', 'Discount cannot exceed sum of charges', 400);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const b = await tx.booking.update({
        where: { id },
        data: {
          basePrice: newBase,
          taxes: newTaxes,
          discountAmount: newDiscount,
          extraCharges: newExtra,
          totalAmount: calculatedTotal,
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'BOOKING_PRICE_OVERRIDDEN',
        entityType: 'Booking',
        entityId: id,
        before: { totalAmount: Number(booking.totalAmount) },
        after: { totalAmount: Number(calculatedTotal) },
        reason,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return b;
    });

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
};

export const cancelBooking = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { reason } = req.body;

    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) {
      sendError(res, 'BOOKING_NOT_FOUND', 'Booking not found', 404);
      return;
    }

    if (booking.status === 'CANCELLED') {
      sendSuccess(res, booking);
      return;
    }

    if (booking.status === 'COMPLETED') {
      sendError(res, 'INVALID_ACTION', `Cannot cancel a ${booking.status} booking`, 400);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const b = await tx.booking.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancellationReason: reason,
        },
      });

      await tx.bookingStatusHistory.create({
        data: {
          bookingId: id,
          oldStatus: booking.status,
          newStatus: 'CANCELLED',
          changedBy: req.user!.userId,
          changedByRole: 'SUPER_ADMIN',
          reason,
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'BOOKING_CANCELLED',
        entityType: 'Booking',
        entityId: id,
        before: { status: booking.status },
        after: { status: 'CANCELLED', reason },
        reason,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return b;
    });

    void emitBookingRefresh(id);
    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
};
