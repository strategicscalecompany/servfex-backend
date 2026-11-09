import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendSuccess, sendError } from '../utils/response';
import { emitBookingRefresh, emitBookingEvent, emitUserEvent } from '../utils/realtime';
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
import { generateStartOtp, stripStartOtp } from '../utils/start-otp';
import {
  beginWorkAfterBeforePhotos,
  computeShiftTiming,
  setLocationSharing,
  verifyStartOtpForExpert,
} from '../services/execution.service';
import { isValidUpiId, normalizeUpiId } from '../utils/upi';
import { asDecimal, sumMoney, toMoney, toMoneyOrNull } from '../utils/money';
import { sendPushToUserIds } from '../services/push.service';
import { env } from '../config/env';
import { estimatePayloadBytes, MAX_DOCUMENT_BYTES, resolveHostedUrl } from '../utils/cloudinary';
import { invalidateCatalogCache } from './catalog.controller';
import {
  BEFORE_PHOTO_ELIGIBLE_STATUSES,
  COMPLETABLE_JOB_STATUSES,
  countValidBeforePhotos,
  countValidCompletionPhotos,
  getTestingWorkflowSnapshot,
  hasRequiredBeforePhotos,
  hasRequiredCompletionPhotos,
  isTestingWorkflowEnabled,
  MIN_BEFORE_PHOTOS,
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
  acceptingRequests: z.boolean().optional(),
  upiId: z.string().min(5).max(320).optional(),
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
  // Up to 30 days when professional schedules multi-day arrival (minutes / hours / calendar date).
  etaMinutes: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? undefined : val),
    z.coerce
      .number({ invalid_type_error: 'ETA must be a number of minutes' })
      .int()
      .min(1, 'ETA must be at least 1 minute')
      .max(43_200, 'ETA cannot exceed 30 days')
      .optional()
  ),
  // Live GPS used when marking ARRIVED (Rapido-style doorstep geofence).
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  helperEmployeeId: z.string().uuid().optional().nullable(),
  helperPayoutAmount: z.number().min(0).optional(),
  leadPayoutAmount: z.number().min(0).optional(),
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

export const createHubBookingSchema = z
  .object({
    customerName: z.string().min(2),
    customerPhone: z.string().min(10),
    customerEmail: z.union([z.string().email(), z.literal('')]).optional(),
    serviceId: z.union([z.string().uuid(), z.literal('')]).optional(),
    serviceName: z.string().min(2).optional(),
    scheduledDate: z.string().min(1).optional(),
    scheduledTimeSlot: z.string().min(1).optional(),
    addressLine1: z.string().min(3),
    city: z.string().optional(),
    landmark: z.string().optional(),
    mapsUrl: z.string().optional(),
    latitude: z.number(),
    longitude: z.number(),
    notes: z.string().optional(),
    source: z.enum(['PHONE_HUB', 'EXPERT_TEAM', 'SALES_MANAGER']).optional(),
    vendorId: z.string().uuid().optional(),
    employeeId: z.union([z.string().uuid(), z.literal('')]).optional(),
    idempotencyKey: z.string().min(8).max(80).optional(),
  })
  .refine((data) => Boolean(data.serviceId || data.serviceName), {
    message: 'Select a matching service or type a new service name to publish',
    path: ['serviceName'],
  });

export const uploadCompletionPhotosSchema = z.object({
  image: z.string().min(8).optional(),
  images: z.array(z.string().min(8)).max(12).optional(),
});

export const uploadBeforePhotosSchema = uploadCompletionPhotosSchema;

export const recordCashSchema = z.object({
  amount: z.number().positive().optional(),
});

export const assignEmployeeOrderSchema = z.object({
  employeeId: z.string().optional().nullable(),
  expertPayout: z.number().positive().optional(),
  payout: z.number().positive().optional(),
  note: z.string().optional(),
  instructions: z.string().optional(),
  // Provider sets arrival promise at assign time (hours/days → minutes). Required when assigning a WP.
  etaMinutes: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? undefined : val),
    z.coerce
      .number({ invalid_type_error: 'ETA must be a number of minutes' })
      .int()
      .min(60, 'ETA must be at least 1 hour')
      .max(43_200, 'ETA cannot exceed 30 days')
      .optional()
  ),
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
  acceptingRequests: z.boolean().optional(),
  upiId: z.string().min(5).max(320).optional(),
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
  helperEmployee: {
    select: {
      id: true,
      userId: true,
      user: { select: { name: true, phone: true } },
    },
  },
  vendor: {
    select: {
      id: true,
      userId: true,
      companyName: true,
      warehousePhone: true,
      latitude: true,
      longitude: true,
      serviceRadiusKm: true,
      user: { select: { phone: true, name: true } },
      managers: {
        where: { kind: 'OPERATIONS' },
        take: 3,
        select: { user: { select: { phone: true, name: true } } },
      },
    },
  },
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
            ...(req.body.acceptingRequests !== undefined ? { acceptingRequests: req.body.acceptingRequests } : {}),
            ...(req.body.upiId !== undefined
              ? { upiId: isValidUpiId(req.body.upiId) ? normalizeUpiId(req.body.upiId) : undefined }
              : {}),
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
    const actor = await resolvePortalActor(req.user!.userId);
    const hubs = await assignedHubsForActor(actor);
    const hubIds = hubs.map((h) => h.id);
    const vendorId = actor.vendorId || hubIds[0] || null;
    if (!vendorId && hubIds.length === 0) {
      sendError(res, 'NOT_FOUND', 'Vendor, employee, or hub manager profile not found', 404);
      return;
    }

    const services = await prisma.vendorService.findMany({
      where: {
        vendorId: hubIds.length > 1 ? { in: hubIds } : vendorId!,
        isActive: true,
        service: {
          isActive: true,
          deletedAt: null,
        },
      },
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

    invalidateCatalogCache();
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

    invalidateCatalogCache();
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

    invalidateCatalogCache();
    sendSuccess(res, null, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

// -------------------------------------------------------------
// Vendor Orders & Dispatch
// -------------------------------------------------------------

const hubSelect = {
  id: true,
  companyName: true,
  warehouseName: true,
  location: true,
  warehouseLocation: true,
  userId: true,
} as const;

const HUB_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function resolvePortalActor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      name: true,
      vendorProfile: { select: hubSelect },
      employeeProfile: {
        select: {
          id: true,
          vendorId: true,
          expertKind: true,
          vendor: { select: hubSelect },
        },
      },
      managerProfile: {
        select: {
          id: true,
          vendorId: true,
          zone: true,
          city: true,
          shiftHours: true,
          vendor: { select: hubSelect },
        },
      },
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

function formatHubOption(hub: {
  id: string;
  companyName: string;
  warehouseName?: string | null;
  location: string;
  warehouseLocation?: string | null;
}) {
  return {
    id: hub.id,
    name: hub.warehouseName || hub.companyName,
    location: hub.warehouseLocation || hub.location,
  };
}

/** Resolve all hubs for the portal actor (HOM multi-hub via vendorId + zone CSV names/UUIDs). */
async function assignedHubsForActor(actor: Awaited<ReturnType<typeof resolvePortalActor>>) {
  const hubs = new Map<string, ReturnType<typeof formatHubOption>>();
  const push = (
    hub?: {
      id: string;
      companyName: string;
      warehouseName?: string | null;
      location: string;
      warehouseLocation?: string | null;
    } | null
  ) => {
    if (!hub) return;
    hubs.set(hub.id, formatHubOption(hub));
  };
  push(actor.user?.vendorProfile || null);
  push(actor.user?.employeeProfile?.vendor || null);
  push(actor.user?.managerProfile?.vendor || null);

  if (actor.isManager) {
    const zone = actor.user?.managerProfile?.zone || '';
    const parts = zone
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 0 || actor.user?.managerProfile?.vendorId) {
      const vendors = await prisma.vendorProfile.findMany({ select: hubSelect });
      const byId = new Map(vendors.map((v) => [v.id, v]));
      const byName = new Map<string, (typeof vendors)[number]>();
      for (const v of vendors) {
        if (v.warehouseName) byName.set(v.warehouseName.trim().toLowerCase(), v);
        if (v.companyName) byName.set(v.companyName.trim().toLowerCase(), v);
      }
      if (actor.user?.managerProfile?.vendorId) {
        push(byId.get(actor.user.managerProfile.vendorId) || null);
      }
      for (const part of parts) {
        if (HUB_UUID_RE.test(part)) {
          push(byId.get(part) || null);
        } else {
          push(byName.get(part.toLowerCase()) || null);
        }
      }
    }
  }

  return Array.from(hubs.values());
}

/** Resolve a hub-assigned catalog service + effective sell price (customPrice or catalog base). */
async function resolveAssignedHubService(
  serviceId: string | undefined,
  serviceName: string | undefined,
  vendorId: string
): Promise<{ service: { id: string; name: string; startingPrice: string }; price: string } | null> {
  const toEffective = (row: {
    customPrice: string | null;
    service: { id: string; name: string; startingPrice: string };
  }) => ({
    service: row.service,
    price: row.customPrice && String(row.customPrice).trim() !== '' ? toMoney(row.customPrice) : toMoney(row.service.startingPrice),
  });

  if (serviceId) {
    const assigned = await prisma.vendorService.findFirst({
      where: {
        vendorId,
        serviceId,
        isActive: true,
        service: { isActive: true, deletedAt: null },
      },
      include: { service: true },
    });
    if (assigned?.service) return toEffective(assigned);
  }

  const trimmedName = (serviceName || '').trim();
  if (!trimmedName) return null;

  const assignedByName = await prisma.vendorService.findFirst({
    where: {
      vendorId,
      isActive: true,
      service: {
        isActive: true,
        deletedAt: null,
        name: { equals: trimmedName, mode: 'insensitive' },
      },
    },
    include: { service: true },
  });

  return assignedByName?.service ? toEffective(assignedByName) : null;
}

function cityFromAddress(addressLine1: string, city?: string): string {
  if (city && city.trim().length >= 2) return city.trim();
  const parts = addressLine1.split(',').map((part) => part.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0] || 'Hyderabad';
}

export const getVendorWorkflowConfig = async (_req: Request, res: Response): Promise<void> => {
  sendSuccess(res, { workflow: getTestingWorkflowSnapshot() }, 200);
};

export const getDeskContext = async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = await resolvePortalActor(req.user!.userId);
    if (!actor.user || (!actor.isManager && !actor.isVendor && !actor.user.employeeProfile)) {
      sendError(res, 'FORBIDDEN', 'Only a hub manager, provider, or expert can open the desk order form', 403);
      return;
    }

    const hubs = await assignedHubsForActor(actor);
    let technicians: Array<{
      id: string;
      name: string;
      phone: string;
      vendorId: string;
      ongoingOrderCount: number;
      isOnline: boolean;
      isAvailable: boolean;
      acceptingRequests: boolean;
    }> = [];

    if ((actor.isSalesManager || actor.isManager || actor.isVendor) && actor.vendorId) {
      const technicianHubIds = actor.isManager ? hubs.map((h) => h.id) : [actor.vendorId];
      const employees = await prisma.employeeProfile.findMany({
        where: {
          vendorId: { in: technicianHubIds },
          expertKind: 'SERVICE_PROFESSIONAL',
          user: { status: 'ACTIVE', deletedAt: null },
        },
        include: {
          user: { select: { name: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      const ongoingStatuses = [
        'ACCEPTED',
        'ASSIGNED',
        'ON_THE_WAY',
        'ARRIVED',
        'IN_PROGRESS',
        'AWAITING_CUSTOMER_CONFIRMATION',
        'AWAITING_PAYMENT',
      ] as const;
      const employeeIds = employees.map((emp) => emp.id);
      const ongoingCounts = new Map<string, number>();
      if (employeeIds.length > 0) {
        const ongoingBookings = await prisma.booking.findMany({
          where: {
            status: { in: [...ongoingStatuses] },
            OR: [{ employeeId: { in: employeeIds } }, { helperEmployeeId: { in: employeeIds } }],
          },
          select: { employeeId: true, helperEmployeeId: true },
        });
        for (const booking of ongoingBookings) {
          if (booking.employeeId && employeeIds.includes(booking.employeeId)) {
            ongoingCounts.set(booking.employeeId, (ongoingCounts.get(booking.employeeId) || 0) + 1);
          }
          if (
            booking.helperEmployeeId &&
            employeeIds.includes(booking.helperEmployeeId) &&
            booking.helperEmployeeId !== booking.employeeId
          ) {
            ongoingCounts.set(
              booking.helperEmployeeId,
              (ongoingCounts.get(booking.helperEmployeeId) || 0) + 1
            );
          }
        }
      }

      technicians = employees.map((emp) => {
        const isAvailable = emp.isAvailable !== false;
        const acceptingRequests = emp.acceptingRequests !== false;
        const checkedIn = Boolean(emp.hubCheckedInAt);
        return {
          id: emp.id,
          name: emp.user.name,
          phone: emp.phone || emp.user.phone || '',
          vendorId: emp.vendorId,
          ongoingOrderCount: ongoingCounts.get(emp.id) || 0,
          isAvailable,
          acceptingRequests,
          // Assignable only when checked in at hub AND online
          isOnline: checkedIn && isAvailable && acceptingRequests,
          checkedIn,
          isLateWorker: checkedIn && Boolean(emp.lateWorkerFlaggedAt),
          lastLatitude: emp.lastLatitude ?? null,
          lastLongitude: emp.lastLongitude ?? null,
          lastLocationAt: emp.lastLocationAt ?? null,
        };
      });
    }

    sendSuccess(res, {
      role: actor.isSalesManager ? 'SALES_MANAGER' : actor.isManager ? 'OPERATIONS_MANAGER' : 'VENDOR',
      hubs,
      technicians,
      canAssignHub: actor.isManager,
      canAssignTechnician: actor.isSalesManager || actor.isManager,
    });
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

/** Rolling 30-day hub metrics for Hub Operation Manager (HOM) portal dashboard. */
export const getManagerDashboard = async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = await resolvePortalActor(req.user!.userId);
    if (!actor.isManager) {
      sendError(res, 'FORBIDDEN', 'Only Hub Operation Managers can open this dashboard', 403);
      return;
    }

    const hubs = await assignedHubsForActor(actor);
    const hubIds = hubs.map((h) => h.id);
    if (hubIds.length === 0) {
      sendError(res, 'HUB_NOT_ASSIGNED', 'This manager is not assigned to a local provider hub yet', 403);
      return;
    }

    const since = new Date();
    since.setDate(since.getDate() - 30);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [employeeCount, servicesCount, bookings, openBookingsCount, escalations, crewToday] =
      await Promise.all([
        prisma.employeeProfile.count({
          where: { vendorId: { in: hubIds }, user: { deletedAt: null } },
        }),
        prisma.vendorService.count({
          where: { vendorId: { in: hubIds }, isActive: true, service: { isActive: true, deletedAt: null } },
        }),
        prisma.booking.findMany({
          where: { vendorId: { in: hubIds }, createdAt: { gte: since } },
          select: { status: true, totalAmount: true, paymentStatus: true },
        }),
        prisma.booking.count({
          where: {
            vendorId: { in: hubIds },
            status: { notIn: ['COMPLETED', 'CANCELLED'] },
          },
        }),
        prisma.escalationTicket.findMany({
          where: {
            createdAt: { gte: since },
            booking: { vendorId: { in: hubIds } },
          },
          select: { status: true },
        }),
        prisma.employeeProfile.findMany({
          where: {
            vendorId: { in: hubIds },
            user: { deletedAt: null },
            OR: [
              { hubCheckedInAt: { not: null } },
              { lastHubCheckInAt: { gte: startOfToday } },
              { lastHubCheckOutAt: { gte: startOfToday } },
            ],
          },
          select: {
            id: true,
            hubCheckedInAt: true,
            hubCheckedOutAt: true,
            lastHubCheckInAt: true,
            lastHubCheckOutAt: true,
            completedJobs: true,
            user: { select: { name: true, phone: true } },
          },
          orderBy: { hubCheckedInAt: 'desc' },
        }),
      ]);

    const thirtyDaysJobs = bookings.length;
    const completedOrPaid = bookings.filter(
      (b) => b.status === 'COMPLETED' || b.paymentStatus === 'PAID'
    );
    const earnings = sumMoney(completedOrPaid.map((b) => b.totalAmount));
    const complaintsCount = escalations.length;
    const unresolvedComplaints = escalations.filter((e) =>
      ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'].includes(e.status)
    ).length;
    const resolved = Math.max(0, complaintsCount - unresolvedComplaints);
    const slaRate =
      complaintsCount === 0
        ? 100
        : Number(asDecimal(resolved).div(complaintsCount).times(100).toFixed(1));

    const crewIds = crewToday.map((c) => c.id);
    const completedTodayByEmployee = new Map<string, number>();
    if (crewIds.length > 0) {
      const todayKey = startOfToday.toISOString().slice(0, 10);
      const completedToday = await prisma.booking.findMany({
        where: {
          vendorId: { in: hubIds },
          status: 'COMPLETED',
          scheduledDate: todayKey,
          OR: [{ employeeId: { in: crewIds } }, { helperEmployeeId: { in: crewIds } }],
        },
        select: { employeeId: true, helperEmployeeId: true },
      });
      for (const b of completedToday) {
        if (b.employeeId && crewIds.includes(b.employeeId)) {
          completedTodayByEmployee.set(
            b.employeeId,
            (completedTodayByEmployee.get(b.employeeId) || 0) + 1
          );
        }
        if (
          b.helperEmployeeId &&
          crewIds.includes(b.helperEmployeeId) &&
          b.helperEmployeeId !== b.employeeId
        ) {
          completedTodayByEmployee.set(
            b.helperEmployeeId,
            (completedTodayByEmployee.get(b.helperEmployeeId) || 0) + 1
          );
        }
      }
    }

    const activeToday = crewToday.map((emp) => {
      const checkedIn = Boolean(emp.hubCheckedInAt);
      const timing = computeShiftTiming(emp.hubCheckedInAt || emp.lastHubCheckInAt);
      let workedHours = timing.workedHours;
      if (!checkedIn && emp.lastHubCheckInAt && emp.lastHubCheckOutAt) {
        const inMs = new Date(emp.lastHubCheckInAt).getTime();
        const outMs = new Date(emp.lastHubCheckOutAt).getTime();
        if (outMs > inMs && new Date(emp.lastHubCheckInAt) >= startOfToday) {
          workedHours = Math.round(((outMs - inMs) / (1000 * 60 * 60)) * 10) / 10;
        }
      }
      return {
        employeeId: emp.id,
        name: emp.user.name,
        phone: emp.user.phone || '',
        checkedIn,
        checkedOut: !checkedIn && Boolean(emp.lastHubCheckOutAt && emp.lastHubCheckOutAt >= startOfToday),
        workedHours,
        completedOrdersToday: completedTodayByEmployee.get(emp.id) || 0,
        hubCheckedInAt: emp.hubCheckedInAt,
        lastHubCheckOutAt: emp.lastHubCheckOutAt,
      };
    });

    sendSuccess(res, {
      role: 'OPERATIONS_MANAGER',
      portalLabel: 'Hub Operation Manager',
      periodDays: 30,
      hubs,
      manager: {
        name: actor.user?.name || '',
        city: actor.user?.managerProfile?.city || '',
        zone: actor.user?.managerProfile?.zone || '',
        shiftHours: actor.user?.managerProfile?.shiftHours || '',
      },
      metrics: {
        techniciansCount: employeeCount,
        employeesCount: employeeCount,
        servicesCount,
        thirtyDaysJobs,
        openBookingsCount,
        thirtyDaysEarnings: toMoney(earnings),
        complaintsCount,
        unresolvedComplaints,
        slaRate,
        activeTodayCount: activeToday.filter((a) => a.checkedIn).length,
        activeToday,
      },
    });
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const searchDeskServices = async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = await resolvePortalActor(req.user!.userId);
    if (!actor.user || (!actor.isManager && !actor.isVendor && !actor.user.employeeProfile)) {
      sendError(res, 'FORBIDDEN', 'Only a hub manager, provider, or expert can search desk services', 403);
      return;
    }

    const term = String(req.query.q || '').trim();
    if (term.length < 1) {
      sendSuccess(res, { services: [] });
      return;
    }

    const hubs = await assignedHubsForActor(actor);
    const requestedVendorId = String(req.query.vendorId || '').trim();
    let hubIds = hubs.map((hub) => hub.id);

    if (requestedVendorId) {
      if (!hubs.some((hub) => hub.id === requestedVendorId)) {
        sendError(res, 'FORBIDDEN', 'You can only search services for a hub you are assigned to', 403);
        return;
      }
      hubIds = [requestedVendorId];
    } else if (actor.vendorId) {
      hubIds = [actor.vendorId];
    }

    if (hubIds.length === 0) {
      sendSuccess(res, { services: [] });
      return;
    }

    // Two-step filter (Mongo-safe): name match first, then require VendorService assignment.
    const nameMatches = await prisma.service.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        name: { contains: term, mode: 'insensitive' },
      },
      select: { id: true, name: true, startingPrice: true },
      take: 50,
    });
    if (nameMatches.length === 0) {
      sendSuccess(res, { services: [] });
      return;
    }

    const nameMatchIds = nameMatches.map((service) => service.id);
    const assignments = await prisma.vendorService.findMany({
      where: {
        vendorId: { in: hubIds },
        isActive: true,
        serviceId: { in: nameMatchIds },
      },
      select: { serviceId: true, customPrice: true },
    });
    const assignmentByServiceId = new Map(assignments.map((row) => [row.serviceId, row]));

    const services = nameMatches
      .filter((service) => assignmentByServiceId.has(service.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 20)
      .map((service) => {
        const assignment = assignmentByServiceId.get(service.id);
        const startingPrice =
          assignment?.customPrice && String(assignment.customPrice).trim() !== ''
            ? toMoney(assignment.customPrice)
            : toMoney(service.startingPrice);
        return {
          id: service.id,
          name: service.name,
          startingPrice,
          catalogStartingPrice: toMoney(service.startingPrice),
          customPrice: assignment?.customPrice ? toMoney(assignment.customPrice) : null,
        };
      });

    sendSuccess(res, { services });
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

function resolveHubManagerPhone(order: any): string {
  const managers = order?.vendor?.managers || [];
  for (const mgr of managers) {
    const phone = String(mgr?.user?.phone || '').trim();
    if (phone) return phone;
  }
  const warehousePhone = String(order?.vendor?.warehousePhone || '').trim();
  if (warehousePhone) return warehousePhone;
  return String(order?.vendor?.user?.phone || '').trim();
}

function sanitizeOrderForViewer(order: any, viewer: { isVendor: boolean; employeeId?: string; isManager?: boolean }) {
  if (!order) return order;
  const withoutOtp = stripStartOtp(order);
  const hubManagerPhone = resolveHubManagerPhone(order);
  const isAssigned =
    !!viewer.employeeId &&
    (order.employeeId === viewer.employeeId || order.helperEmployeeId === viewer.employeeId);
  const role: LocationViewerRole = viewer.isVendor || viewer.isManager
    ? 'VENDOR_OWNER'
    : isAssigned
      ? 'ASSIGNED_EXPERT'
      : 'OTHER_EXPERT';

  const exactAllowed = canSeeExactLocation(role, order.status);
  const hideCustomerContact = !viewer.isVendor && !viewer.isManager;

  const sanitizedCustomer = hideCustomerContact && order.customer
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

  if (exactAllowed) {
    return stripStartOtp({ ...withoutOtp, customer: sanitizedCustomer, hubManagerPhone });
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

  return stripStartOtp({
    ...withoutOtp,
    address: sanitizedAddress,
    customer: sanitizedCustomer,
    serviceLatitude: approximateCoordinate(order.serviceLatitude),
    serviceLongitude: approximateCoordinate(order.serviceLongitude),
    hubManagerPhone,
  });
}

export const getVendorOrders = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const statusQuery = typeof req.query.status === 'string' ? req.query.status : undefined;
    const page = parseInt(String(req.query.page || '1'), 10) || 1;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const actor = await resolvePortalActor(userId);
    const { user, isVendor, isManager, employeeId, isSalesManager } = actor;

    let where: any = {};
    if (isVendor || isManager) {
      const hubIds = (await assignedHubsForActor(actor)).map((hub) => hub.id);
      if (hubIds.length === 0) {
        sendError(res, 'HUB_NOT_ASSIGNED', 'This manager is not assigned to a local provider hub yet', 403);
        return;
      }
      where.vendorId = hubIds.length === 1 ? hubIds[0] : { in: hubIds };
    } else if (user?.employeeProfile) {
      if (isTestingWorkflowEnabled() && isSalesManager) {
        where = {
          vendorId: user.employeeProfile.vendorId,
          bookingSource: 'SALES_MANAGER',
        };
      } else {
        // Assigned jobs for this professional (hub auto-accepts; WP sees ASSIGNED after hub assigns).
        where.OR = [
          { employeeId: user.employeeProfile.id },
          { helperEmployeeId: user.employeeProfile.id },
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

    const actor = await resolvePortalActor(userId);
    const { user, isVendor, isManager, employeeId, isSalesManager } = actor;

    let where: any = { id };
    if (isVendor || isManager) {
      const hubIds = (await assignedHubsForActor(actor)).map((hub) => hub.id);
      if (hubIds.length === 0) {
        sendError(res, 'HUB_NOT_ASSIGNED', 'This manager is not assigned to a local provider hub yet', 403);
        return;
      }
      where.vendorId = hubIds.length === 1 ? hubIds[0] : { in: hubIds };
    } else if (user?.employeeProfile) {
      if (isTestingWorkflowEnabled() && isSalesManager) {
        where.vendorId = user.employeeProfile.vendorId;
        where.bookingSource = 'SALES_MANAGER';
      } else {
        where.OR = [
          { employeeId: user.employeeProfile.id },
          { helperEmployeeId: user.employeeProfile.id },
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
    const { status, note, etaMinutes, helperEmployeeId, helperPayoutAmount, leadPayoutAmount, latitude, longitude } =
      req.body;

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
      if (status === 'COMPLETED' || status === 'AWAITING_CUSTOMER_CONFIRMATION') {
        sendError(res, 'INVALID_TRANSITION', 'Swipe to complete and upload at least 4 photographs', 400);
        return;
      }
      if (status === 'IN_PROGRESS') {
        const bookingForStart = await prisma.booking.findFirst({
          where: { id, employeeId: user.employeeProfile.id },
          select: {
            id: true,
            status: true,
            bookingSource: true,
            bookingNumber: true,
            beforePhotoUrls: true,
            qrVerifiedAt: true,
          },
        });
        if (!bookingForStart) {
          sendError(res, 'NOT_FOUND', 'Order not found or unauthorized', 404);
          return;
        }
        const deskManaged =
          bookingForStart.bookingSource === 'SALES_MANAGER' || bookingForStart.bookingSource === 'PHONE_HUB';
        if (!deskManaged) {
          sendError(
            res,
            'INVALID_TRANSITION',
            'Verify the start OTP, then upload 4 before photographs to begin work',
            400
          );
          return;
        }
        if (bookingForStart.status !== 'ARRIVED') {
          sendError(
            res,
            'INVALID_TRANSITION',
            `Cannot start work from ${bookingForStart.status}. Mark arrived first, then upload 4 before photographs.`,
            409
          );
          return;
        }
        if (!hasRequiredBeforePhotos(bookingForStart.beforePhotoUrls)) {
          sendError(
            res,
            'PHOTOS_REQUIRED',
            `Upload at least ${MIN_BEFORE_PHOTOS} before photographs showing site condition before starting work. Currently ${countValidBeforePhotos(bookingForStart.beforePhotoUrls)} valid photograph(s) are stored.`,
            400
          );
          return;
        }
        try {
          await beginWorkAfterBeforePhotos(userId, id);
        } catch (err: any) {
          if (err instanceof DispatchError) {
            sendError(res, err.code, err.message, err.httpStatus);
            return;
          }
          throw err;
        }
        const started = await prisma.booking.findUnique({
          where: { id },
          include: ORDER_LIST_INCLUDE,
        });
        sendSuccess(res, { order: started ? stripStartOtp(started) : started }, 200);
        return;
      }
      if (status === 'ACCEPTED') {
        await acceptAssignment(
          userId,
          id,
          etaMinutes,
          helperEmployeeId
            ? {
                helperEmployeeId,
                helperPayoutAmount: helperPayoutAmount ?? 0,
                leadPayoutAmount,
              }
            : null
        );
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
        await advanceTravelStatus(userId, id, status, { latitude, longitude });
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
    const token = req.body.otp || req.body.startOtp || req.body.token || req.body.qrToken;
    await verifyStartOtpForExpert(userId, id, token);
    const updated = await prisma.booking.findUnique({
      where: { id },
      include: ORDER_LIST_INCLUDE,
    });
    sendSuccess(
      res,
      {
        order: updated ? stripStartOtp(updated) : updated,
        message: 'OTP verified. Upload at least 4 before photographs to start work.',
        pinVerified: true,
        requiresBeforePhotos: true,
        requiredBeforePhotos: MIN_BEFORE_PHOTOS,
        beforePhotoCount: countValidBeforePhotos(updated?.beforePhotoUrls),
      },
      200
    );
  } catch (err: any) {
    if (err instanceof DispatchError) {
      sendError(res, err.code, err.message, err.httpStatus);
      return;
    }
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

/** @deprecated alias — QR start verification was replaced with a 4-digit OTP. */
export const verifyOrderQr = verifyOrderOtp;

export const uploadOrderBeforePhotos = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const payloads: string[] = [];
    if (typeof req.body?.image === 'string') payloads.push(req.body.image);
    if (Array.isArray(req.body?.images)) payloads.push(...req.body.images.filter((v: unknown) => typeof v === 'string'));

    if (payloads.length === 0) {
      sendError(res, 'BAD_REQUEST', 'At least one before photograph is required', 400);
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { employeeProfile: true },
    });
    if (!user?.employeeProfile) {
      sendError(res, 'FORBIDDEN', 'Only the assigned Service Professional can upload before photographs', 403);
      return;
    }
    if (isTestingWorkflowEnabled() && user.employeeProfile.expertKind === 'SALES_MANAGER') {
      sendError(res, 'FORBIDDEN', 'Sales Managers cannot upload service before photographs', 403);
      return;
    }

    const booking = await prisma.booking.findFirst({
      where: { id, employeeId: user.employeeProfile.id },
    });
    if (!booking) {
      sendError(res, 'NOT_FOUND', 'Order not found or not assigned to you', 404);
      return;
    }
    if (!(BEFORE_PHOTO_ELIGIBLE_STATUSES as readonly string[]).includes(booking.status)) {
      sendError(
        res,
        'BAD_REQUEST',
        `Cannot upload before photographs while the job is ${booking.status}. Mark arrived and verify the start PIN first.`,
        400
      );
      return;
    }

    const deskManaged =
      booking.bookingSource === 'SALES_MANAGER' || booking.bookingSource === 'PHONE_HUB';
    if (!booking.qrVerifiedAt && !deskManaged) {
      sendError(res, 'BAD_REQUEST', 'Verify the customer start PIN before uploading before photographs', 400);
      return;
    }

    const hosted: string[] = [];
    for (const payload of payloads) {
      if (estimatePayloadBytes(payload) > MAX_DOCUMENT_BYTES) {
        sendError(res, 'PAYLOAD_TOO_LARGE', 'Each photograph must be 500MB or smaller', 413);
        return;
      }
      const url = await resolveHostedUrl(payload, 'servfex/before');
      if (url) hosted.push(url);
    }
    if (hosted.length === 0) {
      sendError(res, 'IMAGE_UPLOAD_FAILED', 'Photographs could not be hosted. Retry the upload.', 400);
      return;
    }

    const merged = uniqueHostedImageUrls([...(booking.beforePhotoUrls || []), ...hosted]);
    const updated = await prisma.booking.update({
      where: { id },
      data: { beforePhotoUrls: merged },
      select: {
        id: true,
        status: true,
        beforePhotoUrls: true,
      },
    });
    await prisma.bookingPhoto.createMany({
      data: hosted.map((url) => ({
        bookingId: id,
        employeeId: user.employeeProfile!.id,
        url,
        category: 'BEFORE' as const,
      })),
    });

    let workStarted = false;
    let orderStatus = updated.status;
    if (hasRequiredBeforePhotos(updated.beforePhotoUrls) && updated.status === 'ARRIVED') {
      try {
        const started = await beginWorkAfterBeforePhotos(userId, id);
        workStarted = true;
        orderStatus = started.status;
      } catch (err: any) {
        if (!(err instanceof DispatchError && err.code === 'PHOTOS_REQUIRED')) {
          throw err;
        }
      }
    }

    void emitBookingRefresh(id, { reason: workStarted ? 'SERVICE_STARTED' : 'BEFORE_PHOTOS_UPLOADED' });

    sendSuccess(
      res,
      {
        orderId: updated.id,
        photoUrls: updated.beforePhotoUrls,
        count: countValidBeforePhotos(updated.beforePhotoUrls),
        required: MIN_BEFORE_PHOTOS,
        readyToStart: hasRequiredBeforePhotos(updated.beforePhotoUrls),
        workStarted,
        status: orderStatus,
      },
      200
    );
  } catch (err: any) {
    if (err instanceof DispatchError) {
      sendError(res, err.code, err.message, err.httpStatus);
      return;
    }
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

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
    await prisma.bookingPhoto.createMany({
      data: hosted.map((url) => ({
        bookingId: id,
        employeeId: user.employeeProfile!.id,
        url,
        category: 'COMPLETION' as const,
      })),
    });
    void emitBookingRefresh(id, { reason: 'PHOTOS_UPLOADED' });

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
    const { note, completionNotes, completionOtp, completionPin, otp } = req.body || {};
    const completionReason = note || completionNotes;
    const completionPinRaw = completionOtp || completionPin || otp;

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
    const deskManaged =
      booking.bookingSource === 'SALES_MANAGER' || booking.bookingSource === 'PHONE_HUB';
    if (!booking.qrVerifiedAt && !deskManaged) {
      sendError(res, 'BAD_REQUEST', 'Cannot complete order without verified start OTP', 400);
      return;
    }

    // Customer-app jobs require the professional to enter the customer's completion PIN.
    if (!deskManaged) {
      try {
        const { assertCompletionOtpForExpert } = await import('../services/execution.service');
        await assertCompletionOtpForExpert(userId, id, completionPinRaw);
      } catch (pinErr: any) {
        const code = pinErr?.code || 'INVALID_OTP';
        const status = pinErr?.httpStatus || 400;
        sendError(res, code, pinErr?.message || 'Invalid completion PIN', status);
        return;
      }
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
        const currentDeskManaged =
          current.bookingSource === 'SALES_MANAGER' || current.bookingSource === 'PHONE_HUB';
        if (!current.qrVerifiedAt && !currentDeskManaged) {
          throw Object.assign(new Error('Cannot complete order without verified start OTP'), { code: 'BAD_REQUEST' });
        }
        if (!hasRequiredCompletionPhotos(current.completionPhotoUrls)) {
          throw Object.assign(
            new Error(`Upload at least ${MIN_COMPLETION_PHOTOS} completion photographs before finishing this job.`),
            { code: 'COMPLETION_PHOTOS_REQUIRED' }
          );
        }

        // Desk-managed jobs (Sales Manager / Hub OM) close immediately — no customer-app confirmation.
        const nextStatus = currentDeskManaged ? 'COMPLETED' : 'AWAITING_CUSTOMER_CONFIRMATION';
        const flipped = await tx.booking.updateMany({
          where: {
            id,
            status: { in: [...COMPLETABLE_JOB_STATUSES] as BookingStatus[] },
          },
          data: {
            status: nextStatus,
            completionRequestedAt: new Date(),
            ...(currentDeskManaged
              ? {
                  customerConfirmedAt: new Date(),
                  paymentStatus: 'PAID',
                  qrVerifiedAt: current.qrVerifiedAt || new Date(),
                }
              : {}),
          },
        });
        if (flipped.count !== 1) {
          throw Object.assign(new Error('Completion changed while submitting. Please refresh.'), { code: 'ASSIGNMENT_CONFLICT' });
        }

        await tx.bookingStatusHistory.create({
          data: {
            bookingId: id,
            oldStatus: current.status,
            newStatus: nextStatus,
            changedBy: userId,
            changedByRole: (user?.role as any) || 'EMPLOYEE',
            reason:
              completionReason ||
              (currentDeskManaged
                ? 'Working Professional completed desk-assigned job and confirmed on-site UPI collection.'
                : 'Technician completed service delivery. Awaiting customer confirmation.'),
          },
        });
        if (currentDeskManaged && (current.employeeId || booking.employeeId)) {
          await tx.employeeProfile.update({
            where: { id: (current.employeeId || booking.employeeId)! },
            data: { completedJobs: { increment: 1 } },
          });
        }
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

    await setLocationSharing(id, false);
    void emitBookingRefresh(id, { reason: 'SERVICE_COMPLETED' });
    sendSuccess(
      res,
      {
        order: updated,
        message: deskManaged
          ? 'Job completed. Payment confirmed by the Working Professional.'
          : 'Completion submitted. Awaiting customer confirmation.',
      },
      200
    );
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
    const { employeeId, expertPayout, payout, note, instructions, etaMinutes } = req.body;

    const actor = await resolvePortalActor(userId);
    const vendorId = actor.vendorId;
    if (!vendorId || (!actor.isVendor && !actor.isManager)) {
      sendError(res, 'FORBIDDEN', 'Only the hub partner or operations manager can assign this order', 403);
      return;
    }

    const vendorProfile = await prisma.vendorProfile.findUnique({
      where: { id: vendorId },
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

    if (employee) {
      const { isEmployeeEligibleForCategory } = await import('../services/tag.eligibility');
      const eligible = await isEmployeeEligibleForCategory({
        employeeId: employee.id,
        vendorId: vendorProfile.id,
        categoryId: booking.service.categoryId,
      });
      if (!eligible) {
        sendError(
          res,
          'EXPERT_NOT_ELIGIBLE',
          'This professional’s tags do not allow this service category',
          400
        );
        return;
      }
    }

    const resolvedPayout = expertPayout || payout || null;
    const resolvedInstructions = (instructions || note || '').trim();

    if (employeeId) {
      const resolvedEta =
        typeof etaMinutes === 'number' && Number.isFinite(etaMinutes)
          ? Math.max(60, Math.min(Math.round(etaMinutes), 43_200))
          : null;
      if (resolvedEta == null) {
        sendError(
          res,
          'ETA_REQUIRED',
          'Set how long until the professional should arrive (hours or days) before assigning',
          400
        );
        return;
      }
      const updated = await assignExpertManually({
        bookingId: id,
        vendorId: vendorProfile.id,
        vendorUserId: userId,
        employeeIdOrUserId: employeeId,
        expertPayout: resolvedPayout ? Number(resolvedPayout) : null,
        note: resolvedInstructions || null,
        etaMinutes: resolvedEta,
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
            reason: resolvedInstructions || `Dispatched to hub team with payout ₹${resolvedPayout || 'standard'}`,
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

      const hubLabel = vendorProfile.warehouseName || vendorProfile.companyName;
      const payoutText = resolvedPayout ? ` ₹${Number(resolvedPayout).toFixed(2)}` : '';

      const hubExperts = await tx.employeeProfile.findMany({
        where: { vendorId: vendorProfile.id, isAvailable: true },
        include: { user: true },
      });

      for (const exp of hubExperts) {
        await tx.notification.create({
          data: {
            title: `New Hub Order Available #${b.bookingNumber}`,
            message: `New booking for ${booking.service.name} at ${hubLabel}. Expert Fare:${payoutText}. Tap to review and accept!`,
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
    const actor = await resolvePortalActor(req.user!.userId);
    const vendorId = actor.vendorId;
    if (!vendorId) {
      sendError(res, 'NOT_FOUND', 'Vendor profile not found', 404);
      return;
    }

    const eligibleOnly = String(req.query.eligibleForAssignment || '') === 'true';
    const vendor = await prisma.vendorProfile.findUnique({
      where: { id: vendorId },
      select: { id: true, companyName: true, warehouseName: true },
    });

    const employees = await prisma.employeeProfile.findMany({
      where: {
        vendorId,
        ...(isTestingWorkflowEnabled() && eligibleOnly
          ? {
              expertKind: 'SERVICE_PROFESSIONAL',
              // Only hub-checked-in, online Working Professionals can be assigned orders
              hubCheckedInAt: { not: null },
              isAvailable: true,
              acceptingRequests: true,
            }
          : {}),
      },
      include: {
        user: {
          select: { id: true, name: true, email: true, phone: true, profilePhotoUrl: true, status: true },
        },
        _count: { select: { bookings: true, reviews: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Hub Operation Managers assigned to this hub (kept separate from field employees).
    // Match by ManagerProfile.vendorId and by zone CSV hub names / hub UUIDs — same rules as admin getManagers.
    const allVendors = await prisma.vendorProfile.findMany({
      select: { id: true, companyName: true, warehouseName: true },
    });
    const vendorById = new Map(allVendors.map((v) => [v.id, v]));
    const vendorIdByHubName = new Map<string, string>();
    for (const v of allVendors) {
      if (v.warehouseName) vendorIdByHubName.set(v.warehouseName.trim().toLowerCase(), v.id);
      if (v.companyName) vendorIdByHubName.set(v.companyName.trim().toLowerCase(), v.id);
    }
    const uuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    const managerProfiles = await prisma.managerProfile.findMany({
      where: {
        kind: 'OPERATIONS',
        user: { role: 'OPERATIONS_MANAGER', deletedAt: null },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            profilePhotoUrl: true,
            status: true,
            createdAt: true,
          },
        },
        vendor: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const resolveManagerHubIds = (mgr: (typeof managerProfiles)[number]): string[] => {
      const ids = new Set<string>();
      if (mgr.vendorId) ids.add(mgr.vendorId);
      if (mgr.vendor?.id) ids.add(mgr.vendor.id);
      for (const part of String(mgr.zone || '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)) {
        if (uuidRe.test(part) && vendorById.has(part)) {
          ids.add(part);
          continue;
        }
        const byName = vendorIdByHubName.get(part.toLowerCase());
        if (byName) ids.add(byName);
      }
      return [...ids];
    };

    const houseOfMasters = managerProfiles
      .filter((mgr) => resolveManagerHubIds(mgr).includes(vendorId))
      .map((mgr) => ({
        id: mgr.id,
        userId: mgr.userId,
        kind: mgr.kind,
        zone: mgr.zone,
        city: mgr.city,
        shiftHours: mgr.shiftHours,
        vendorId: mgr.vendorId || vendorId,
        user: mgr.user,
        portalLabel: 'Hub Operation Manager',
      }));

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    sendSuccess(
      res,
      {
        employees: employees.map((emp) => {
          const checkedIn = Boolean(emp.hubCheckedInAt);
          const checkedOutToday =
            !checkedIn &&
            Boolean(emp.lastHubCheckOutAt && new Date(emp.lastHubCheckOutAt) >= startOfToday);
          const timing = computeShiftTiming(emp.hubCheckedInAt || emp.lastHubCheckInAt);
          return {
            ...emp,
            checkedIn,
            checkedOutToday,
            workedHours: timing.workedHours,
            assignable:
              checkedIn && emp.isAvailable !== false && emp.acceptingRequests !== false,
            isLateWorker: checkedIn && Boolean(emp.lateWorkerFlaggedAt),
            lastLatitude: emp.lastLatitude ?? null,
            lastLongitude: emp.lastLongitude ?? null,
            lastLocationAt: emp.lastLocationAt ?? null,
          };
        }),
        houseOfMasters,
      },
      200
    );
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

/** HOM professional detail: active job + today/tomorrow assignments + live GPS. */
export const getEmployeeDayBoard = async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = await resolvePortalActor(req.user!.userId);
    if (!actor.isManager && !actor.isVendor) {
      sendError(res, 'FORBIDDEN', 'Only hub partner or operations manager can open the day board', 403);
      return;
    }

    const employeeId = String(req.params.id || '').trim();
    const hubs = await assignedHubsForActor(actor);
    const hubIds = hubs.map((h) => h.id);
    if (hubIds.length === 0) {
      sendError(res, 'HUB_NOT_ASSIGNED', 'No hub assigned', 403);
      return;
    }

    const emp = await prisma.employeeProfile.findFirst({
      where: { id: employeeId, vendorId: { in: hubIds } },
      include: {
        user: { select: { id: true, name: true, phone: true, email: true } },
        vendor: { select: { id: true, companyName: true, warehouseName: true } },
      },
    });
    if (!emp) {
      sendError(res, 'NOT_FOUND', 'Professional not found on your hubs', 404);
      return;
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayKey = startOfToday.toISOString().slice(0, 10);
    const tomorrowDate = new Date(startOfToday);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowKey = tomorrowDate.toISOString().slice(0, 10);

    const dayStatuses = [
      'PENDING',
      'ASSIGNED',
      'ACCEPTED',
      'ON_THE_WAY',
      'ARRIVED',
      'IN_PROGRESS',
      'AWAITING_CUSTOMER_CONFIRMATION',
      'AWAITING_PAYMENT',
      'COMPLETED',
    ] as const;

    const bookings = await prisma.booking.findMany({
      where: {
        OR: [{ employeeId: emp.id }, { helperEmployeeId: emp.id }],
        scheduledDate: { in: [todayKey, tomorrowKey] },
        status: { in: [...dayStatuses] },
      },
      include: {
        service: { select: { name: true } },
        address: { select: { addressLine1: true, city: true } },
        customer: { include: { user: { select: { name: true, phone: true } } } },
      },
      orderBy: [{ scheduledDate: 'asc' }, { createdAt: 'asc' }],
    });

    const mapOrder = (b: (typeof bookings)[number]) => ({
      id: b.id,
      bookingNumber: b.bookingNumber,
      status: b.status,
      scheduledDate: b.scheduledDate,
      scheduledTimeSlot: b.scheduledTimeSlot,
      serviceName: b.service?.name || 'Service',
      addressLine1: b.address?.addressLine1 || '',
      city: b.address?.city || '',
      customerName: b.customer?.user?.name || '',
      customerPhone: b.customer?.user?.phone || '',
      totalAmount: b.totalAmount,
    });

    const today = bookings.filter((b) => b.scheduledDate === todayKey).map(mapOrder);
    const tomorrow = bookings.filter((b) => b.scheduledDate === tomorrowKey).map(mapOrder);
    const activeRaw = bookings.find((b) =>
      ['ON_THE_WAY', 'ARRIVED', 'IN_PROGRESS', 'AWAITING_CUSTOMER_CONFIRMATION'].includes(b.status)
    );

    const timing = computeShiftTiming(emp.hubCheckedInAt);
    const checkedIn = Boolean(emp.hubCheckedInAt);
    const checkedOutToday =
      !checkedIn && Boolean(emp.lastHubCheckOutAt && new Date(emp.lastHubCheckOutAt) >= startOfToday);

    sendSuccess(res, {
      employee: {
        id: emp.id,
        userId: emp.userId,
        name: emp.user.name,
        phone: emp.user.phone || emp.phone || '',
        email: emp.user.email || '',
        specialization: emp.specialization,
        hubName: emp.vendor.warehouseName || emp.vendor.companyName,
        checkedIn,
        checkedOutToday,
        isLateWorker: checkedIn && Boolean(emp.lateWorkerFlaggedAt),
        workedHours: timing.workedHours,
        lastLatitude: emp.lastLatitude,
        lastLongitude: emp.lastLongitude,
        lastLocationAt: emp.lastLocationAt,
        hubCheckedInAt: emp.hubCheckedInAt,
        lastHubCheckOutAt: emp.lastHubCheckOutAt,
      },
      activeOrder: activeRaw ? mapOrder(activeRaw) : null,
      todayOrders: today,
      tomorrowOrders: tomorrow,
    });
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const createVendorEmployee = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { name, email, phone, specialization, password, expertKind } = req.body;
    const resolvedExpertKind = normalizeExpertKind(expertKind);

    const actor = await resolvePortalActor(userId);
    if (!actor.vendorId || (!actor.isVendor && !actor.isManager)) {
      sendError(res, 'FORBIDDEN', 'Only hub partner or operations manager can onboard professionals', 403);
      return;
    }

    const vendorProfile =
      actor.user?.vendorProfile ||
      actor.user?.managerProfile?.vendor ||
      (await prisma.vendorProfile.findUnique({ where: { id: actor.vendorId } }));

    if (!vendorProfile) {
      sendError(res, 'NOT_FOUND', 'Hub profile not found', 404);
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
    const hubCompanyName =
      ('companyName' in vendorProfile && vendorProfile.companyName) || 'ServFex Hub';
    const hubLocation = ('location' in vendorProfile && vendorProfile.location) || '';

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
              vendorId: actor.vendorId!,
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
      providerName: hubCompanyName,
      providerCompany: hubCompanyName,
      location: hubLocation,
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
    const { name, phone, specialization, isAvailable, acceptingRequests, upiId, expertKind } = req.body;

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
          ...(acceptingRequests !== undefined ? { acceptingRequests } : {}),
          ...(upiId !== undefined && isValidUpiId(upiId) ? { upiId: normalizeUpiId(upiId) } : {}),
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
      serviceName,
      scheduledDate,
      scheduledTimeSlot,
      addressLine1,
      city,
      landmark,
      mapsUrl,
      latitude,
      longitude,
      notes,
      source,
      vendorId: requestedVendorId,
      employeeId,
    } = req.body;

    const actor = await resolvePortalActor(userId);
    const { user, isManager, isVendor, isSalesManager } = actor;
    if (!actor.user || (!isManager && !isVendor && !user?.employeeProfile)) {
      sendError(res, 'FORBIDDEN', 'Only a hub manager, provider, or expert can create a desk booking', 403);
      return;
    }

    if (source === 'SALES_MANAGER' && !isSalesManager && !isVendor && !isManager) {
      sendError(res, 'FORBIDDEN', 'Only a Sales Manager can create Sales Manager bookings', 403);
      return;
    }

    const hubs = await assignedHubsForActor(actor);
    if (hubs.length === 0) {
      sendError(res, 'HUB_NOT_ASSIGNED', 'You are not assigned to a fulfillment hub', 403);
      return;
    }

    let targetVendorId = actor.vendorId as string;
    if (isManager) {
      if (requestedVendorId) {
        if (!hubs.some((hub) => hub.id === requestedVendorId)) {
          sendError(res, 'FORBIDDEN', 'You can only assign this order to a hub you are assigned to', 403);
          return;
        }
        targetVendorId = requestedVendorId;
      } else {
        targetVendorId = hubs[0].id;
      }
    } else if (requestedVendorId && requestedVendorId !== actor.vendorId) {
      sendError(res, 'FORBIDDEN', 'You can only create orders for your own hub', 403);
      return;
    }

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      sendError(res, 'BAD_REQUEST', 'Pinpoint the customer location from a Google Maps URL first', 400);
      return;
    }

    const assigned = await resolveAssignedHubService(serviceId || undefined, serviceName, targetVendorId);
    if (!assigned) {
      sendError(
        res,
        'SERVICE_NOT_ASSIGNED',
        'Select a service that Super Admin has assigned to this hub',
        400
      );
      return;
    }
    const { service, price: hubSellPrice } = assigned;

    // Desk bookings (Sales Manager / Hub OM) go to the hub Provider first.
    // The Provider assigns a Working Professional and sets the expert payout.
    // Optional employeeId is still honored when an online WP is passed explicitly.
    let technicianToAssign: { id: string; userId: string } | null = null;
    if (employeeId) {
      const technician = await prisma.employeeProfile.findFirst({
        where: {
          vendorId: targetVendorId,
          expertKind: 'SERVICE_PROFESSIONAL',
          OR: [{ id: employeeId }, { userId: employeeId }],
        },
        select: {
          id: true,
          userId: true,
          isAvailable: true,
          acceptingRequests: true,
          hubCheckedInAt: true,
          user: { select: { name: true } },
        },
      });
      if (!technician) {
        sendError(res, 'FORBIDDEN', 'You can only assign this order to a Working Professional in your hub', 403);
        return;
      }
      if (!technician.hubCheckedInAt) {
        sendError(
          res,
          'EXPERT_OFFLINE',
          `${technician.user.name} has not checked in at the hub. Orders cannot be assigned until they check in.`,
          409
        );
        return;
      }
      if (!technician.isAvailable || !technician.acceptingRequests) {
        sendError(
          res,
          'EXPERT_OFFLINE',
          `${technician.user.name} is offline. You cannot assign any order until they check in and turn Online.`,
          409
        );
        return;
      }
      technicianToAssign = { id: technician.id, userId: technician.userId };
    }

    const resolvedCity = cityFromAddress(addressLine1, city);
    const today = new Date().toISOString().slice(0, 10);
    const slotDate = scheduledDate || today;
    const slotTime = scheduledTimeSlot || '10:00 AM - 12:00 PM';

    const cleanPhone = String(customerPhone).replace(/\s+/g, '');
    const digits = cleanPhone.replace(/\D/g, '');
    const cleanEmail = (customerEmail || `${digits || Date.now()}@hub.servfex.local`).toLowerCase().trim();

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
        vendorId: targetVendorId,
        customerId: customerUser.customerProfile!.id,
        serviceId: service.id,
        scheduledDate: slotDate,
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
        city: resolvedCity,
        state: resolvedCity,
        postalCode: '000000',
        landmark: landmark || mapsUrl || null,
        latitude,
        longitude,
        isDefault: customerUser.addresses.length === 0,
      },
    });

    const bookingNumber = `SFX-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
    const bookingSource =
      isSalesManager || source === 'SALES_MANAGER'
        ? 'SALES_MANAGER'
        : source === 'EXPERT_TEAM'
          ? 'EXPERT_TEAM'
          : 'PHONE_HUB';

    const booking = await prisma.booking.create({
      data: {
        bookingNumber,
        customerId: customerUser.customerProfile!.id,
        serviceId: service.id,
        addressId: address.id,
        vendorId: targetVendorId,
        scheduledDate: slotDate,
        scheduledTimeSlot: slotTime,
        status: 'PENDING',
        basePrice: hubSellPrice,
        taxes: toMoney(0),
        totalAmount: hubSellPrice,
        notes: notes || null,
        bookingSource,
        assignmentStrategy: 'DIRECT_EXPERT',
        dispatchDueAt: null,
        serviceLatitude: latitude,
        serviceLongitude: longitude,
        serviceFormattedAddress: addressLine1,
        serviceLocationNote: mapsUrl || null,
        serviceLocationConfirmedAt: new Date(),
        qrChallengeToken: generateStartOtp(),
        qrChallengeExpiresAt: new Date(Date.now() + env.START_OTP_EXPIRY_MINUTES * 60 * 1000),
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
        employee: { include: { user: { select: { name: true, phone: true } } } },
      },
    });

    let finalBooking: any = booking;
    if (technicianToAssign) {
      const assigned = await assignExpertManually({
        bookingId: booking.id,
        vendorId: targetVendorId,
        vendorUserId: userId,
        employeeIdOrUserId: technicianToAssign.id,
        expertPayout: null,
        note: isSalesManager ? 'Assigned immediately by Sales Manager' : 'Assigned immediately by Hub Operation Manager',
      });
      if (assigned) {
        finalBooking = assigned;
      }
    }

    const vendorOwner = await prisma.vendorProfile.findUnique({
      where: { id: targetVendorId },
      select: { userId: true },
    });
    const technicianUserId = finalBooking.employee?.userId || technicianToAssign?.userId || null;

    let hubProfessionalUserIds: string[] = [];
    if (!technicianUserId) {
      const hubProfessionals = await prisma.employeeProfile.findMany({
        where: {
          vendorId: targetVendorId,
          expertKind: 'SERVICE_PROFESSIONAL',
          user: { status: 'ACTIVE', deletedAt: null },
        },
        select: { userId: true },
      });
      hubProfessionalUserIds = hubProfessionals.map((emp) => emp.userId);
    }

    const realtimeTargets = [
      customerUser.id,
      userId,
      vendorOwner?.userId,
      technicianUserId,
      ...hubProfessionalUserIds,
    ].filter(Boolean) as string[];

    emitBookingEvent(
      'booking:new',
      {
        bookingId: finalBooking.id,
        bookingNumber: finalBooking.bookingNumber,
        status: finalBooking.status,
        vendorId: finalBooking.vendorId,
        reason: technicianUserId ? 'DESK_ORDER_ASSIGNED' : 'DESK_ORDER_CREATED',
      },
      realtimeTargets
    );
    if (technicianUserId) {
      emitUserEvent('booking:assignment', { bookingId: finalBooking.id, reason: 'DESK_ASSIGNED' }, [technicianUserId]);
    }

    const pushTargets = [...new Set(
      [vendorOwner?.userId, technicianUserId, ...hubProfessionalUserIds].filter(Boolean) as string[]
    )];
    void prisma.notification
      .createMany({
        data: pushTargets.map((targetUserId) => ({
          title: `New order #${finalBooking.bookingNumber}`,
          message: `${service.name} for ${customerName} is ready now.`,
          target: 'SPECIFIC_USER' as const,
          targetUserId,
        })),
      })
      .catch((err) => console.warn('[DeskBooking] notification write failed', err?.message || err));
    void sendPushToUserIds(pushTargets, {
      title: `New order #${finalBooking.bookingNumber}`,
      body: `${service.name} for ${customerName}. Open ServFex now.`,
      data: { bookingId: finalBooking.id, type: 'booking:new' },
    }).catch((err) => console.warn('[DeskBooking] push failed', err?.message || err));

    sendSuccess(res, { order: stripStartOtp(finalBooking) }, 201);
  } catch (err: any) {
    if (err instanceof DispatchError) {
      sendError(res, err.code, err.message, err.httpStatus);
      return;
    }
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

const MAX_OFFER_CAMPAIGNS_PER_DAY = 5;

export const sendCustomerOfferSchema = z.object({
  title: z.string().min(3, 'Offer title is required').max(80),
  message: z.string().min(8, 'Offer message is required').max(280),
  serviceId: z.string().uuid().optional(),
});

/**
 * Partner (VENDOR) sends a promotional offer to their customers.
 * Falls back to all active customers if the partner has no booking history yet.
 */
export const sendCustomerOffer = async (req: Request, res: Response): Promise<void> => {
  try {
    if (req.user!.role !== 'VENDOR') {
      sendError(res, 'FORBIDDEN', 'Only the partner account can send customer offers', 403);
      return;
    }

    const userId = req.user!.userId;
    const { title, message, serviceId } = req.body as {
      title: string;
      message: string;
      serviceId?: string;
    };

    const vendorProfile = await prisma.vendorProfile.findUnique({
      where: { userId },
      include: { user: true },
    });

    if (!vendorProfile) {
      sendError(res, 'NOT_FOUND', 'Vendor profile not found', 404);
      return;
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentCampaigns = await prisma.offerCampaign.count({
      where: {
        vendorUserId: userId,
        createdAt: { gte: since },
      },
    });

    if (recentCampaigns >= MAX_OFFER_CAMPAIGNS_PER_DAY) {
      sendError(
        res,
        'RATE_LIMITED',
        `You can send up to ${MAX_OFFER_CAMPAIGNS_PER_DAY} customer offers per day`,
        429
      );
      return;
    }

    let catalogServiceId: string | null = null;
    if (serviceId) {
      const vendorService = await prisma.vendorService.findFirst({
        where: {
          vendorId: vendorProfile.id,
          OR: [{ id: serviceId }, { serviceId }],
        },
        select: { serviceId: true },
      });
      if (vendorService) {
        catalogServiceId = vendorService.serviceId;
      } else {
        const catalogService = await prisma.service.findFirst({
          where: { id: serviceId, deletedAt: null },
          select: { id: true },
        });
        if (!catalogService) {
          sendError(res, 'BAD_REQUEST', 'Selected service was not found', 400);
          return;
        }
        catalogServiceId = catalogService.id;
      }
    }

    const bookings = await prisma.booking.findMany({
      where: { vendorId: vendorProfile.id },
      select: {
        customer: { select: { userId: true } },
      },
    });

    let recipientIds = [
      ...new Set(
        bookings
          .map((booking) => booking.customer?.userId)
          .filter((id): id is string => Boolean(id))
      ),
    ];

    if (recipientIds.length === 0) {
      const customers = await prisma.user.findMany({
        where: {
          role: 'CUSTOMER',
          status: 'ACTIVE',
          deletedAt: null,
        },
        select: { id: true },
        take: 5000,
      });
      recipientIds = customers.map((customer) => customer.id);
    }

    if (recipientIds.length === 0) {
      sendError(res, 'NOT_FOUND', 'No customers are available to receive this offer yet', 404);
      return;
    }

    const senderName = vendorProfile.companyName || vendorProfile.user.name || 'ServFex Partner';

    await prisma.notification.createMany({
      data: recipientIds.map((targetUserId) => ({
        title,
        message,
        target: 'SPECIFIC_USER' as const,
        targetUserId,
        type: 'OFFER',
        senderUserId: userId,
        senderName,
        serviceId: catalogServiceId,
      })),
    });

    const campaign = await prisma.offerCampaign.create({
      data: {
        vendorUserId: userId,
        vendorId: vendorProfile.id,
        title,
        message,
        serviceId: catalogServiceId,
        recipientCount: recipientIds.length,
      },
    });

    const delivered = await sendPushToUserIds(recipientIds, {
      title,
      body: message,
      data: {
        type: 'OFFER',
        serviceId: catalogServiceId || '',
        senderName,
        campaignId: campaign.id,
      },
    });

    sendSuccess(
      res,
      {
        campaignId: campaign.id,
        recipientCount: recipientIds.length,
        delivered,
      },
      201
    );
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};
