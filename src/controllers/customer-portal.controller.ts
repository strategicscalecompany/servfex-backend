import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { generateStartOtp, customerStartOtpPayload } from '../utils/start-otp';
import { sendSuccess, sendError } from '../utils/response';
import { emitBookingRefresh } from '../utils/realtime';
import { Prisma, BookingStatus } from '@prisma/client';
import { emitBookingEvent } from '../utils/realtime';
import { env } from '../config/env';
import {
  addSeconds,
  isValidCoordinate,
  resolveWarehouse,
  type WarehouseCandidate,
} from '../services/dispatch.rules';
import { releaseDispatchOnCancel, syncDispatchTimer } from '../services/dispatch.service';
import { scheduleDispatch } from '../services/dispatch.scheduler';
import { asDecimal, toMoney } from '../utils/money';

// -------------------------------------------------------------
// Validation Schemas
// -------------------------------------------------------------
export const registerCustomerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email address').optional(),
  phone: z.string().min(10, 'Phone must be at least 10 digits').optional(),
  profilePhotoUrl: z.string().url().optional(),
});

export const updateCustomerProfileSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().min(10).optional(),
  profilePhotoUrl: z.string().url().optional(),
  emergencyContact: z.string().optional(),
  notes: z.string().optional(),
});

export const addressSchema = z.object({
  label: z.string().default('Home'),
  addressLine1: z.string().min(3, 'Address line 1 is required'),
  addressLine2: z.string().optional(),
  landmark: z.string().optional(),
  city: z.string().min(2, 'City is required'),
  state: z.string().min(2, 'State is required'),
  postalCode: z.string().min(4, 'Postal code is required'),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  isDefault: z.boolean().default(false),
});

export const createBookingSchema = z.object({
  serviceId: z.string().uuid('Invalid service ID'),
  packageId: z
    .string()
    .optional()
    .nullable()
    .transform((val) => {
      if (!val) return null;
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      return uuidRegex.test(val) ? val : null;
    }),
  addressId: z
    .string()
    .optional()
    .nullable()
    .transform((val) => {
      if (!val) return null;
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      return uuidRegex.test(val) ? val : null;
    }),
  scheduledDate: z
    .string()
    .min(1)
    .transform((val) => {
      const trimmed = (val || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return trimmed;
      }
      const today = new Date();
      if (trimmed.toLowerCase().includes('today')) {
        return today.toISOString().split('T')[0];
      }
      if (trimmed.toLowerCase().includes('tomorrow')) {
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        return tomorrow.toISOString().split('T')[0];
      }
      const parsed = new Date(trimmed);
      if (!isNaN(parsed.getTime())) {
        return parsed.toISOString().split('T')[0];
      }
      return today.toISOString().split('T')[0];
    }),
  scheduledTimeSlot: z.string().min(1, 'Scheduled time slot is required'),
  paymentMethod: z.enum(['ONLINE', 'CASH', 'UPI', 'CARD', 'WALLET']).default('ONLINE'),
  notes: z.string().optional(),
  vendorId: z
    .string()
    .optional()
    .nullable()
    .transform((val) => {
      if (!val) return null;
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      return uuidRegex.test(val) ? val : null;
    }),
});

export const cancelBookingSchema = z.object({
  reason: z.string().min(3, 'Cancellation reason must be provided'),
});

export const rescheduleBookingSchema = z.object({
  scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Scheduled date must be YYYY-MM-DD'),
  scheduledTimeSlot: z.string().min(3, 'Scheduled time slot is required'),
});

export const submitReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().optional(),
});

export const reportIssueSchema = z.object({
  reason: z.string().min(5, 'Dispute reason must be at least 5 characters'),
});

// -------------------------------------------------------------
// Customer Auth & Registration
// -------------------------------------------------------------

export const registerCustomer = async (req: Request, res: Response): Promise<void> => {
  try {
    const firebaseUser = req.firebaseUser;
    if (!firebaseUser) {
      sendError(res, 'UNAUTHORIZED', 'Verified Firebase authentication token required', 401);
      return;
    }

    const { name, email, phone, profilePhotoUrl } = req.body;
    const finalEmail = (email || firebaseUser.email || `customer_${firebaseUser.uid.slice(0, 8)}@servfex.user`).toLowerCase().trim();
    const finalPhone = phone || firebaseUser.phone_number || null;
    const finalName = name || firebaseUser.name || 'ServFex Customer';

    // Check if user already exists
    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { firebaseUid: firebaseUser.uid },
          { email: finalEmail },
          ...(finalPhone ? [{ phone: finalPhone }] : []),
        ],
      },
      include: { customerProfile: true },
    });

    if (existing) {
      if (!existing.firebaseUid) {
        const updated = await prisma.user.update({
          where: { id: existing.id },
          data: { firebaseUid: firebaseUser.uid, isVerified: true },
          include: { customerProfile: true },
        });
        sendSuccess(res, { user: updated }, 200);
        return;
      }
      sendSuccess(res, { user: existing }, 200);
      return;
    }

    const newUser = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          firebaseUid: firebaseUser.uid,
          email: finalEmail,
          phone: finalPhone,
          name: finalName,
          profilePhotoUrl: profilePhotoUrl || firebaseUser.picture || null,
          role: 'CUSTOMER',
          status: 'ACTIVE',
          isVerified: true,
          customerProfile: {
            create: {
              totalBookings: 0,
              totalSpent: '0.00',
            },
          },
        },
        include: {
          customerProfile: true,
        },
      });
      return user;
    });

    sendSuccess(res, { user: newUser }, 201);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const getCustomerProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        name: true,
        role: true,
        status: true,
        profilePhotoUrl: true,
        createdAt: true,
        customerProfile: true,
        addresses: {
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
        },
      },
    });

    if (!user) {
      sendError(res, 'NOT_FOUND', 'Customer profile not found', 404);
      return;
    }

    sendSuccess(res, { customer: user }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const updateCustomerProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { name, phone, profilePhotoUrl, emergencyContact, notes } = req.body;

    const updated = await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: {
          ...(name ? { name } : {}),
          ...(phone ? { phone } : {}),
          ...(profilePhotoUrl !== undefined ? { profilePhotoUrl } : {}),
          customerProfile: {
            upsert: {
              create: {
                emergencyContact: emergencyContact || null,
                notes: notes || null,
              },
              update: {
                ...(emergencyContact !== undefined ? { emergencyContact } : {}),
                ...(notes !== undefined ? { notes } : {}),
              },
            },
          },
        },
        include: {
          customerProfile: true,
        },
      });
      return user;
    });

    sendSuccess(res, { customer: updated }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

// -------------------------------------------------------------
// Customer Address Book
// -------------------------------------------------------------

export const getCustomerAddresses = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const addresses = await prisma.userAddress.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    sendSuccess(res, { addresses }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const addCustomerAddress = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const data = req.body;

    const newAddress = await prisma.$transaction(async (tx) => {
      if (data.isDefault) {
        await tx.userAddress.updateMany({
          where: { userId },
          data: { isDefault: false },
        });
      }
      return tx.userAddress.create({
        data: {
          ...data,
          userId,
        },
      });
    });

    sendSuccess(res, { address: newAddress }, 201);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const updateCustomerAddress = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const data = req.body;

    const address = await prisma.userAddress.findFirst({
      where: { id, userId },
    });

    if (!address) {
      sendError(res, 'NOT_FOUND', 'Address not found or unauthorized', 404);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (data.isDefault) {
        await tx.userAddress.updateMany({
          where: { userId, id: { not: id } },
          data: { isDefault: false },
        });
      }
      return tx.userAddress.update({
        where: { id },
        data,
      });
    });

    sendSuccess(res, { address: updated }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const deleteCustomerAddress = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;

    const address = await prisma.userAddress.findFirst({
      where: { id, userId },
    });

    if (!address) {
      sendError(res, 'NOT_FOUND', 'Address not found or unauthorized', 404);
      return;
    }

    await prisma.userAddress.delete({ where: { id } });
    sendSuccess(res, null, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const setDefaultCustomerAddress = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;

    const address = await prisma.userAddress.findFirst({
      where: { id, userId },
    });

    if (!address) {
      sendError(res, 'NOT_FOUND', 'Address not found or unauthorized', 404);
      return;
    }

    await prisma.$transaction([
      prisma.userAddress.updateMany({
        where: { userId },
        data: { isDefault: false },
      }),
      prisma.userAddress.update({
        where: { id },
        data: { isDefault: true },
      }),
    ]);

    sendSuccess(res, null, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

// -------------------------------------------------------------
// Customer Bookings
// -------------------------------------------------------------

function calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

export const createBooking = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { serviceId, packageId, addressId, scheduledDate, scheduledTimeSlot, paymentMethod, notes, vendorId } = req.body;

    // Concurrently fetch address, service, customer profile, admins, and active providers in 1 single network flight
    const [existingAddress, service, customerProfile, admins, candidateVendors] = await Promise.all([
      addressId
        ? prisma.userAddress.findFirst({ where: { id: addressId, userId } })
        : prisma.userAddress.findFirst({ where: { userId }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] }),
      prisma.service.findFirst({
        where: { id: serviceId, isActive: true, deletedAt: null },
        include: { packages: { where: { isActive: true } } },
      }),
      prisma.customerProfile.upsert({
        where: { userId },
        create: { userId },
        update: {},
      }),
      prisma.user.findMany({
        where: { role: 'SUPER_ADMIN', status: 'ACTIVE', deletedAt: null },
        select: { id: true },
      }),
      prisma.vendorProfile.findMany({
        where: {
          isActive: true,
          kycStatus: { not: 'REJECTED' },
        },
        select: {
          id: true,
          latitude: true,
          longitude: true,
          serviceRadiusKm: true,
          location: true,
          warehouseName: true,
          companyName: true,
          user: { select: { id: true, name: true } },
          vendorServices: {
            where: { isActive: true },
            select: { serviceId: true },
          },
          employees: {
            where: { isAvailable: true },
            select: { id: true },
            take: 25,
          },
        },
      }),
    ]);

    if (!service) {
      sendError(res, 'BAD_REQUEST', 'Service not found or inactive', 400);
      return;
    }

    let address = existingAddress;
    if (!address) {
      address = await prisma.userAddress.findFirst({
        where: { userId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      });
    }

    if (!address) {
      sendError(res, 'BAD_REQUEST', 'Please select or add a valid doorstep address before placing a booking', 400);
      return;
    }

    // Warehouse routing: find candidate hubs offering this service and determine best match
    let matchedVendor: (typeof candidateVendors)[0] | null = null;
    if (candidateVendors.length > 0) {
      const warehouseCandidates: WarehouseCandidate[] = candidateVendors.map((vendor) => ({
        id: vendor.id,
        latitude: vendor.latitude,
        longitude: vendor.longitude,
        serviceRadiusKm: vendor.serviceRadiusKm ?? 25,
        location: vendor.location || '',
        offersService: vendor.vendorServices.length === 0 || vendor.vendorServices.some((vs) => vs.serviceId === serviceId),
        availableExperts: vendor.employees.length,
      }));

      const point = isValidCoordinate(address.latitude, address.longitude)
        ? { lat: address.latitude as number, lng: address.longitude as number }
        : null;

      const resolution = resolveWarehouse(warehouseCandidates, point, address.city, vendorId);
      if (resolution) {
        matchedVendor = candidateVendors.find((v) => v.id === resolution.vendorId) || null;
      }
    }

    const assignedVendorId = matchedVendor ? matchedVendor.id : null;

    let basePrice = asDecimal(service.startingPrice);
    let actualPackageId: string | null = null;
    if (packageId) {
      const selectedPackage = service.packages.find((p) => p.id === packageId);
      if (selectedPackage) {
        actualPackageId = selectedPackage.id;
        basePrice = asDecimal(selectedPackage.discountedPrice ?? selectedPackage.price ?? service.startingPrice);
      }
    }

    // Zero GST / taxes and zero extra commission markup on bookings
    const taxes = new Prisma.Decimal(0);
    const totalAmount = basePrice;
    const bookingNumber = `SFX-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
    const now = new Date();
    const dispatchDueAt = addSeconds(now, env.PROVIDER_RESPONSE_WINDOW_SECONDS);

    const newBooking = await prisma.$transaction(async (tx) => {
      const [booking] = await Promise.all([
        tx.booking.create({
          data: {
            bookingNumber,
            customerId: customerProfile.id,
            vendorId: assignedVendorId,
            serviceId,
            packageId: actualPackageId,
            addressId: address.id,
            scheduledDate,
            scheduledTimeSlot,
            status: 'PENDING',
            dispatchDueAt,
            dispatchAttempts: 0,
            basePrice: toMoney(basePrice),
            taxes: toMoney(taxes),
            totalAmount: toMoney(totalAmount),
            paymentMethod: paymentMethod || 'ONLINE',
            paymentStatus: 'PENDING',
            bookingSource: 'CUSTOMER_APP',
            qrChallengeToken: generateStartOtp(),
            notes: notes || null,
            statusHistory: {
              create: {
                newStatus: 'PENDING',
                changedBy: userId,
                changedByRole: 'CUSTOMER',
                reason: matchedVendor
                  ? `Order routed to warehouse: ${matchedVendor.warehouseName || matchedVendor.companyName}`
                  : 'Customer initiated new service booking',
              },
            },
          },
          include: {
            customer: {
              include: {
                user: { select: { name: true, phone: true, email: true } },
              },
            },
            service: {
              select: { id: true, name: true, slug: true, startingPrice: true, durationText: true, iconUrl: true, imageUrl: true },
            },
            package: true,
            address: true,
            vendor: true,
            employee: {
              include: {
                user: { select: { name: true, phone: true } },
              },
            },
            statusHistory: true,
          },
        }),
        tx.customerProfile.update({
          where: { id: customerProfile.id },
          data: {
            totalBookings: { increment: 1 },
            totalSpent: toMoney(asDecimal(customerProfile.totalSpent).plus(totalAmount)),
          },
        }),
      ]);

      return booking;
    }, { maxWait: 8000, timeout: 15000 });

    // Arm precise in-process timer for 60-second provider response window
    if (newBooking.dispatchDueAt) {
      scheduleDispatch(newBooking.id, newBooking.dispatchDueAt);
      void syncDispatchTimer(newBooking.id);
    }

    // Directly notify the assigned provider to dispatch an expert
    if (matchedVendor?.user) {
      prisma.notification.create({
        data: {
          title: `New booking assigned #${bookingNumber}`,
          message: `New booking for ${service.name} from ${matchedVendor.warehouseName || matchedVendor.companyName}. Scheduled on ${scheduledDate} (${scheduledTimeSlot}). Respond within ${env.PROVIDER_RESPONSE_WINDOW_SECONDS}s.`,
          target: 'SPECIFIC_USER',
          targetUserId: matchedVendor.user.id,
        },
      }).catch((e) => console.error('Failed to create vendor notification:', e));
    }

    // Notify customer that booking is routed directly to the service partner
    prisma.notification.create({
      data: {
        title: `Booking Confirmed #${bookingNumber}`,
        message: matchedVendor
          ? `Your booking for ${service.name} has been routed to ${matchedVendor.warehouseName || matchedVendor.companyName}. Finding an expert...`
          : `Your booking for ${service.name} has been placed.`,
        target: 'SPECIFIC_USER',
        targetUserId: userId,
      },
    }).catch((e) => console.error('Failed to create customer notification:', e));

    // Non-blocking informational notification to admins (for transparency / audit)
    if (admins.length > 0) {
      prisma.notification.createMany({
        data: admins.map((admin) => ({
          title: `New booking #${bookingNumber} routed to provider`,
          message: `${service.name} on ${scheduledDate} (${scheduledTimeSlot}) in ${address.city || 'area'}. Directly assigned to ${matchedVendor ? (matchedVendor.warehouseName || matchedVendor.companyName) : 'general queue'}.`,
          target: 'SPECIFIC_USER' as const,
          targetUserId: admin.id,
        })),
      }).catch((e) => console.error('Failed to create admin notifications:', e));
    }

    // Realtime socket dispatch to Customer & Provider
    const targetUserIds = [userId];
    if (matchedVendor?.user?.id) {
      targetUserIds.push(matchedVendor.user.id);
    }

    emitBookingEvent('booking:new', {
      bookingId: newBooking.id,
      bookingNumber: newBooking.bookingNumber,
      status: newBooking.status,
      vendorId: assignedVendorId,
      booking: newBooking,
    }, targetUserIds);

    void emitBookingRefresh(newBooking.id);

    sendSuccess(res, { booking: newBooking }, 201);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const getCustomerBookings = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const statusQuery = typeof req.query.status === 'string' ? req.query.status : undefined;
    const page = parseInt(String(req.query.page || '1'), 10) || 1;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '10'), 10) || 10, 1), 50);
    const skip = (page - 1) * limit;

    const where: Prisma.BookingWhereInput = {
      customer: { userId },
      ...(statusQuery ? { status: statusQuery as BookingStatus } : {}),
    };

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        take: limit,
        skip,
        orderBy: { createdAt: 'desc' },
        include: {
          service: {
            select: { id: true, name: true, slug: true, imageUrl: true, durationText: true, iconUrl: true },
          },
          package: true,
          address: true,
          vendor: {
            select: { id: true, companyName: true, rating: true, location: true },
          },
          employee: {
            select: { id: true, specialization: true, rating: true, phone: true },
          },
          review: true,
        },
      }),
      prisma.booking.count({ where }),
    ]);

    sendSuccess(
      res,
      { bookings },
      200,
      {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      }
    );
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const getCustomerBookingById = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;

    const booking = await prisma.booking.findFirst({
      where: {
        id,
        customer: { userId },
      },
      include: {
        service: true,
        package: true,
        address: true,
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
        statusHistory: {
          orderBy: { createdAt: 'asc' },
        },
        review: true,
      },
    });

    if (!booking) {
      sendError(res, 'NOT_FOUND', 'Booking not found', 404);
      return;
    }

    const startOtp = customerStartOtpPayload(booking);
    sendSuccess(res, { booking: { ...booking, startOtp, qrChallengeToken: startOtp } }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const cancelBooking = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const { reason } = req.body;

    const booking = await prisma.booking.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, userId: true } },
        vendor: { select: { userId: true } },
        employee: { select: { userId: true } },
      },
    });

    if (!booking || booking.customer.userId !== userId) {
      sendError(res, 'NOT_FOUND', 'Booking not found', 404);
      return;
    }

    // Idempotent cancellation: if already cancelled, return immediately
    if (booking.status === 'CANCELLED') {
      sendSuccess(res, { booking }, 200);
      return;
    }

    const nonCancellableStatuses = [
      'ON_THE_WAY',
      'ARRIVED',
      'IN_PROGRESS',
      'AWAITING_CUSTOMER_CONFIRMATION',
      'AWAITING_PAYMENT',
      'COMPLETED',
      'DECLINED',
    ];
    if (nonCancellableStatuses.includes(booking.status)) {
      sendError(
        res,
        'BAD_REQUEST',
        `Cannot cancel booking in ${booking.status} status. Service has already commenced or been finalized.`,
        400
      );
      return;
    }

    const updated = await prisma.booking.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancellationReason: reason,
        statusHistory: {
          create: {
            oldStatus: booking.status,
            newStatus: 'CANCELLED',
            changedBy: userId,
            changedByRole: 'CUSTOMER',
            reason: `Cancelled by customer: ${reason}`,
          },
        },
      },
    });

    await releaseDispatchOnCancel(id);

    // Real-time dispatch without blocking or redundant DB queries
    emitBookingEvent(
      'booking:updated',
      {
        bookingId: updated.id,
        bookingNumber: updated.bookingNumber,
        status: updated.status,
        vendorId: updated.vendorId,
      },
      [booking.vendor?.userId, booking.employee?.userId, userId]
    );

    sendSuccess(res, { booking: updated }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const rescheduleBooking = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const { scheduledDate, scheduledTimeSlot } = req.body;

    const customerProfile = await prisma.customerProfile.findUnique({
      where: { userId },
    });

    if (!customerProfile) {
      sendError(res, 'NOT_FOUND', 'Customer profile not found', 404);
      return;
    }

    const booking = await prisma.booking.findFirst({
      where: { id, customerId: customerProfile.id },
    });

    if (!booking) {
      sendError(res, 'NOT_FOUND', 'Booking not found', 404);
      return;
    }

    if (['COMPLETED', 'CANCELLED'].includes(booking.status)) {
      sendError(res, 'BAD_REQUEST', `Cannot reschedule a ${booking.status.toLowerCase()} booking`, 400);
      return;
    }

    const updated = await prisma.booking.update({
      where: { id },
      data: {
        scheduledDate,
        scheduledTimeSlot,
        statusHistory: {
          create: {
            oldStatus: booking.status,
            newStatus: booking.status,
            changedBy: userId,
            changedByRole: 'CUSTOMER',
            reason: `Rescheduled to ${scheduledDate} (${scheduledTimeSlot})`,
          },
        },
      },
    });

    void emitBookingRefresh(id);
    sendSuccess(res, { booking: updated }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

// -------------------------------------------------------------
// Customer Reviews
// -------------------------------------------------------------

export const submitCustomerReview = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const { rating, comment } = req.body;

    const customerProfile = await prisma.customerProfile.findUnique({
      where: { userId },
    });

    if (!customerProfile) {
      sendError(res, 'NOT_FOUND', 'Customer profile not found', 404);
      return;
    }

    const booking = await prisma.booking.findFirst({
      where: { id, customerId: customerProfile.id },
    });

    if (!booking) {
      sendError(res, 'NOT_FOUND', 'Booking not found', 404);
      return;
    }

    if (booking.status !== 'COMPLETED') {
      sendError(res, 'BAD_REQUEST', 'Reviews can only be submitted for COMPLETED bookings', 400);
      return;
    }

    const existingReview = await prisma.review.findFirst({
      where: { bookingId: id },
    });

    if (existingReview) {
      sendError(res, 'BAD_REQUEST', 'A review has already been submitted for this booking', 400);
      return;
    }

    const review = await prisma.$transaction(async (tx) => {
      const rev = await tx.review.create({
        data: {
          bookingId: id,
          customerId: userId,
          serviceId: booking.serviceId,
          vendorId: booking.vendorId || null,
          employeeId: booking.employeeId || null,
          rating,
          comment: comment || null,
        },
      });

      const serviceReviews = await tx.review.findMany({
        where: { serviceId: booking.serviceId, isHidden: false },
        select: { rating: true },
      });
      const avgServiceRating =
        serviceReviews.reduce((sum, r) => sum + r.rating, 0) / (serviceReviews.length || 1);

      await tx.service.update({
        where: { id: booking.serviceId },
        data: {
          rating: parseFloat(avgServiceRating.toFixed(1)),
          reviewCount: serviceReviews.length,
        },
      });

      if (booking.vendorId) {
        const vendorReviews = await tx.review.findMany({
          where: { vendorId: booking.vendorId, isHidden: false },
          select: { rating: true },
        });
        const avgVendorRating =
          vendorReviews.reduce((sum, r) => sum + r.rating, 0) / (vendorReviews.length || 1);

        await tx.vendorProfile.update({
          where: { id: booking.vendorId },
          data: {
            rating: parseFloat(avgVendorRating.toFixed(1)),
            reviewCount: vendorReviews.length,
          },
        });
      }

      return rev;
    });

    sendSuccess(res, { review }, 201);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

// -------------------------------------------------------------
// Rapido-style 4-digit start OTP
// -------------------------------------------------------------

export const getBookingStartOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const refresh = String(req.query.refresh || '') === 'true';

    const customerProfile = await prisma.customerProfile.findUnique({
      where: { userId },
    });

    if (!customerProfile) {
      sendError(res, 'NOT_FOUND', 'Customer profile not found', 404);
      return;
    }

    const booking = await prisma.booking.findFirst({
      where: { id, customerId: customerProfile.id },
      include: { service: true },
    });

    if (!booking) {
      sendError(res, 'NOT_FOUND', 'Booking not found', 404);
      return;
    }

    if (['COMPLETED', 'CANCELLED', 'DECLINED'].includes(booking.status)) {
      sendError(res, 'BAD_REQUEST', `Cannot issue a start OTP for a ${booking.status} booking`, 400);
      return;
    }

    if (booking.qrVerifiedAt) {
      sendError(res, 'BAD_REQUEST', 'Start OTP has already been used. The expert has commenced this job.', 400);
      return;
    }

    const existing = customerStartOtpPayload(booking);
    const token = refresh || !existing ? generateStartOtp() : existing;

    if (token !== existing) {
      await prisma.booking.update({
        where: { id },
        data: {
          qrChallengeToken: token,
          qrChallengeExpiresAt: null,
        },
      });
    }

    sendSuccess(res, {
      bookingId: id,
      bookingNumber: booking.bookingNumber,
      serviceName: booking.service.name,
      startOtp: token,
      token,
      qrChallengeToken: token,
      otp: token,
    });
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

/** @deprecated alias — QR start verification was replaced with a 4-digit OTP. */
export const getBookingQrToken = getBookingStartOtp;

export const confirmBookingCompletion = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;

    const customerProfile = await prisma.customerProfile.findUnique({
      where: { userId },
    });

    if (!customerProfile) {
      sendError(res, 'NOT_FOUND', 'Customer profile not found', 404);
      return;
    }

    const booking = await prisma.booking.findFirst({
      where: { id, customerId: customerProfile.id },
    });

    if (!booking) {
      sendError(res, 'NOT_FOUND', 'Booking not found', 404);
      return;
    }

    if (!['AWAITING_CUSTOMER_CONFIRMATION', 'IN_PROGRESS'].includes(booking.status)) {
      sendError(
        res,
        'BAD_REQUEST',
        `Booking is in ${booking.status} state. Confirmation only available after employee requests completion.`,
        400
      );
      return;
    }

    const isPaymentSettled =
      booking.paymentStatus === 'PAID' ||
      booking.cashCollectedAt != null;

    const nextStatus: BookingStatus = isPaymentSettled ? 'COMPLETED' : 'AWAITING_PAYMENT';

    const updated = await prisma.$transaction(async (tx) => {
      const b = await tx.booking.update({
        where: { id },
        data: {
          status: nextStatus,
          customerConfirmedAt: new Date(),
          statusHistory: {
            create: {
              oldStatus: booking.status,
              newStatus: nextStatus,
              changedBy: userId,
              changedByRole: 'CUSTOMER',
              reason: 'Customer verified and confirmed service delivery completion.',
            },
          },
        },
      });

      if (nextStatus === 'COMPLETED' && booking.employeeId) {
        await tx.employeeProfile.update({
          where: { id: booking.employeeId },
          data: { completedJobs: { increment: 1 } },
        });
      }

      return b;
    });

    void emitBookingRefresh(id);
    sendSuccess(res, { booking: updated, status: nextStatus }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const reportBookingIssue = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const { reason } = req.body;

    if (!reason || reason.trim().length < 5) {
      sendError(res, 'BAD_REQUEST', 'Detailed dispute reason required (min 5 characters)', 400);
      return;
    }

    const customerProfile = await prisma.customerProfile.findUnique({
      where: { userId },
    });

    if (!customerProfile) {
      sendError(res, 'NOT_FOUND', 'Customer profile not found', 404);
      return;
    }

    const booking = await prisma.booking.findFirst({
      where: { id, customerId: customerProfile.id },
    });

    if (!booking) {
      sendError(res, 'NOT_FOUND', 'Booking not found', 404);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      return tx.booking.update({
        where: { id },
        data: {
          status: 'DISPUTED',
          disputeReason: reason.trim(),
          disputeReportedAt: new Date(),
          statusHistory: {
            create: {
              oldStatus: booking.status,
              newStatus: 'DISPUTED',
              changedBy: userId,
              changedByRole: 'CUSTOMER',
              reason: `Dispute reported by customer: ${reason.trim()}`,
            },
          },
        },
      });
    });

    void emitBookingRefresh(id);
    sendSuccess(res, { booking: updated, status: 'DISPUTED' }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};
