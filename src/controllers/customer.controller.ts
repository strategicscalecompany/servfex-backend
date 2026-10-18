import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendError, sendSuccess } from '../utils/response';
import { hashPassword } from '../utils/password';
import { logAuditEvent } from '../utils/audit';

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
    id: z.string().uuid(),
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
          customerProfile: true,
          addresses: { where: { isDefault: true } },
        },
      }),
    ]);

    const sanitizedData = users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      status: u.status,
      profilePhotoUrl: u.profilePhotoUrl,
      isVerified: u.isVerified,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      customerProfile: u.customerProfile,
      defaultAddress: u.addresses[0] || null,
    }));

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
              take: 10,
              orderBy: { createdAt: 'desc' },
              include: {
                service: { select: { name: true } },
                vendor: { select: { companyName: true } },
              },
            },
          },
        },
        addresses: true,
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

    const { passwordHash, ...safeUser } = user;
    sendSuccess(res, safeUser);
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
