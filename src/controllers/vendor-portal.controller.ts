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
import {
  canSeeExactLocation,
  approximateCoordinate,
  LocationViewerRole,
} from '../services/dispatch.rules';
import { generateStartOtp, isValidStartOtp, normalizeStartOtp, stripStartOtp } from '../utils/start-otp';
import { toMoney, toMoneyOrNull } from '../utils/money';
import { estimatePayloadBytes, MAX_DOCUMENT_BYTES, resolveHostedUrl } from '../utils/cloudinary';
import {
  COMPLETABLE_JOB_STATUSES,
  countValidCompletionPhotos,
  getTestingWorkflowSnapshot,
  hasRequiredCompletionPhotos,
  isTestingWorkflowEnabled,
  MIN_COMPLETION_PHOTOS,
  uniqueHostedImageUrls,
} from '../config/testing-workflow';

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
  fileUrl: z.string().min(5, 'File URL or document data is required'),
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
    otp: z.string().optional(),
    startOtp: z.string().optional(),
  })
  .refine((data) => Boolean(data.otp || data.startOtp || data.token || data.qrToken), {
    message: '4-digit start OTP is required',
    path: ['otp'],
  });

export const createHubBookingSchema = z.object({
  customerName: z.string().min(2),
  customerPhone: z.string().min(10),
  customerEmail: z.string().email().optional(),
  serviceId: z.string().uuid(),
  scheduledDate: z.string().min(1),
  scheduledTimeSlot: z.string().min(1),
  addressLine1: z.string().min(3),
  city: z.string().min(2),
  landmark: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  notes: z.string().optional(),
  source: z.enum(['PHONE_HUB', 'EXPERT_TEAM', 'SALES_MANAGER']).optional(),
  idempotencyKey: z.string().min(8).max(80).optional(),
});

export const uploadCompletionPhotosSchema = z.object({
  image: z.string().min(8).optional(),
  images: z.array(z.string().min(8)).max(12).optional(),
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

const expertKindSchema = z
  .enum(['SALES_MANAGER', 'SERVICE_PROFESSIONAL', 'SALES', 'SERVICE', 'SALES MANAGER', 'SERVICE PROFESSIONAL'])
  .optional();

function normalizeExpertKind(value?: string | null): 'SALES_MANAGER' | 'SERVICE_PROFESSIONAL' {
  const raw = (value || '').toUpperCase().replace(/[\s-]+/g, '_').trim();
  if (raw === 'SALES_MANAGER' || raw === 'SALES') return 'SALES_MANAGER';
  return 'SERVICE_PROFESSIONAL';
}

export const createEmployeeSchema = z.object({
  name: z.string().min(2, 'Employee name is required'),
  email: z.string().email('Valid employee email required'),
  phone: z.string().min(10, 'Valid employee phone required'),
  specialization: z.string().min(2, 'Specialization is required'),
  password: z.string().min(4).optional(),
  expertKind: expertKindSchema,
});

export const updateEmployeeSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().min(10).optional(),
  specialization: z.string().min(2).optional(),
  isAvailable: z.boolean().optional(),
  expertKind: expertKindSchema,
});

const ORDER_LIST_INCLUDE = {
  customer: {
    select: {
      id: true,
      userId: true,
      user: { select: { name: true, phone: true, profilePhotoUrl: true } },
    },
  },
  service: { select: { id: true, name: true, startingPrice: true, durationText: true, imageUrl: true } },
  package: { select: { id: true, name: true, discountedPrice: true, originalPrice: true, duration: true } },
  address: {
    select: {
      id: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      postalCode: true,
      landmark: true,
      latitude: true,
      longitude: true,
    },
  },
  employee: {
    select: {
      id: true,
      userId: true,
      user: { select: { name: true, phone: true } },
    },
  },
  vendor: { select: { id: true, userId: true, companyName: true } },
} as const;

const SAFE_USER_SELECT = { id: true, name: true, phone: true, email: true, profilePhotoUrl: true } as const;

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
              commissionRate: toMoney(15),
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
          expertKind: user.employeeProfile.expertKind,
        },
        expertKind: user.employeeProfile.expertKind,
        workflow: getTestingWorkflowSnapshot(),
      }, 200);
      return;
    }

    const managerUser = await prisma.user.findUnique({
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
        managerProfile: {
          include: {
            vendor: true,
          },
        },
      },
    });

    if (managerUser?.managerProfile) {
      sendSuccess(res, {
        vendor: {
          ...managerUser,
          companyName: managerUser.managerProfile.vendor?.companyName || managerUser.name,
          location: managerUser.managerProfile.city,
          managerKind: managerUser.managerProfile.kind,
          zone: managerUser.managerProfile.zone,
        },
        managerProfile: managerUser.managerProfile,
      }, 200);
      return;
    }

    sendError(res, 'NOT_FOUND', 'Neither vendor, employee, nor manager profile found', 404);
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

    if (estimatePayloadBytes(fileUrl) > MAX_DOCUMENT_BYTES) {
      sendError(res, 'PAYLOAD_TOO_LARGE', 'This document exceeds the 500MB limit.', 413);
      return;
    }

    const hostedUrl = await resolveHostedUrl(fileUrl, 'servfex/documents');
    if (!hostedUrl) {
      sendError(res, 'DOCUMENT_UPLOAD_FAILED', 'Could not store this document. Try a smaller file or a different format.', 400);
      return;
    }

    const document = await prisma.document.create({
      data: {
        userId,
        type: type as DocumentType,
        title,
        fileUrl: hostedUrl,
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
          startingPrice: toMoney(price || customPrice || 499),
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
        customPrice: finalPrice !== undefined ? toMoneyOrNull(finalPrice) : null,
        availability: availability || 'Mon-Sat: 09:00 - 18:00',
        isActive: isActive !== undefined ? isActive : true,
      },
      create: {
        vendorId,
        serviceId: targetServiceId,
        customPrice: finalPrice !== undefined ? toMoneyOrNull(finalPrice) : null,
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
        ...(finalPrice !== undefined ? { customPrice: finalPrice ? toMoney(finalPrice) : null } : {}),
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

async function resolvePortalActor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      name: true,
      vendorProfile: { select: { id: true } },
      employeeProfile: { select: { id: true, vendorId: true, expertKind: true } },
      managerProfile: { select: { id: true, vendorId: true } },
    },
  });
  const vendorId =
    user?.vendorProfile?.id || user?.employeeProfile?.vendorId || user?.managerProfile?.vendorId || null;
  return {
    user,
    vendorId,
    isVendor: !!user?.vendorProfile,
    isManager: user?.role === 'OPERATIONS_MANAGER',
    employeeId: user?.employeeProfile?.id,
    expertKind: user?.employeeProfile?.expertKind || null,
    isSalesManager: user?.employeeProfile?.expertKind === 'SALES_MANAGER',
  };
}

export const getVendorWorkflowConfig = async (_req: Request, res: Response): Promise<void> => {
  sendSuccess(res, { workflow: getTestingWorkflowSnapshot() }, 200);
};

function sanitizeOrderForViewer(order: any, viewer: { isVendor: boolean; employeeId?: string; isManager?: boolean }) {
  if (!order) return order;
  const withoutOtp = stripStartOtp(order);
  const isAssigned = !!viewer.employeeId && order.employeeId === viewer.employeeId;
  const role: LocationViewerRole = viewer.isVendor || viewer.isManager
    ? 'VENDOR_OWNER'
    : isAssigned
      ? 'ASSIGNED_EXPERT'
      : 'OTHER_EXPERT';

  const exactAllowed = canSeeExactLocation(role, order.status);

  if (exactAllowed) {
    return withoutOtp;
  }

  const sanitizedAddress = order.address
    ? {
        ...order.address,
        addressLine1: order.address.city ? `Area near ${order.address.city}` : 'Service Area',
        addressLine2: null,
        landmark: null,
        latitude: approximateCoordinate(order.address.latitude),
        longitude: approximateCoordinate(order.address.longitude),
      }
    : order.address;

  const sanitizedCustomer = order.customer
    ? {
        ...order.customer,
        user: order.customer.user
          ? {
              ...order.customer.user,
              phone: null,
              email: null,
            }
          : order.customer.user,
      }
    : order.customer;

  return stripStartOtp({
    ...withoutOtp,
    address: sanitizedAddress,
    customer: sanitizedCustomer,
  });
}

export const getVendorOrders = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const statusQuery = typeof req.query.status === 'string' ? req.query.status : undefined;
    const page = parseInt(String(req.query.page || '1'), 10) || 1;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const { user, vendorId, isVendor, isManager, employeeId, isSalesManager } = await resolvePortalActor(userId);

    let where: any = {};
    if (isVendor || isManager) {
      if (!vendorId) {
        sendError(res, 'HUB_NOT_ASSIGNED', 'This manager is not assigned to a local provider hub yet', 403);
        return;
      }
      where.vendorId = vendorId;
    } else if (user?.employeeProfile) {
      if (isTestingWorkflowEnabled() && isSalesManager) {
        where = {
          vendorId: user.employeeProfile.vendorId,
          bookingSource: 'SALES_MANAGER',
        };
      } else {
        // Original Service Professional flow: assigned jobs plus unassigned hub jobs to swipe-accept.
        where.OR = [
          { employeeId: user.employeeProfile.id },
          {
            vendorId: user.employeeProfile.vendorId,
            employeeId: null,
            status: { in: ['ASSIGNED', 'PENDING'] },
          },
        ];
      }
    } else {
      sendError(res, 'NOT_FOUND', 'Vendor or Employee profile not found', 404);
      return;
    }

    if (statusQuery) {
      where.status = statusQuery as BookingStatus;
    }

    const orders = await prisma.booking.findMany({
      where,
      take: limit,
      skip,
      orderBy: { scheduledDate: 'desc' },
      include: ORDER_LIST_INCLUDE,
    });

    const viewer = {
      isVendor,
      isManager,
      employeeId,
    };
    const sanitizedOrders = orders.map((o) => sanitizeOrderForViewer(o, viewer));

    sendSuccess(
      res,
      { orders: sanitizedOrders },
      200,
      {
        total: skip + orders.length,
        page,
        limit,
        totalPages: orders.length < limit ? page : page + 1,
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

    const { user, vendorId, isVendor, isManager, employeeId, isSalesManager } = await resolvePortalActor(userId);

    let where: any = { id };
    if (isVendor || isManager) {
      if (!vendorId) {
        sendError(res, 'HUB_NOT_ASSIGNED', 'This manager is not assigned to a local provider hub yet', 403);
        return;
      }
      where.vendorId = vendorId;
    } else if (user?.employeeProfile) {
      if (isTestingWorkflowEnabled() && isSalesManager) {
        where.vendorId = user.employeeProfile.vendorId;
        where.bookingSource = 'SALES_MANAGER';
      } else {
        where.OR = [
          { employeeId: user.employeeProfile.id },
          { vendorId: user.employeeProfile.vendorId },
        ];
      }
    } else {
      sendError(res, 'NOT_FOUND', 'Vendor or Employee profile not found', 404);
      return;
    }

    const order = await prisma.booking.findFirst({
      where,
      include: ORDER_LIST_INCLUDE,
    });

    if (!order) {
      sendError(res, 'NOT_FOUND', 'Order not found', 404);
      return;
    }

    const viewer = {
      isVendor,
      isManager,
      employeeId,
    };
    const sanitizedOrder = sanitizeOrderForViewer(order, viewer);

    sendSuccess(res, { order: sanitizedOrder }, 200);
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
      select: {
        id: true,
        role: true,
        name: true,
        vendorProfile: { select: { id: true } },
        employeeProfile: { select: { id: true, vendorId: true, expertKind: true } },
      },
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
      if (isTestingWorkflowEnabled() && user.employeeProfile.expertKind === 'SALES_MANAGER') {
        sendError(res, 'FORBIDDEN', 'Sales Managers cannot accept or complete service jobs', 403);
        return;
      }
      if (status === 'COMPLETED' || status === 'AWAITING_CUSTOMER_CONFIRMATION' || status === 'IN_PROGRESS') {
        sendError(
          res,
          'INVALID_TRANSITION',
          status === 'IN_PROGRESS'
            ? 'Use the start OTP endpoint to begin work'
            : 'Swipe to complete and upload at least 4 photographs',
          400
        );
        return;
      }
      if (status === 'ACCEPTED') {
        await acceptAssignment(userId, id);
        const order = await prisma.booking.findUnique({
          where: { id },
          include: ORDER_LIST_INCLUDE,
        });
        sendSuccess(res, { order }, 200);
        return;
      }
      if (status === 'REJECTED' || status === 'DECLINED') {
        await rejectAssignment(userId, id, note);
        const order = await prisma.booking.findUnique({
          where: { id },
          include: ORDER_LIST_INCLUDE,
        });
        sendSuccess(res, { order }, 200);
        return;
      }
      if (status === 'ON_THE_WAY' || status === 'ARRIVED') {
        await advanceTravelStatus(userId, id, status);
        const order = await prisma.booking.findUnique({
          where: { id },
          include: ORDER_LIST_INCLUDE,
        });
        sendSuccess(res, { order }, 200);
        return;
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.booking.findUnique({
        where: { id },
        include: ORDER_LIST_INCLUDE,
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
        include: ORDER_LIST_INCLUDE,
      });

      // If employee accepted the order, notify Vendor & Customer
      if (status === 'ACCEPTED' && user?.employeeProfile) {
        if (current.vendor?.userId) {
          await tx.notification.create({
            data: {
              title: `Job Accepted #${b.bookingNumber}`,
              message: `Expert ${user.name} has accepted order #${b.bookingNumber} (${current.service.name}).`,
              target: 'SPECIFIC_USER',
              targetUserId: current.vendor.userId,
            },
          });
        }
        if (current.customer?.userId) {
          await tx.notification.create({
            data: {
              title: `Service Confirmed #${b.bookingNumber}`,
              message: `Expert ${user.name} has accepted your booking for ${current.service.name}.`,
              target: 'SPECIFIC_USER',
              targetUserId: current.customer.userId,
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

export const verifyOrderOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const token = normalizeStartOtp(req.body.otp || req.body.startOtp || req.body.token || req.body.qrToken);

    const { user, vendorId } = await resolvePortalActor(userId);

    let booking;
    if (vendorId && (user?.vendorProfile || user?.managerProfile)) {
      booking = await prisma.booking.findFirst({
        where: { id, vendorId },
      });
    } else if (user?.employeeProfile) {
      booking = await prisma.booking.findFirst({
        where: isTestingWorkflowEnabled()
          ? { id, employeeId: user.employeeProfile.id }
          : {
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

    if (isTestingWorkflowEnabled() && user?.employeeProfile?.expertKind === 'SALES_MANAGER') {
      sendError(res, 'FORBIDDEN', 'Sales Managers cannot start service jobs', 403);
      return;
    }

    if (!isValidStartOtp(token)) {
      sendError(res, 'INVALID_OTP', 'Enter the 4-digit start OTP shown on the customer app', 400);
      return;
    }

    if (!booking.qrChallengeToken) {
      sendError(res, 'BAD_REQUEST', 'No start OTP is active for this order. Ask the customer to open the booking in their app', 400);
      return;
    }

    if (booking.qrVerifiedAt) {
      sendError(res, 'BAD_REQUEST', 'This service has already been OTP-verified and started', 400);
      return;
    }

    if (booking.qrChallengeToken !== token) {
      sendError(res, 'INVALID_OTP', 'Start OTP does not match this booking. Ask the customer for the 4-digit code', 400);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      return tx.booking.update({
        where: { id },
        data: {
          status: 'IN_PROGRESS',
          qrVerifiedAt: new Date(),
          qrChallengeToken: null,
          statusHistory: {
            create: {
              oldStatus: booking.status,
              newStatus: 'IN_PROGRESS',
              changedBy: userId,
              changedByRole: (user?.role as any) || 'EMPLOYEE',
              reason: 'Customer start OTP verified on site. Work officially commenced.',
            },
          },
        },
        include: ORDER_LIST_INCLUDE,
      });
    });

    void emitBookingRefresh(id);
    sendSuccess(res, { order: stripStartOtp(updated), message: 'OTP verified successfully. Service is now IN PROGRESS.' }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

/** @deprecated alias — QR start verification was replaced with a 4-digit OTP. */
export const verifyOrderQr = verifyOrderOtp;

export const uploadOrderCompletionPhotos = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const payloads: string[] = [];
    if (typeof req.body?.image === 'string') payloads.push(req.body.image);
    if (Array.isArray(req.body?.images)) payloads.push(...req.body.images.filter((v: unknown) => typeof v === 'string'));

    if (payloads.length === 0) {
      sendError(res, 'BAD_REQUEST', 'At least one image is required', 400);
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { employeeProfile: true },
    });
    if (!user?.employeeProfile) {
      sendError(res, 'FORBIDDEN', 'Only the assigned Service Professional can upload completion photographs', 403);
      return;
    }
    if (isTestingWorkflowEnabled() && user.employeeProfile.expertKind === 'SALES_MANAGER') {
      sendError(res, 'FORBIDDEN', 'Sales Managers cannot upload service completion photographs', 403);
      return;
    }

    const booking = await prisma.booking.findFirst({
      where: { id, employeeId: user.employeeProfile.id },
    });
    if (!booking) {
      sendError(res, 'NOT_FOUND', 'Order not found or not assigned to you', 404);
      return;
    }
    if (!(COMPLETABLE_JOB_STATUSES as readonly string[]).includes(booking.status)) {
      sendError(res, 'BAD_REQUEST', `Cannot upload completion photographs while the job is ${booking.status}`, 400);
      return;
    }

    const hosted: string[] = [];
    for (const payload of payloads) {
      if (estimatePayloadBytes(payload) > MAX_DOCUMENT_BYTES) {
        sendError(res, 'PAYLOAD_TOO_LARGE', 'Each photograph must be 500MB or smaller', 413);
        return;
      }
      const url = await resolveHostedUrl(payload, 'servfex/completions');
      if (url) hosted.push(url);
    }
    if (hosted.length === 0) {
      sendError(res, 'IMAGE_UPLOAD_FAILED', 'Photographs could not be hosted. Retry the upload.', 400);
      return;
    }

    const merged = uniqueHostedImageUrls([...(booking.completionPhotoUrls || []), ...hosted]);
    const updated = await prisma.booking.update({
      where: { id },
      data: { completionPhotoUrls: merged },
      select: {
        id: true,
        status: true,
        completionPhotoUrls: true,
      },
    });

    sendSuccess(res, {
      orderId: updated.id,
      photoUrls: updated.completionPhotoUrls,
      count: countValidCompletionPhotos(updated.completionPhotoUrls),
      required: MIN_COMPLETION_PHOTOS,
      readyToComplete: hasRequiredCompletionPhotos(updated.completionPhotoUrls),
    }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const completeOrder = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const { note, completionNotes } = req.body || {};
    const completionReason = note || completionNotes;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendorProfile: true, employeeProfile: true },
    });

    if (isTestingWorkflowEnabled() && user?.employeeProfile?.expertKind === 'SALES_MANAGER') {
      sendError(res, 'FORBIDDEN', 'Sales Managers cannot complete service jobs', 403);
      return;
    }

    let booking;
    if (user?.vendorProfile && !isTestingWorkflowEnabled()) {
      booking = await prisma.booking.findFirst({
        where: { id, vendorId: user.vendorProfile.id },
      });
    } else if (user?.employeeProfile) {
      booking = await prisma.booking.findFirst({
        where: { id, employeeId: user.employeeProfile.id },
      });
    }

    if (!booking) {
      sendError(res, 'NOT_FOUND', 'Order not found or unauthorized', 404);
      return;
    }

    if (
      booking.status === 'AWAITING_CUSTOMER_CONFIRMATION' ||
      booking.status === 'AWAITING_PAYMENT' ||
      booking.status === 'COMPLETED'
    ) {
      sendSuccess(res, {
        order: booking,
        message: 'Completion already submitted.',
        alreadyCompleted: true,
      }, 200);
      return;
    }

    if (!(COMPLETABLE_JOB_STATUSES as readonly string[]).includes(booking.status)) {
      sendError(res, 'BAD_REQUEST', `Cannot complete order in ${booking.status} status.`, 400);
      return;
    }

    if (booking.status !== 'IN_PROGRESS') {
      sendError(res, 'BAD_REQUEST', `Cannot complete order in ${booking.status} status. Job must be IN_PROGRESS.`, 400);
      return;
    }
    if (!booking.qrVerifiedAt) {
      sendError(res, 'BAD_REQUEST', 'Cannot complete order without verified start OTP', 400);
      return;
    }

    if (!hasRequiredCompletionPhotos(booking.completionPhotoUrls)) {
      sendError(
        res,
        'COMPLETION_PHOTOS_REQUIRED',
        `Upload at least ${MIN_COMPLETION_PHOTOS} completion photographs before finishing this job. Currently ${countValidCompletionPhotos(booking.completionPhotoUrls)} valid photograph(s) are stored.`,
        400
      );
      return;
    }

    try {
      await prisma.$transaction(async (tx) => {
        const current = await tx.booking.findUnique({ where: { id } });
        if (!current) throw Object.assign(new Error('Order not found'), { code: 'NOT_FOUND' });
        if (
          current.status === 'AWAITING_CUSTOMER_CONFIRMATION' ||
          current.status === 'AWAITING_PAYMENT' ||
          current.status === 'COMPLETED'
        ) {
          return;
        }
        if (!(COMPLETABLE_JOB_STATUSES as readonly string[]).includes(current.status)) {
          throw Object.assign(new Error(`Cannot complete order in ${current.status} status.`), { code: 'BAD_REQUEST' });
        }
        if (current.status !== 'IN_PROGRESS') {
          throw Object.assign(new Error(`Cannot complete order in ${current.status} status.`), { code: 'BAD_REQUEST' });
        }
        if (!current.qrVerifiedAt) {
          throw Object.assign(new Error('Cannot complete order without verified start OTP'), { code: 'BAD_REQUEST' });
        }
        if (!hasRequiredCompletionPhotos(current.completionPhotoUrls)) {
          throw Object.assign(
            new Error(`Upload at least ${MIN_COMPLETION_PHOTOS} completion photographs before finishing this job.`),
            { code: 'COMPLETION_PHOTOS_REQUIRED' }
          );
        }

        const flipped = await tx.booking.updateMany({
          where: {
            id,
            status: { in: [...COMPLETABLE_JOB_STATUSES] as BookingStatus[] },
          },
          data: {
            status: 'AWAITING_CUSTOMER_CONFIRMATION',
            completionRequestedAt: new Date(),
          },
        });
        if (flipped.count !== 1) {
          throw Object.assign(new Error('Completion changed while submitting. Please refresh.'), { code: 'ASSIGNMENT_CONFLICT' });
        }

        await tx.bookingStatusHistory.create({
          data: {
            bookingId: id,
            oldStatus: current.status,
            newStatus: 'AWAITING_CUSTOMER_CONFIRMATION',
            changedBy: userId,
            changedByRole: (user?.role as any) || 'EMPLOYEE',
            reason: completionReason || 'Technician completed service delivery. Awaiting customer confirmation.',
          },
        });
      }, { maxWait: 20_000, timeout: 45_000 });
    } catch (err: any) {
      if (err.code === 'COMPLETION_PHOTOS_REQUIRED' || err.code === 'BAD_REQUEST' || err.code === 'ASSIGNMENT_CONFLICT' || err.code === 'NOT_FOUND') {
        sendError(res, err.code, err.message, err.code === 'ASSIGNMENT_CONFLICT' ? 409 : err.code === 'NOT_FOUND' ? 404 : 400);
        return;
      }
      if (err.code === 'P2028' || err.code === 'P2034' || /transaction/i.test(String(err.message || ''))) {
        sendError(res, 'TIMEOUT', 'Completion timed out. Photographs are already saved — tap Submit again.', 503);
        return;
      }
      sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
      return;
    }

    const updated = await prisma.booking.findUnique({
      where: { id },
      include: {
        customer: { include: { user: { select: SAFE_USER_SELECT } } },
        service: { select: { id: true, name: true } },
        address: true,
        employee: { include: { user: { select: { name: true, phone: true } } } },
      },
    });

    void emitBookingRefresh(id);
    sendSuccess(res, { order: updated, message: 'Completion submitted. Awaiting customer confirmation.' }, 200);
  } catch (err: any) {
    if (err.code === 'COMPLETION_PHOTOS_REQUIRED' || err.code === 'BAD_REQUEST' || err.code === 'ASSIGNMENT_CONFLICT') {
      sendError(res, err.code, err.message, err.code === 'ASSIGNMENT_CONFLICT' ? 409 : 400);
      return;
    }
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

    const collectedAmount = toMoney(amount ?? booking.totalAmount);
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

    if (isTestingWorkflowEnabled() && !employeeId) {
      sendError(res, 'BAD_REQUEST', 'Select a Service Professional to assign this booking', 400);
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
      if (isTestingWorkflowEnabled() && employee.expertKind === 'SALES_MANAGER') {
        sendError(res, 'EXPERT_NOT_ELIGIBLE', 'A Sales Manager cannot be assigned a service job', 400);
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
        updateData.expertPayout = toMoney(resolvedPayout);
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

    const eligibleOnly = String(req.query.eligibleForAssignment || '') === 'true';
    const employees = await prisma.employeeProfile.findMany({
      where: {
        vendorId: vendorProfile.id,
        ...(isTestingWorkflowEnabled() && eligibleOnly ? { expertKind: 'SERVICE_PROFESSIONAL' } : {}),
      },
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
    const { name, email, phone, specialization, password, expertKind } = req.body;
    const resolvedExpertKind = normalizeExpertKind(expertKind);

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
              expertKind: resolvedExpertKind,
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
    const { name, phone, specialization, isAvailable, expertKind } = req.body;

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
          ...(expertKind ? { expertKind: normalizeExpertKind(expertKind) } : {}),
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
        basePrice: toMoney(service.startingPrice),
        taxes: toMoney(0),
        discountAmount: toMoney(0),
        extraCharges: toMoney(0),
        totalAmount: budget
          ? toMoney(parseFloat(budget.replace(/[^0-9.]/g, '')) || Number(service.startingPrice))
          : toMoney(service.startingPrice),
        notes: message || null,
        bookingSource: user?.employeeProfile ? 'EXPERT_TEAM' : 'EXPERT_TEAM',
        qrChallengeToken: generateStartOtp(),
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

    sendSuccess(res, { order: stripStartOtp(newBooking) }, 201);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const createHubBooking = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const {
      customerName,
      customerPhone,
      customerEmail,
      serviceId,
      scheduledDate,
      scheduledTimeSlot,
      addressLine1,
      city,
      landmark,
      latitude,
      longitude,
      notes,
      source,
    } = req.body;

    const { user, vendorId, isManager, isVendor } = await resolvePortalActor(userId);
    if (!vendorId || (!isManager && !isVendor && !user?.employeeProfile)) {
      sendError(res, 'FORBIDDEN', 'Only a hub manager, provider, or expert can create a desk booking', 403);
      return;
    }

    if (isTestingWorkflowEnabled() && source === 'SALES_MANAGER' && user?.employeeProfile?.expertKind !== 'SALES_MANAGER' && !isVendor && !isManager) {
      sendError(res, 'FORBIDDEN', 'Only a Sales Manager can create Sales Manager bookings', 403);
      return;
    }

    if (source === 'SALES_MANAGER' && !customerEmail) {
      sendError(res, 'BAD_REQUEST', 'Customer email is required for Sales Manager bookings', 400);
      return;
    }

    const service = await prisma.service.findFirst({
      where: { id: serviceId, isActive: true, deletedAt: null },
    });
    if (!service) {
      sendError(res, 'NOT_FOUND', 'Service not found or inactive', 404);
      return;
    }

    const cleanPhone = String(customerPhone).replace(/\s+/g, '');
    const cleanEmail = (customerEmail || `${cleanPhone.replace(/\D/g, '')}@hub.servfex.local`).toLowerCase().trim();

    const customerUser = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findFirst({
        where: {
          deletedAt: null,
          role: 'CUSTOMER',
          OR: [{ phone: cleanPhone }, { email: cleanEmail }],
        },
        include: { customerProfile: true, addresses: true },
      });

      if (existing) {
        if (!existing.customerProfile) {
          await tx.customerProfile.create({ data: { userId: existing.id } });
        }
        return tx.user.findUniqueOrThrow({
          where: { id: existing.id },
          include: { customerProfile: true, addresses: true },
        });
      }

      return tx.user.create({
        data: {
          name: customerName,
          email: cleanEmail,
          phone: cleanPhone,
          role: 'CUSTOMER',
          status: 'ACTIVE',
          isVerified: true,
          customerProfile: { create: {} },
        },
        include: { customerProfile: true, addresses: true },
      });
    });

    const recentDuplicate = await prisma.booking.findFirst({
      where: {
        vendorId,
        customerId: customerUser.customerProfile!.id,
        serviceId: service.id,
        scheduledDate,
        createdAt: { gte: new Date(Date.now() - 2 * 60 * 1000) },
        status: { notIn: ['CANCELLED', 'DECLINED'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (recentDuplicate) {
      sendSuccess(res, { order: stripStartOtp(recentDuplicate), duplicate: true }, 200);
      return;
    }

    const address = await prisma.userAddress.create({
      data: {
        userId: customerUser.id,
        label: 'Service Address',
        addressLine1,
        city,
        state: city,
        postalCode: '000000',
        landmark: landmark || null,
        latitude: latitude ?? null,
        longitude: longitude ?? null,
        isDefault: customerUser.addresses.length === 0,
      },
    });

    const bookingNumber = `SFX-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
    const bookingSource =
      source === 'SALES_MANAGER' ? 'SALES_MANAGER' : source === 'EXPERT_TEAM' ? 'EXPERT_TEAM' : 'PHONE_HUB';

    const booking = await prisma.booking.create({
      data: {
        bookingNumber,
        customerId: customerUser.customerProfile!.id,
        serviceId: service.id,
        addressId: address.id,
        vendorId,
        scheduledDate,
        scheduledTimeSlot,
        status: 'PENDING',
        basePrice: toMoney(service.startingPrice),
        taxes: toMoney(0),
        totalAmount: toMoney(service.startingPrice),
        notes: notes || null,
        bookingSource,
        qrChallengeToken: generateStartOtp(),
        statusHistory: {
          create: {
            newStatus: 'PENDING',
            changedBy: userId,
            changedByRole: (user?.role as any) || 'OPERATIONS_MANAGER',
            reason:
              bookingSource === 'SALES_MANAGER'
                ? 'Sales Manager created this customer booking'
                : bookingSource === 'PHONE_HUB'
                  ? 'Phone / hub desk booking created by Operations Manager'
                  : 'Expert team created this booking after a customer visit',
          },
        },
      },
      include: {
        customer: { include: { user: { select: { name: true, phone: true } } } },
        service: true,
        address: true,
      },
    });

    const vendorOwner = await prisma.vendorProfile.findUnique({
      where: { id: vendorId },
      select: { userId: true },
    });
    emitBookingEvent(
      'booking:new',
      {
        bookingId: booking.id,
        bookingNumber: booking.bookingNumber,
        status: booking.status,
        vendorId: booking.vendorId,
      },
      [customerUser.id, userId, vendorOwner?.userId].filter(Boolean) as string[]
    );

    sendSuccess(res, { order: stripStartOtp(booking) }, 201);
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
