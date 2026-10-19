import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendSuccess, sendError } from '../utils/response';
import { emitBookingRefresh, emitBookingEvent } from '../utils/realtime';
import { Prisma, BookingStatus, DocumentType } from '@prisma/client';
import { hashPassword } from '../utils/password';
import { generateAccessToken, generateRefreshToken } from '../utils/token';
import { sendProviderWelcomeEmail, sendExpertWelcomeEmail } from '../services/email.service';
import { getFirebaseAuth } from '../config/firebase';
import {
  acceptAssignment,
  advanceTravelStatus,
  assignExpertManually,
  DispatchError,
  rejectAssignment,
} from '../services/dispatch.service';

// -------------------------------------------------------------
// Validation Schemas
// -------------------------------------------------------------
export const registerVendorSchema = z.object({
  companyName: z.string().min(2, 'Company name is required'),
  location: z.string().min(2, 'Location is required'),
  name: z.string().min(2, 'Contact person name is required'),
  email: z.string().email().optional(),
  phone: z.string().min(10).optional(),
  password: z.string().min(6).optional(),
  businessLicense: z.string().optional(),
  taxId: z.string().optional(),
  bio: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

export const updateVendorProfileSchema = z.object({
  companyName: z.string().min(2).optional(),
  location: z.string().min(2).optional(),
  bio: z.string().optional(),
  phone: z.string().optional(),
  specialization: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  isActive: z.boolean().optional(),
  isAvailable: z.boolean().optional(),
});

export const uploadDocumentSchema = z.object({
  type: z.enum(['GOVERNMENT_ID', 'TRADE_LICENSE', 'TAX_DOCUMENT', 'CERTIFICATE', 'OTHER']),
  title: z.string().min(2, 'Document title is required'),
  fileUrl: z.string().url('Valid file URL is required'),
});

export const vendorServiceSchema = z.object({
  serviceId: z.string().optional(),
  title: z.string().optional(),
  category: z.string().optional(),
  description: z.string().optional(),
  customPrice: z.number().positive().optional(),
  price: z.number().positive().optional(),
  availability: z.string().default('Mon-Sat: 09:00 - 18:00'),
  isActive: z.boolean().default(true),
});

export const vendorInquirySchema = z.object({
  serviceId: z.string().optional(),
  preferredDate: z.string().optional(),
  message: z.string().optional(),
  budget: z.string().optional(),
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
});

export const feedbackSchema = z.object({
  rating: z.number().int().min(1).max(5).default(5),
  comment: z.string().optional(),
  feedbackType: z.string().default('General Experience'),
  employeeId: z.string().optional(),
});

export const updateVendorServiceSchema = z.object({
  customPrice: z.number().positive().optional(),
  availability: z.string().optional(),
  isActive: z.boolean().optional(),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum([
    'ACCEPTED',
    'ASSIGNED',
    'ON_THE_WAY',
    'ARRIVED',
    'IN_PROGRESS',
    'AWAITING_CUSTOMER_CONFIRMATION',
    'COMPLETED',
    'DECLINED',
  ]),
  note: z.string().optional(),
});

export const verifyOrderQrSchema = z
  .object({
    token: z.string().optional(),
    qrToken: z.string().optional(),
  })
  .refine((data) => Boolean(data.token || data.qrToken), {
    message: 'QR challenge verification token is required',
    path: ['token'],
  });

export const recordCashSchema = z.object({
  amount: z.number().positive().optional(),
});

export const assignEmployeeOrderSchema = z.object({
  employeeId: z.string().optional().nullable(),
  expertPayout: z.number().positive().optional(),
  payout: z.number().positive().optional(),
  note: z.string().optional(),
  instructions: z.string().optional(),
});

export const createEmployeeSchema = z.object({
  name: z.string().min(2, 'Employee name is required'),
  email: z.string().email('Valid employee email required'),
  phone: z.string().min(10, 'Valid employee phone required'),
  specialization: z.string().min(2, 'Specialization is required'),
  password: z.string().min(4).optional(),
});

export const updateEmployeeSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().min(10).optional(),
  specialization: z.string().min(2).optional(),
  isAvailable: z.boolean().optional(),
});

// -------------------------------------------------------------
// Vendor Auth & Onboarding
// -------------------------------------------------------------

export const registerVendor = async (req: Request, res: Response): Promise<void> => {
  try {
    const firebaseUser = req.firebaseUser;
    const { companyName, location, name, email, phone, password, businessLicense, taxId, bio, latitude, longitude } =
      req.body;

    const finalEmail = (email || firebaseUser?.email || '').toLowerCase().trim();
    if (!finalEmail) {
      sendError(res, 'BAD_REQUEST', 'Email is required for vendor registration', 400);
      return;
    }

    const finalPhone = phone || firebaseUser?.phone_number || null;
    const finalName = name || firebaseUser?.name || companyName;

    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          ...(firebaseUser?.uid ? [{ firebaseUid: firebaseUser.uid }] : []),
          { email: finalEmail },
          ...(finalPhone ? [{ phone: finalPhone }] : []),
        ],
      },
      include: { vendorProfile: true },
    });

    if (existing) {
      if (!existing.firebaseUid && firebaseUser?.uid) {
        const updated = await prisma.user.update({
          where: { id: existing.id },
          data: { firebaseUid: firebaseUser.uid, isVerified: true },
          include: { vendorProfile: true },
        });
        const token = generateAccessToken({ userId: updated.id, role: updated.role, email: updated.email });
        sendSuccess(res, { user: updated, token }, 200);
        return;
      }
      const token = generateAccessToken({ userId: existing.id, role: existing.role, email: existing.email });
      sendSuccess(res, { user: existing, token }, 200);
      return;
    }

    let passwordHash = null;
    if (password) {
      passwordHash = await hashPassword(password);
    }

    const newVendor = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          firebaseUid: firebaseUser?.uid || null,
          email: finalEmail,
          phone: finalPhone,
          passwordHash,
          name: finalName,
          role: 'VENDOR',
          status: 'ACTIVE',
          isVerified: true,
          vendorProfile: {
            create: {
              companyName,
              location,
              businessLicense: businessLicense || null,
              taxId: taxId || null,
              bio: bio || null,
              latitude: latitude || null,
              longitude: longitude || null,
              kycStatus: 'APPROVED',
              rating: 5.0,
              reviewCount: 0,
              commissionRate: new Prisma.Decimal(15.0),
              isActive: true,
            },
          },
        },
        include: {
          vendorProfile: true,
        },
      });
      return user;
    });

    const token = generateAccessToken({ userId: newVendor.id, role: newVendor.role, email: newVendor.email });
    const refreshToken = generateRefreshToken({ userId: newVendor.id, role: newVendor.role, email: newVendor.email });

    // Send ServFex Provider Welcome Email with Hub details and credentials
    sendProviderWelcomeEmail({
      toEmail: finalEmail,
      name: finalName,
      companyName,
      location,
      warehouseName: null,
      warehouseLocation: location,
      warehousePhone: finalPhone || null,
      phone: finalPhone || null,
      password: password || 'Registered via App (Use your designated password or Google Sign-In)',
    }).catch((emailErr) => {
      console.warn('[VendorPortal] Notice sending provider welcome email:', emailErr?.message || emailErr);
    });

    sendSuccess(res, { user: newVendor, token, refreshToken }, 201);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const getVendorProfile = async (req: Request, res: Response): Promise<void> => {
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
        vendorProfile: {
          include: {
            _count: {
              select: {
                employees: true,
                vendorServices: true,
                bookings: true,
                reviews: true,
              },
            },
          },
        },
        employeeProfile: {
          include: {
            vendor: true,
          },
        },
      },
    });

    if (!user) {
      sendError(res, 'NOT_FOUND', 'User profile not found', 404);
      return;
    }

    if (user.vendorProfile) {
      sendSuccess(res, { vendor: user }, 200);
      return;
    }

    if (user.employeeProfile) {
      sendSuccess(res, {
        vendor: {
          ...user,
          companyName: user.employeeProfile.vendor.companyName,
          location: user.employeeProfile.vendor.location,
          rating: user.employeeProfile.rating,
          specialization: user.employeeProfile.specialization,
        },
      }, 200);
      return;
    }

    sendError(res, 'NOT_FOUND', 'Neither vendor nor employee profile found', 404);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const updateVendorProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { companyName, location, bio, phone, specialization, isAvailable, latitude, longitude, isActive } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendorProfile: true, employeeProfile: true },
    });

    if (!user) {
      sendError(res, 'NOT_FOUND', 'User not found', 404);
      return;
    }

    if (user.vendorProfile) {
      const updated = await prisma.vendorProfile.update({
        where: { id: user.vendorProfile.id },
        data: {
          ...(companyName ? { companyName } : {}),
          ...(location ? { location } : {}),
          ...(bio !== undefined ? { bio } : {}),
          ...(latitude !== undefined ? { latitude } : {}),
          ...(longitude !== undefined ? { longitude } : {}),
          ...(isActive !== undefined ? { isActive } : {}),
        },
      });
      sendSuccess(res, { vendorProfile: updated }, 200);
      return;
    }

    if (user.employeeProfile) {
      const updated = await prisma.$transaction(async (tx) => {
        if (phone) {
          await tx.user.update({
            where: { id: userId },
            data: { phone },
          });
        }
        return tx.employeeProfile.update({
          where: { id: user.employeeProfile!.id },
          data: {
            ...(phone ? { phone } : {}),
            ...(specialization ? { specialization } : {}),
            ...(isAvailable !== undefined ? { isAvailable } : {}),
          },
        });
      });
      sendSuccess(res, { employeeProfile: updated }, 200);
      return;
    }

    sendError(res, 'NOT_FOUND', 'Vendor or Employee profile not found', 404);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

// -------------------------------------------------------------
// Vendor KYC Documents
// -------------------------------------------------------------

export const getVendorDocuments = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const documents = await prisma.document.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    sendSuccess(res, { documents }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const uploadVendorDocument = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { type, title, fileUrl } = req.body;

    const document = await prisma.document.create({
      data: {
        userId,
        type: type as DocumentType,
        title,
        fileUrl,
        verificationStatus: 'PENDING',
      },
    });

    sendSuccess(res, { document }, 201);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

// -------------------------------------------------------------
// Vendor Services Catalog
// -------------------------------------------------------------

export const getVendorServices = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendorProfile: true, employeeProfile: true },
    });

    const vendorId = user?.vendorProfile?.id || user?.employeeProfile?.vendorId;
    if (!vendorId) {
      sendError(res, 'NOT_FOUND', 'Vendor or Employee profile not found', 404);
      return;
    }

    const services = await prisma.vendorService.findMany({
      where: { vendorId },
      include: {
        service: {
          include: { category: true, packages: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    sendSuccess(res, { services }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const addVendorService = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { serviceId, title, category, description, customPrice, price, availability, isActive } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendorProfile: true, employeeProfile: true },
    });

    const vendorId = user?.vendorProfile?.id || user?.employeeProfile?.vendorId;
    if (!vendorId) {
      sendError(res, 'NOT_FOUND', 'Vendor or Employee profile not found', 404);
      return;
    }

    let targetServiceId = serviceId;
    if (!targetServiceId) {
      // Find category by name or first active category
      const targetCat = await prisma.serviceCategory.findFirst({
        where: category ? { name: { contains: category, mode: 'insensitive' } } : { isActive: true },
      }) || await prisma.serviceCategory.findFirst();

      const newService = await prisma.service.create({
        data: {
          categoryId: targetCat!.id,
          name: title || 'Custom Service',
          slug: `custom-${Date.now()}`,
          description: description || 'Custom service offering',
          startingPrice: new Prisma.Decimal(price || customPrice || 499),
          priceUnit: 'per service',
          durationText: '60 mins',
          rating: 5.0,
          reviewCount: 0,
        },
      });
      targetServiceId = newService.id;
    }

    const finalPrice = customPrice !== undefined ? customPrice : price;

    const vendorService = await prisma.vendorService.upsert({
      where: {
        vendorId_serviceId: {
          vendorId,
          serviceId: targetServiceId,
        },
      },
      update: {
        customPrice: finalPrice !== undefined ? new Prisma.Decimal(finalPrice) : null,
        availability: availability || 'Mon-Sat: 09:00 - 18:00',
        isActive: isActive !== undefined ? isActive : true,
      },
      create: {
        vendorId,
        serviceId: targetServiceId,
        customPrice: finalPrice !== undefined ? new Prisma.Decimal(finalPrice) : null,
        availability: availability || 'Mon-Sat: 09:00 - 18:00',
        isActive: isActive !== undefined ? isActive : true,
      },
      include: {
        service: true,
      },
    });

    sendSuccess(res, { service: vendorService }, 201);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const updateVendorService = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const { customPrice, price, availability, isActive } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendorProfile: true, employeeProfile: true },
    });

    const vendorId = user?.vendorProfile?.id || user?.employeeProfile?.vendorId;
    if (!vendorId) {
      sendError(res, 'NOT_FOUND', 'Vendor profile not found', 404);
      return;
    }

    const vendorService = await prisma.vendorService.findFirst({
      where: { id, vendorId },
    });

    if (!vendorService) {
      sendError(res, 'NOT_FOUND', 'Vendor service not found', 404);
      return;
    }

    const finalPrice = customPrice !== undefined ? customPrice : price;

    const updated = await prisma.vendorService.update({
      where: { id },
      data: {
        ...(finalPrice !== undefined ? { customPrice: finalPrice ? new Prisma.Decimal(finalPrice) : null } : {}),
        ...(availability !== undefined ? { availability } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
      include: { service: true },
    });

    sendSuccess(res, { service: updated }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const deleteVendorService = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendorProfile: true, employeeProfile: true },
    });

    const vendorId = user?.vendorProfile?.id || user?.employeeProfile?.vendorId;
    if (!vendorId) {
      sendError(res, 'NOT_FOUND', 'Vendor profile not found', 404);
      return;
    }

    await prisma.vendorService.deleteMany({
      where: { id, vendorId },
    });

    sendSuccess(res, null, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

// -------------------------------------------------------------
// Vendor Orders & Dispatch
// -------------------------------------------------------------

export const getVendorOrders = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const statusQuery = typeof req.query.status === 'string' ? req.query.status : undefined;
    const page = parseInt(String(req.query.page || '1'), 10) || 1;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendorProfile: true, employeeProfile: true },
    });

    let where: any = {};
    if (user?.vendorProfile) {
      // Vendors only see jobs the Super Admin has dispatched to them.
      where.vendorId = user.vendorProfile.id;
    } else if (user?.employeeProfile) {
      where.OR = [
        { employeeId: user.employeeProfile.id },
        {
          vendorId: user.employeeProfile.vendorId,
          employeeId: null,
          status: { in: ['ASSIGNED', 'PENDING'] },
        },
      ];
    } else {
      sendError(res, 'NOT_FOUND', 'Vendor or Employee profile not found', 404);
      return;
    }

    if (statusQuery) {
      where.status = statusQuery as BookingStatus;
    }

    const [orders, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        take: limit,
        skip,
        orderBy: { scheduledDate: 'desc' },
        include: {
          customer: {
            include: {
              user: { select: { name: true, phone: true, profilePhotoUrl: true } },
            },
          },
          service: true,
          package: true,
          address: true,
          employee: {
            include: {
              user: { select: { name: true, phone: true } },
            },
          },
        },
      }),
      prisma.booking.count({ where }),
    ]);

    sendSuccess(
      res,
      { orders },
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

export const getVendorOrderById = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendorProfile: true, employeeProfile: true },
    });

    let where: any = { id };
    if (user?.vendorProfile) {
      where.vendorId = user.vendorProfile.id;
    } else if (user?.employeeProfile) {
      where.OR = [
        { employeeId: user.employeeProfile.id },
        { vendorId: user.employeeProfile.vendorId },
      ];
    } else {
      sendError(res, 'NOT_FOUND', 'Vendor or Employee profile not found', 404);
      return;
    }

    const order = await prisma.booking.findFirst({
      where,
      include: {
        customer: {
          include: {
            user: { select: { name: true, phone: true, email: true, profilePhotoUrl: true } },
          },
        },
        service: true,
        package: true,
        address: true,
        employee: {
          include: {
            user: { select: { name: true, phone: true } },
          },
        },
        statusHistory: {
          orderBy: { createdAt: 'asc' },
        },
        payments: true,
      },
    });

    if (!order) {
      sendError(res, 'NOT_FOUND', 'Order not found', 404);
      return;
    }

    sendSuccess(res, { order }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const updateOrderStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const { status, note } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendorProfile: true, employeeProfile: true },
    });

    let booking;
    if (user?.vendorProfile) {
      booking = await prisma.booking.findFirst({
        where: { id, vendorId: user.vendorProfile.id },
      });
    } else if (user?.employeeProfile) {
      booking = await prisma.booking.findFirst({
        where: {
          id,
          OR: [
            { employeeId: user.employeeProfile.id },
            { vendorId: user.employeeProfile.vendorId },
          ],
        },
      });
    }

    if (!booking) {
      sendError(res, 'NOT_FOUND', 'Order not found or unauthorized', 404);
      return;
    }

    if (user?.employeeProfile) {
      if (status === 'ACCEPTED') {
        await acceptAssignment(userId, id);
        const order = await prisma.booking.findUnique({
          where: { id },
          include: {
            customer: { include: { user: true } },
            service: true,
            address: true,
            employee: { include: { user: true } },
            vendor: { include: { user: true } },
          },
        });
        sendSuccess(res, { order }, 200);
        return;
      }
      if (status === 'REJECTED' || status === 'DECLINED') {
        await rejectAssignment(userId, id, note);
        const order = await prisma.booking.findUnique({
          where: { id },
          include: {
            customer: { include: { user: true } },
            service: true,
            address: true,
            employee: { include: { user: true } },
            vendor: { include: { user: true } },
          },
        });
        sendSuccess(res, { order }, 200);
        return;
      }
      if (status === 'ON_THE_WAY' || status === 'ARRIVED') {
        await advanceTravelStatus(userId, id, status);
        const order = await prisma.booking.findUnique({
          where: { id },
          include: {
            customer: { include: { user: true } },
            service: true,
            address: true,
            employee: { include: { user: true } },
            vendor: { include: { user: true } },
          },
        });
        sendSuccess(res, { order }, 200);
        return;
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.booking.findUnique({
        where: { id },
        include: {
          employee: { include: { user: true } },
          vendor: { include: { user: true } },
          service: true,
          customer: { include: { user: true } },
        },
      });
      if (!current) throw new Error('Order not found');

      if (
        user?.employeeProfile &&
        status === 'ACCEPTED' &&
        current.status === 'ACCEPTED' &&
        current.employeeId &&
        current.employeeId !== user.employeeProfile.id
      ) {
        throw new Error(`This order was already accepted by ${current.employee?.user?.name || 'another technician'}.`);
      }

      const updateData: any = {
        status: status as BookingStatus,
        statusHistory: {
          create: {
            oldStatus: current.status,
            newStatus: status as BookingStatus,
            changedBy: userId,
            changedByRole: (user?.role as any) || 'VENDOR',
            reason: note || (status === 'ACCEPTED' && user?.employeeProfile ? `Order accepted by ${user.name}` : `Status updated to ${status}`),
          },
        },
      };

      if (user?.employeeProfile && (status === 'ACCEPTED' || status === 'IN_PROGRESS' || status === 'ON_THE_WAY')) {
        updateData.employeeId = user.employeeProfile.id;
      }

      const b = await tx.booking.update({
        where: { id },
        data: updateData,
        include: {
          customer: { include: { user: true } },
          service: true,
          address: true,
          employee: { include: { user: true } },
          vendor: { include: { user: true } },
        },
      });

      // If employee accepted the order, notify Vendor & Customer
      if (status === 'ACCEPTED' && user?.employeeProfile) {
        if (current.vendor?.user) {
          await tx.notification.create({
            data: {
              title: `Job Accepted #${b.bookingNumber}`,
              message: `Expert ${user.name} has accepted order #${b.bookingNumber} (${current.service.name}).`,
              target: 'SPECIFIC_USER',
              targetUserId: current.vendor.user.id,
            },
          });
        }
        if (current.customer?.user) {
          await tx.notification.create({
            data: {
              title: `Service Confirmed #${b.bookingNumber}`,
              message: `Expert ${user.name} has accepted your booking for ${current.service.name}.`,
              target: 'SPECIFIC_USER',
              targetUserId: current.customer.user.id,
            },
          });
        }
      }

      if (status === 'COMPLETED' && (b.employeeId || current.employeeId)) {
        await tx.employeeProfile.update({
          where: { id: (b.employeeId || current.employeeId)! },
          data: {
            completedJobs: { increment: 1 },
          },
        });
      }

      return b;
    }, { maxWait: 10000, timeout: 20000 });

    void emitBookingRefresh(id);
    sendSuccess(res, { order: updated }, 200);
  } catch (err: any) {
    if (err instanceof DispatchError) {
      sendError(res, err.code, err.message, err.httpStatus);
      return;
    }
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const verifyOrderQr = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const rawToken = req.body.token || req.body.qrToken;
    const token = typeof rawToken === 'string' ? rawToken.trim() : '';

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendorProfile: true, employeeProfile: true },
    });

    let booking;
    if (user?.vendorProfile) {
      booking = await prisma.booking.findFirst({
        where: { id, vendorId: user.vendorProfile.id },
      });
    } else if (user?.employeeProfile) {
      booking = await prisma.booking.findFirst({
        where: {
          id,
          OR: [
            { employeeId: user.employeeProfile.id },
            { vendorId: user.employeeProfile.vendorId },
          ],
        },
      });
    }

    if (!booking) {
      sendError(res, 'NOT_FOUND', 'Order not found or unauthorized', 404);
      return;
    }

    if (!booking.qrChallengeToken) {
      sendError(res, 'BAD_REQUEST', 'No active verification QR token was requested by the customer for this order', 400);
      return;
    }

    if (booking.qrVerifiedAt) {
      sendError(res, 'BAD_REQUEST', 'This service has already been QR-verified and started', 400);
      return;
    }

    if (booking.qrChallengeToken.toUpperCase() !== token.trim().toUpperCase()) {
      sendError(res, 'INVALID_QR_TOKEN', 'QR token challenge does not match this booking reference', 400);
      return;
    }

    if (booking.qrChallengeExpiresAt && new Date() > booking.qrChallengeExpiresAt) {
      sendError(res, 'QR_TOKEN_EXPIRED', 'The customer QR token has expired. Please ask the customer to refresh the screen', 400);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      return tx.booking.update({
        where: { id },
        data: {
          status: 'IN_PROGRESS',
          qrVerifiedAt: new Date(),
          statusHistory: {
            create: {
              oldStatus: booking.status,
              newStatus: 'IN_PROGRESS',
              changedBy: userId,
              changedByRole: (user?.role as any) || 'EMPLOYEE',
              reason: 'Customer QR verified on site by technician. Work officially commenced.',
            },
          },
        },
        include: {
          customer: { include: { user: true } },
          service: true,
          address: true,
          employee: { include: { user: true } },
        },
      });
    });

    void emitBookingRefresh(id);
    sendSuccess(res, { order: updated, message: 'QR verified successfully. Service is now IN PROGRESS.' }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const completeOrder = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const { note } = req.body || {};

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendorProfile: true, employeeProfile: true },
    });

    let booking;
    if (user?.vendorProfile) {
      booking = await prisma.booking.findFirst({
        where: { id, vendorId: user.vendorProfile.id },
      });
    } else if (user?.employeeProfile) {
      booking = await prisma.booking.findFirst({
        where: {
          id,
          OR: [
            { employeeId: user.employeeProfile.id },
            { vendorId: user.employeeProfile.vendorId },
          ],
        },
      });
    }

    if (!booking) {
      sendError(res, 'NOT_FOUND', 'Order not found or unauthorized', 404);
      return;
    }

    if (booking.status !== 'IN_PROGRESS') {
      sendError(res, 'BAD_REQUEST', `Cannot complete order in ${booking.status} status. Job must be IN_PROGRESS.`, 400);
      return;
    }

    if (!booking.qrVerifiedAt) {
      sendError(res, 'BAD_REQUEST', 'Cannot complete order without verified QR service commencement', 400);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      return tx.booking.update({
        where: { id },
        data: {
          status: 'AWAITING_CUSTOMER_CONFIRMATION',
          completionRequestedAt: new Date(),
          statusHistory: {
            create: {
              oldStatus: booking.status,
              newStatus: 'AWAITING_CUSTOMER_CONFIRMATION',
              changedBy: userId,
              changedByRole: (user?.role as any) || 'EMPLOYEE',
              reason: note || 'Technician completed service delivery. Awaiting customer confirmation.',
            },
          },
        },
        include: {
          customer: { include: { user: true } },
          service: true,
          address: true,
          employee: { include: { user: true } },
        },
      });
    });

    void emitBookingRefresh(id);
    sendSuccess(res, { order: updated, message: 'Completion submitted. Awaiting customer confirmation.' }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const recordCashCollection = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const { amount } = req.body || {};

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendorProfile: true, employeeProfile: true },
    });

    let booking;
    if (user?.vendorProfile) {
      booking = await prisma.booking.findFirst({
        where: { id, vendorId: user.vendorProfile.id },
      });
    } else if (user?.employeeProfile) {
      booking = await prisma.booking.findFirst({
        where: {
          id,
          OR: [
            { employeeId: user.employeeProfile.id },
            { vendorId: user.employeeProfile.vendorId },
          ],
        },
      });
    }

    if (!booking) {
      sendError(res, 'NOT_FOUND', 'Order not found or unauthorized', 404);
      return;
    }
    if (booking.paymentMethod === 'ONLINE' && booking.paymentStatus === 'PAID') {
      sendError(res, 'BAD_REQUEST', 'This order was prepaid online. Do not collect cash from the customer.', 400);
      return;
    }

    if (booking.paymentStatus === 'PAID' && booking.cashCollectedAt != null) {
      sendError(res, 'BAD_REQUEST', 'Cash payment has already been collected and recorded for this order.', 400);
      return;
    }

    const collectedAmount = amount ? new Prisma.Decimal(amount) : booking.totalAmount;
    const isConfirmedByCustomer = booking.customerConfirmedAt != null;
    const nextStatus: BookingStatus = isConfirmedByCustomer ? 'COMPLETED' : booking.status;

    const updated = await prisma.$transaction(async (tx) => {
      const b = await tx.booking.update({
        where: { id },
        data: {
          cashCollectedAmount: collectedAmount,
          cashCollectedAt: new Date(),
          paymentStatus: 'PAID',
          paymentMethod: 'CASH',
          status: nextStatus,
          statusHistory: {
            create: {
              oldStatus: booking.status,
              newStatus: nextStatus,
              changedBy: userId,
              changedByRole: (user?.role as any) || 'EMPLOYEE',
              reason: `Cash collected on site: ₹${collectedAmount}`,
            },
          },
        },
      });

      await tx.payment.create({
        data: {
          bookingId: id,
          transactionRef: `CASH-${id.slice(0, 8)}-${Date.now().toString().slice(-4)}`,
          amount: collectedAmount,
          status: 'PAID',
          method: 'CASH',
          gatewayResponse: { collectorUserId: userId, collectionType: 'DIRECT_CASH' },
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
    sendSuccess(res, { order: updated, message: 'Cash collection recorded successfully.' }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const assignEmployeeToOrder = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const { employeeId, expertPayout, payout, note, instructions } = req.body;

    const vendorProfile = await prisma.vendorProfile.findUnique({
      where: { userId },
      include: { user: true },
    });

    if (!vendorProfile) {
      sendError(res, 'NOT_FOUND', 'Vendor profile not found', 404);
      return;
    }

    let employee: any = null;
    if (employeeId) {
      employee = await prisma.employeeProfile.findFirst({
        where: {
          OR: [
            { id: employeeId, vendorId: vendorProfile.id },
            { userId: employeeId, vendorId: vendorProfile.id },
          ],
        },
        include: { user: true },
      });

      if (!employee) {
        sendError(res, 'BAD_REQUEST', 'Technician/Employee does not belong to your company', 400);
        return;
      }
    }

    const booking = await prisma.booking.findFirst({
      where: {
        id,
        vendorId: vendorProfile.id,
      },
      include: {
        service: true,
        customer: { include: { user: true } },
      },
    });

    if (!booking) {
      sendError(res, 'NOT_FOUND', 'Order not found', 404);
      return;
    }

    const resolvedPayout = expertPayout || payout || null;
    const resolvedInstructions = (instructions || note || '').trim();

    if (employeeId) {
      const updated = await assignExpertManually({
        bookingId: id,
        vendorId: vendorProfile.id,
        vendorUserId: userId,
        employeeIdOrUserId: employeeId,
        expertPayout: resolvedPayout ? Number(resolvedPayout) : null,
        note: resolvedInstructions || null,
      });
      sendSuccess(res, { order: updated }, 200);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const updateData: any = {
        vendorId: vendorProfile.id,
        employeeId: null,
        status: 'ASSIGNED',
        statusHistory: {
          create: {
            oldStatus: booking.status,
            newStatus: 'ASSIGNED',
            changedBy: userId,
            changedByRole: 'VENDOR',
            reason: resolvedInstructions || `Dispatched to warehouse team with payout ₹${resolvedPayout || 'standard'}`,
          },
        },
      };

      if (resolvedPayout != null && resolvedPayout > 0) {
        updateData.expertPayout = new Prisma.Decimal(Number(resolvedPayout).toFixed(2));
      }

      if (resolvedInstructions) {
        updateData.notes = booking.notes
          ? `${booking.notes} | [Dispatch Note]: ${resolvedInstructions}`
          : `[Dispatch Note]: ${resolvedInstructions}`;
      }

      const b = await tx.booking.update({
        where: { id },
        data: updateData,
        include: {
          employee: {
            include: { user: { select: { name: true, phone: true } } },
          },
          service: true,
          customer: { include: { user: true } },
        },
      });

      const warehouseLabel = vendorProfile.warehouseName || vendorProfile.companyName;
      const payoutText = resolvedPayout ? ` ₹${Number(resolvedPayout).toFixed(2)}` : '';

      const warehouseExperts = await tx.employeeProfile.findMany({
        where: { vendorId: vendorProfile.id, isAvailable: true },
        include: { user: true },
      });

      for (const exp of warehouseExperts) {
        await tx.notification.create({
          data: {
            title: `New Warehouse Order Available #${b.bookingNumber}`,
            message: `New booking for ${booking.service.name} at ${warehouseLabel}. Expert Fare:${payoutText}. Tap to review and accept!`,
            target: 'SPECIFIC_USER',
            targetUserId: exp.userId,
          },
        });
      }

      return b;
    }, { maxWait: 10000, timeout: 20000 });

    void emitBookingRefresh(id);

    sendSuccess(res, { order: updated }, 200);
  } catch (err: any) {
    if (err instanceof DispatchError) {
      sendError(res, err.code, err.message, err.httpStatus);
      return;
    }
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

// -------------------------------------------------------------
// Vendor Employees / Technicians
// -------------------------------------------------------------

export const getVendorEmployees = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const vendorProfile = await prisma.vendorProfile.findUnique({
      where: { userId },
    });

    if (!vendorProfile) {
      sendError(res, 'NOT_FOUND', 'Vendor profile not found', 404);
      return;
    }

    const employees = await prisma.employeeProfile.findMany({
      where: { vendorId: vendorProfile.id },
      include: {
        user: {
          select: { id: true, name: true, email: true, phone: true, profilePhotoUrl: true, status: true },
        },
        _count: { select: { bookings: true, reviews: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    sendSuccess(res, { employees }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const createVendorEmployee = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { name, email, phone, specialization, password } = req.body;

    const vendorProfile = await prisma.vendorProfile.findUnique({
      where: { userId },
    });

    if (!vendorProfile) {
      sendError(res, 'NOT_FOUND', 'Vendor profile not found', 404);
      return;
    }

    const cleanEmail = email.toLowerCase().trim();
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ email: cleanEmail }, { phone }],
      },
    });

    if (existingUser) {
      sendError(res, 'BAD_REQUEST', 'A user with this email or phone already exists', 400);
      return;
    }

    const assignedPassword = password || `Expert@${Math.floor(1000 + Math.random() * 9000)}`;
    const passwordHash = await hashPassword(assignedPassword);

    const employee = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name,
          email: cleanEmail,
          phone,
          passwordHash,
          role: 'EMPLOYEE',
          status: 'ACTIVE',
          isVerified: true,
          employeeProfile: {
            create: {
              vendorId: vendorProfile.id,
              specialization,
              rating: 5.0,
              completedJobs: 0,
              phone,
              isAvailable: true,
            },
          },
        },
        include: {
          employeeProfile: true,
        },
      });
      return user;
    });

    // Send ServFex Expert Welcome Email with Provider details & credentials
    sendExpertWelcomeEmail({
      toEmail: cleanEmail,
      name,
      providerName: vendorProfile.companyName,
      providerCompany: vendorProfile.companyName,
      location: vendorProfile.location,
      specialization,
      phone,
      password: assignedPassword,
    }).catch((emailErr) => {
      console.warn('[Expert] Notice sending expert welcome email:', emailErr?.message || emailErr);
    });

    sendSuccess(res, { employee }, 201);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const updateVendorEmployee = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const { name, phone, specialization, isAvailable } = req.body;

    const vendorProfile = await prisma.vendorProfile.findUnique({
      where: { userId },
    });

    if (!vendorProfile) {
      sendError(res, 'NOT_FOUND', 'Vendor profile not found', 404);
      return;
    }

    const employee = await prisma.employeeProfile.findFirst({
      where: { id, vendorId: vendorProfile.id },
    });

    if (!employee) {
      sendError(res, 'NOT_FOUND', 'Employee not found', 404);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (name || phone) {
        await tx.user.update({
          where: { id: employee.userId },
          data: {
            ...(name ? { name } : {}),
            ...(phone ? { phone } : {}),
          },
        });
      }

      return tx.employeeProfile.update({
        where: { id },
        data: {
          ...(phone ? { phone } : {}),
          ...(specialization ? { specialization } : {}),
          ...(isAvailable !== undefined ? { isAvailable } : {}),
        },
        include: { user: true },
      });
    });

    sendSuccess(res, { employee: updated }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const deleteVendorEmployee = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;

    const vendorProfile = await prisma.vendorProfile.findUnique({
      where: { userId },
    });

    if (!vendorProfile) {
      sendError(res, 'NOT_FOUND', 'Vendor profile not found', 404);
      return;
    }

    const employee = await prisma.employeeProfile.findFirst({
      where: {
        OR: [{ id }, { userId: id }],
        vendorId: vendorProfile.id,
      },
      include: {
        user: true,
        bookings: {
          where: {
            status: { in: ['ASSIGNED', 'IN_PROGRESS', 'ACCEPTED'] as any },
          },
        },
      },
    });

    if (!employee) {
      sendError(res, 'NOT_FOUND', 'Technician/Employee not found or unauthorized', 404);
      return;
    }

    if (employee.bookings.length > 0) {
      sendError(
        res,
        'BAD_REQUEST',
        `Cannot delete expert while they have ${employee.bookings.length} active order(s). Please complete or reassign active orders first.`,
        400
      );
      return;
    }

    if (employee.user.firebaseUid) {
      try {
        await getFirebaseAuth().deleteUser(employee.user.firebaseUid);
      } catch (fbErr: any) {
        console.warn('[Vendor Portal] Notice deleting firebase user:', fbErr?.message || fbErr);
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.booking.updateMany({
        where: { employeeId: employee.id },
        data: { employeeId: null },
      });

      await tx.employeeProfile.delete({
        where: { id: employee.id },
      });

      await tx.user.delete({
        where: { id: employee.userId },
      });
    });

    sendSuccess(res, { message: 'Expert removed successfully' }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

// -------------------------------------------------------------
// Vendor Reviews & Feedback
// -------------------------------------------------------------

export const getVendorReviews = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendorProfile: true, employeeProfile: true },
    });

    let where: any = { isHidden: false };
    if (user?.vendorProfile) {
      where.vendorId = user.vendorProfile.id;
    } else if (user?.employeeProfile) {
      where.OR = [
        { employeeId: user.employeeProfile.id },
        { vendorId: user.employeeProfile.vendorId },
      ];
    } else {
      sendError(res, 'NOT_FOUND', 'Vendor or Employee profile not found', 404);
      return;
    }

    const reviews = await prisma.review.findMany({
      where,
      include: {
        customer: { select: { name: true, profilePhotoUrl: true } },
        service: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    sendSuccess(res, { reviews }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const createVendorInquiry = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { serviceId, preferredDate, message, budget } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendorProfile: true, employeeProfile: true },
    });

    const vendorId = user?.vendorProfile?.id || user?.employeeProfile?.vendorId;
    if (!vendorId) {
      sendError(res, 'NOT_FOUND', 'Vendor or Employee profile not found', 404);
      return;
    }

    let service = serviceId ? await prisma.service.findUnique({ where: { id: serviceId } }) : null;
    if (!service) {
      service = await prisma.service.findFirst({ where: { isActive: true } });
    }

    if (!service) {
      sendError(res, 'NOT_FOUND', 'No active services available', 404);
      return;
    }

    const customerUser = await prisma.user.findFirst({
      where: { role: 'CUSTOMER' },
      include: { customerProfile: true, addresses: true },
    });

    const address = customerUser?.addresses[0] || (await prisma.userAddress.findFirst());
    if (!customerUser?.customerProfile || !address) {
      sendError(res, 'NOT_FOUND', 'Default customer profile or address missing', 404);
      return;
    }

    const bookingCount = await prisma.booking.count();
    const bookingNumber = `#SFX-${100000 + bookingCount + 1}`;

    const newBooking = await prisma.booking.create({
      data: {
        bookingNumber,
        customerId: customerUser.customerProfile.id,
        serviceId: service.id,
        addressId: address.id,
        vendorId,
        employeeId: user?.employeeProfile ? user.employeeProfile.id : null,
        scheduledDate: preferredDate || new Date().toISOString().split('T')[0],
        scheduledTimeSlot: '10:00 AM - 12:00 PM',
        status: 'PENDING',
        basePrice: service.startingPrice,
        taxes: new Prisma.Decimal(0),
        discountAmount: new Prisma.Decimal(0),
        extraCharges: new Prisma.Decimal(0),
        totalAmount: budget ? new Prisma.Decimal(parseFloat(budget.replace(/[^0-9.]/g, '')) || Number(service.startingPrice)) : service.startingPrice,
        notes: message || null,
        statusHistory: {
          create: {
            newStatus: 'PENDING',
            changedBy: userId,
            changedByRole: user?.role as any || 'VENDOR',
            reason: 'Inquiry / Booking order initiated',
          },
        },
      },
      include: {
        customer: { include: { user: true } },
        service: true,
        address: true,
      },
    });

    emitBookingEvent(
      'booking:new',
      {
        bookingId: newBooking.id,
        bookingNumber: newBooking.bookingNumber,
        status: newBooking.status,
        vendorId: newBooking.vendorId,
      },
      [customerUser?.id, userId]
    );

    sendSuccess(res, { order: newBooking }, 201);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const submitVendorFeedback = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { rating, comment, feedbackType, employeeId } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendorProfile: true, employeeProfile: true },
    });

    let targetEmployeeId = employeeId;
    if (!targetEmployeeId) {
      if (user?.employeeProfile) {
        targetEmployeeId = user.employeeProfile.id;
      } else if (user?.vendorProfile) {
        const emp = await prisma.employeeProfile.findFirst({
          where: { vendorId: user.vendorProfile.id },
        });
        targetEmployeeId = emp?.id;
      }
    }

    if (!targetEmployeeId) {
      const emp = await prisma.employeeProfile.findFirst();
      targetEmployeeId = emp?.id;
    }

    if (!targetEmployeeId) {
      sendError(res, 'BAD_REQUEST', 'No employee found for feedback target', 400);
      return;
    }

    const feedback = await prisma.employeeFeedback.create({
      data: {
        employeeId: targetEmployeeId,
        userId,
        rating: rating || 5,
        comment: comment || '',
        feedbackType: feedbackType || 'General Experience',
      },
      include: {
        employee: { include: { user: true } },
        user: true,
      },
    });

    sendSuccess(res, { feedback }, 201);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const getVendorFeedback = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendorProfile: true, employeeProfile: true },
    });

    let where: any = {};
    if (user?.employeeProfile) {
      where = { employeeId: user.employeeProfile.id };
    } else if (user?.vendorProfile) {
      where = { employee: { vendorId: user.vendorProfile.id } };
    }

    const feedback = await prisma.employeeFeedback.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        employee: { include: { user: true } },
        user: true,
      },
    });

    sendSuccess(res, { feedback }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};
