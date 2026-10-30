import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendError, sendSuccess } from '../utils/response';
import { hashPassword } from '../utils/password';
import { logAuditEvent } from '../utils/audit';

const RECENT_BOOKINGS_LIMIT = 8;

const bookingDetailInclude = {
  service: { select: { id: true, name: true } },
  package: { select: { id: true, name: true, title: true } },
  vendor: { select: { id: true, companyName: true } },
  employee: {
    select: {
      id: true,
      user: { select: { name: true, phone: true } },
    },
  },
  address: true,
} as const;

function formatAddressLabel(address: {
  addressLine1?: string | null;
  addressLine2?: string | null;
  landmark?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
} | null | undefined): string | null {
  if (!address) return null;
  const parts = [
    address.addressLine1,
    address.addressLine2,
    address.landmark,
    address.city,
    address.state,
    address.postalCode,
  ]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

function serializeBooking(booking: any) {
  const location =
    (typeof booking.serviceFormattedAddress === 'string' && booking.serviceFormattedAddress.trim()) ||
    formatAddressLabel(booking.address) ||
    null;

  return {
    id: booking.id,
    bookingNumber: booking.bookingNumber,
    status: booking.status,
    scheduledDate: booking.scheduledDate,
    scheduledTimeSlot: booking.scheduledTimeSlot,
    totalAmount: booking.totalAmount,
    paymentStatus: booking.paymentStatus,
    paymentMethod: booking.paymentMethod,
    createdAt: booking.createdAt,
    service: booking.service || null,
    package: booking.package
      ? {
          id: booking.package.id,
          name: booking.package.name || booking.package.title || null,
          title: booking.package.title || booking.package.name || null,
        }
      : null,
    vendor: booking.vendor || null,
    employee: booking.employee
      ? {
          id: booking.employee.id,
          name: booking.employee.user?.name || null,
          phone: booking.employee.user?.phone || null,
        }
      : null,
    address: booking.address || null,
    location,
    serviceLatitude: booking.serviceLatitude ?? null,
    serviceLongitude: booking.serviceLongitude ?? null,
  };
}

function resolveCustomerLocation(addresses: any[], recentBookings: any[]) {
  const defaultAddress =
    addresses.find((address) => address?.isDefault) || addresses[0] || null;
  const latestBooking = recentBookings[0] || null;
  const location =
    formatAddressLabel(defaultAddress) ||
    (typeof latestBooking?.serviceFormattedAddress === 'string' &&
      latestBooking.serviceFormattedAddress.trim()) ||
    formatAddressLabel(latestBooking?.address) ||
    null;

  return { defaultAddress, location };
}

export const listCustomersQuerySchema = z.object({
  query: z.object({
    page: z.string().optional().default('1').transform((v) => Math.max(1, parseInt(v, 10))),
    limit: z.string().optional().default('20').transform((v) => Math.min(100, Math.max(1, parseInt(v, 10)))),
    search: z.string().optional(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'PENDING_APPROVAL']).optional(),
    sortBy: z.enum(['createdAt', 'name', 'email']).optional().default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
  }),
});

export const listCustomerBookingsQuerySchema = z.object({
  params: z.object({
    id: z.string().min(1, 'Customer ID is required'),
  }),
  query: z.object({
    page: z.string().optional().default('1').transform((v) => Math.max(1, parseInt(v, 10))),
    limit: z.string().optional().default('20').transform((v) => Math.min(50, Math.max(1, parseInt(v, 10)))),
  }),
});

export const createCustomerSchema = z.object({
  body: z.object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Invalid email address'),
    phone: z.string().min(10, 'Valid phone number is required'),
    password: z.string().min(6, 'Password must be at least 6 characters'),
    notes: z.string().optional(),
  }),
});

export const updateCustomerSchema = z.object({
  params: z.object({
    id: z.string().min(1, 'Customer ID is required'),
  }),
  body: z.object({
    name: z.string().min(2).optional(),
    phone: z.string().min(10).optional(),
    notes: z.string().optional(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
    reason: z.string().optional(),
  }),
});

export const getCustomers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, limit, search, status, sortBy, sortOrder } = req.query as any;
    const skip = (page - 1) * limit;

    const where: any = {
      role: 'CUSTOMER',
      deletedAt: null,
    };

    if (status) {
      where.status = status;
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
      ];
    }

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          customerProfile: {
            include: {
              bookings: {
                take: RECENT_BOOKINGS_LIMIT,
                orderBy: { createdAt: 'desc' },
                include: bookingDetailInclude,
              },
              _count: { select: { bookings: true } },
            },
          },
          addresses: {
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
          },
        },
      }),
    ]);

    const sanitizedData = users.map((u) => {
      const recentBookings = (u.customerProfile?.bookings || []).map(serializeBooking);
      const { defaultAddress, location } = resolveCustomerLocation(u.addresses, u.customerProfile?.bookings || []);
      const totalBookings = u.customerProfile?._count?.bookings ?? u.customerProfile?.totalBookings ?? 0;

      return {
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        status: u.status,
        profilePhotoUrl: u.profilePhotoUrl,
        isVerified: u.isVerified,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        location,
        defaultAddress,
        addresses: u.addresses,
        customerProfile: u.customerProfile
          ? {
              id: u.customerProfile.id,
              userId: u.customerProfile.userId,
              totalBookings,
              totalSpent: u.customerProfile.totalSpent,
              emergencyContact: u.customerProfile.emergencyContact,
              notes: u.customerProfile.notes,
              createdAt: u.customerProfile.createdAt,
            }
          : null,
        recentBookings,
      };
    });

    sendSuccess(res, sanitizedData, 200, {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    next(error);
  }
};

export const getCustomerById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;

    const user = await prisma.user.findFirst({
      where: { id, role: 'CUSTOMER', deletedAt: null },
      include: {
        customerProfile: {
          include: {
            bookings: {
              take: 20,
              orderBy: { createdAt: 'desc' },
              include: bookingDetailInclude,
            },
            _count: { select: { bookings: true } },
          },
        },
        addresses: {
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
        },
        reviewsWritten: {
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: { service: { select: { name: true } } },
        },
      },
    });

    if (!user) {
      sendError(res, 'CUSTOMER_NOT_FOUND', 'Customer not found', 404);
      return;
    }

    const { passwordHash: _passwordHash, customerProfile, addresses, ...safeUser } = user;
    const recentBookings = (customerProfile?.bookings || []).map(serializeBooking);
    const { defaultAddress, location } = resolveCustomerLocation(addresses, customerProfile?.bookings || []);
    const totalBookings = customerProfile?._count?.bookings ?? customerProfile?.totalBookings ?? 0;

    sendSuccess(res, {
      ...safeUser,
      location,
      defaultAddress,
      addresses,
      customerProfile: customerProfile
        ? {
            id: customerProfile.id,
            userId: customerProfile.userId,
            totalBookings,
            totalSpent: customerProfile.totalSpent,
            emergencyContact: customerProfile.emergencyContact,
            notes: customerProfile.notes,
            createdAt: customerProfile.createdAt,
          }
        : null,
      recentBookings,
      bookings: recentBookings,
      reviewsWritten: user.reviewsWritten,
    });
  } catch (error) {
    next(error);
  }
};

export const getCustomerBookings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { page, limit } = req.query as any;
    const skip = (page - 1) * limit;

    const user = await prisma.user.findFirst({
      where: { id, role: 'CUSTOMER', deletedAt: null },
      include: { customerProfile: true },
    });

    if (!user) {
      sendError(res, 'CUSTOMER_NOT_FOUND', 'Customer not found', 404);
      return;
    }

    if (!user.customerProfile) {
      sendSuccess(res, [], 200, { page, limit, total: 0, totalPages: 0 });
      return;
    }

    const where = { customerId: user.customerProfile.id };
    const [total, bookings] = await Promise.all([
      prisma.booking.count({ where }),
      prisma.booking.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: bookingDetailInclude,
      }),
    ]);

    sendSuccess(res, bookings.map(serializeBooking), 200, {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    next(error);
  }
};

export const createCustomer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, email, phone, password, notes } = req.body;

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ email: email.toLowerCase() }, { phone }],
        deletedAt: null,
      },
    });

    if (existingUser) {
      sendError(res, 'USER_EXISTS', 'A user with this email or phone already exists', 409);
      return;
    }

    const passwordHash = await hashPassword(password);

    const newUser = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name,
          email: email.toLowerCase(),
          phone,
          passwordHash,
          role: 'CUSTOMER',
          status: 'ACTIVE',
          isVerified: true,
          customerProfile: {
            create: {
              notes: notes || null,
            },
          },
        },
        include: { customerProfile: true },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'CUSTOMER_CREATED',
        entityType: 'User',
        entityId: user.id,
        after: { name: user.name, email: user.email, phone: user.phone },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return user;
    });

    const { passwordHash: _, ...safeUser } = newUser;
    sendSuccess(res, safeUser, 201);
  } catch (error) {
    next(error);
  }
};

export const updateCustomer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { name, phone, notes, status, reason } = req.body;

    const existingUser = await prisma.user.findFirst({
      where: { id, role: 'CUSTOMER', deletedAt: null },
      include: { customerProfile: true },
    });

    if (!existingUser) {
      sendError(res, 'CUSTOMER_NOT_FOUND', 'Customer not found', 404);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id },
        data: {
          ...(name ? { name } : {}),
          ...(phone ? { phone } : {}),
          ...(status ? { status } : {}),
          customerProfile: notes
            ? {
                upsert: {
                  create: { notes },
                  update: { notes },
                },
              }
            : undefined,
        },
        include: { customerProfile: true },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: status && status !== existingUser.status ? 'CUSTOMER_STATUS_CHANGED' : 'CUSTOMER_UPDATED',
        entityType: 'User',
        entityId: id,
        before: { name: existingUser.name, phone: existingUser.phone, status: existingUser.status },
        after: { name: user.name, phone: user.phone, status: user.status },
        reason: reason || undefined,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return user;
    });

    const { passwordHash: _, ...safeUser } = updated;
    sendSuccess(res, safeUser);
  } catch (error) {
    next(error);
  }
};

export const softDeleteCustomer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { reason } = req.body;

    const user = await prisma.user.findFirst({
      where: { id, role: 'CUSTOMER', deletedAt: null },
    });

    if (!user) {
      sendError(res, 'CUSTOMER_NOT_FOUND', 'Customer not found', 404);
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          status: 'INACTIVE',
        },
      });

      // Revoke any active sessions
      await tx.session.updateMany({
        where: { userId: id, isValid: true },
        data: { isValid: false },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'CUSTOMER_SOFT_DELETED',
        entityType: 'User',
        entityId: id,
        before: { status: user.status },
        after: { status: 'INACTIVE', deletedAt: new Date() },
        reason: reason || 'Deleted by Super Admin',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });
    });

    sendSuccess(res, { message: 'Customer successfully deactivated and archived' });
  } catch (error) {
    next(error);
  }
};
