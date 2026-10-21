import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendError, sendSuccess } from '../utils/response';
import { hashPassword } from '../utils/password';
import { logAuditEvent } from '../utils/audit';
import { Prisma, DocumentType, KycStatus } from '@prisma/client';
import { getFirebaseAuth } from '../config/firebase';
import { estimatePayloadBytes, MAX_DOCUMENT_BYTES, resolveHostedUrl } from '../utils/cloudinary';
import { sendProviderWelcomeEmail } from '../services/email.service';

const MAX_ONBOARDING_DOCUMENTS = 30;

export const listVendorsQuerySchema = z.object({
  query: z.object({
    page: z.string().optional().default('1').transform((v) => Math.max(1, parseInt(v, 10))),
    limit: z.string().optional().default('20').transform((v) => Math.min(100, Math.max(1, parseInt(v, 10)))),
    search: z.string().optional(),
    kycStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
    isActive: z.string().optional().transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
    sortBy: z.enum(['createdAt', 'rating', 'companyName']).optional().default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
  }),
});

export const createVendorSchema = z.object({
  body: z.object({
    email: z.string().email('Valid Google email is required'),
    name: z.string().optional(),
    companyName: z.string().optional(),
    phone: z.string().optional(),
    password: z.string().min(6).optional(),
    businessLicense: z.string().optional(),
    taxId: z.string().optional(),
    location: z.string().optional().default('Main Hub'),
    bio: z.string().optional(),
    commissionRate: z.number().min(0).max(100).optional().default(15.0),
    // Additional partner and warehouse onboarding fields
    partnerImage: z.string().optional(),
    warehouseName: z.string().optional(),
    warehouseLocation: z.string().optional(),
    warehousePhone: z.string().optional(),
    warehouseImage: z.string().optional(),
    latitude: z.number().nullable().optional(),
    longitude: z.number().nullable().optional(),
    documents: z
      .array(
        z.object({
          type: z.enum(['GOVERNMENT_ID', 'TRADE_LICENSE', 'TAX_DOCUMENT', 'CERTIFICATE', 'OTHER']).optional().default('OTHER'),
          title: z.string().optional().default('Verification Document'),
          fileUrl: z.string().min(5, 'Document file is required'),
        })
      )
      .max(MAX_ONBOARDING_DOCUMENTS, `You can attach up to ${MAX_ONBOARDING_DOCUMENTS} verification documents`)
      .optional(),
  }),
});

export const updateVendorSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    companyName: z.string().min(2).optional(),
    location: z.string().min(2).optional(),
    bio: z.string().optional(),
    businessLicense: z.string().optional(),
    taxId: z.string().optional(),
    commissionRate: z.number().min(0).max(100).optional(),
    latitude: z.number().nullable().optional(),
    longitude: z.number().nullable().optional(),
    warehouseName: z.string().nullable().optional(),
    warehouseLocation: z.string().nullable().optional(),
    warehousePhone: z.string().nullable().optional(),
    warehouseImageUrl: z.string().nullable().optional(),
    reason: z.string().optional(),
  }),
});

export const kycDecisionSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    reason: z.string().min(3, 'A reason is required'),
  }),
});

export const addDocumentSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    type: z.enum(['GOVERNMENT_ID', 'TRADE_LICENSE', 'TAX_DOCUMENT', 'CERTIFICATE', 'OTHER']),
    title: z.string().min(2, 'Document title is required'),
    fileUrl: z.string().min(5, 'File URL or document data is required'),
    verificationStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional().default('APPROVED'),
  }),
});

export const getVendors = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, limit, search, kycStatus, isActive, sortBy, sortOrder } = req.query as any;
    const skip = (page - 1) * limit;

    const where: any = {
      user: {
        deletedAt: null,
      },
    };

    if (kycStatus) {
      where.kycStatus = kycStatus;
    }

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    if (search) {
      where.OR = [
        { companyName: { contains: search, mode: 'insensitive' } },
        { location: { contains: search, mode: 'insensitive' } },
        { user: { name: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { user: { phone: { contains: search } } },
      ];
    }

    const [total, vendors] = await Promise.all([
      prisma.vendorProfile.count({ where }),
      prisma.vendorProfile.findMany({
        where,
        skip,
        take: limit,
        orderBy: sortBy === 'companyName' ? { companyName: sortOrder } : { [sortBy]: sortOrder },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              status: true,
              profilePhotoUrl: true,
              isVerified: true,
              createdAt: true,
            },
          },
          _count: {
            select: {
              employees: true,
              vendorServices: true,
              bookings: true,
            },
          },
        },
      }),
    ]);

    sendSuccess(res, vendors, 200, {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    next(error);
  }
};

export const getVendorById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;

    const vendor = await prisma.vendorProfile.findFirst({
      where: { id, user: { deletedAt: null } },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            status: true,
            profilePhotoUrl: true,
            isVerified: true,
            documents: true,
            createdAt: true,
          },
        },
        employees: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
                status: true,
                profilePhotoUrl: true,
                documents: true,
              },
            },
          },
        },
        vendorServices: {
          include: {
            service: { select: { id: true, name: true, startingPrice: true } },
          },
        },
        _count: {
          select: { bookings: true, reviews: true },
        },
      },
    });

    if (!vendor) {
      sendError(res, 'VENDOR_NOT_FOUND', 'Vendor not found', 404);
      return;
    }

    sendSuccess(res, vendor);
  } catch (error) {
    next(error);
  }
};

export const createVendor = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const {
      name,
      email,
      phone,
      password,
      companyName,
      businessLicense,
      taxId,
      location,
      bio,
      commissionRate,
      partnerImage,
      warehouseName,
      warehouseLocation,
      warehousePhone,
      warehouseImage,
      latitude,
      longitude,
      documents,
    } = req.body;
    const cleanEmail = email.toLowerCase().trim();
    const finalName = name || companyName || cleanEmail.split('@')[0];
    const finalCompanyName = companyName || warehouseName || name || cleanEmail.split('@')[0];
    const finalLocation = location || warehouseLocation || 'Main Hub';
    const finalWarehouseLocation = warehouseLocation || finalLocation;

    let existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: cleanEmail },
          ...(phone ? [{ phone }] : []),
        ],
      },
      include: { vendorProfile: true },
    });

    if (existingUser && existingUser.deletedAt === null && existingUser.vendorProfile && existingUser.vendorProfile.isActive) {
      sendError(res, 'USER_EXISTS', 'A partner profile with this email or phone already exists in ServFex', 409);
      return;
    }

    // 1. Process partner image upload if provided (base64 or remote URL)
    const uploadedPartnerImage = await resolveHostedUrl(partnerImage, 'servfex/avatars');

    // 2. Process warehouse image upload if provided
    const uploadedWarehouseImage = await resolveHostedUrl(warehouseImage, 'servfex/warehouses');

    if (Array.isArray(documents) && documents.length > 0) {
      const totalBytes = documents.reduce(
        (sum: number, doc: { fileUrl?: string }) => sum + estimatePayloadBytes(doc.fileUrl || ''),
        0
      );
      if (totalBytes > MAX_DOCUMENT_BYTES) {
        sendError(
          res,
          'PAYLOAD_TOO_LARGE',
          'Verification documents cannot exceed 500MB in total. Remove some files and try again.',
          413
        );
        return;
      }
    }

    // 3. Process documents one-by-one so a large set does not fail the whole onboard
    const processedDocuments: Array<{ title: string; type: DocumentType; fileUrl: string }> = [];
    const failedDocuments: string[] = [];
    if (Array.isArray(documents) && documents.length > 0) {
      for (const doc of documents) {
        if (!doc.fileUrl) continue;
        const uploadedUrl = await resolveHostedUrl(doc.fileUrl, 'servfex/documents');
        if (!uploadedUrl) {
          failedDocuments.push(doc.title?.trim() || 'Verification Document');
          continue;
        }
        processedDocuments.push({
          title: doc.title?.trim() || 'Verification Document',
          type: (doc.type as DocumentType) || 'OTHER',
          fileUrl: uploadedUrl,
        });
      }
    }

    if (documents?.length > 0 && processedDocuments.length === 0) {
      sendError(
        res,
        'DOCUMENT_UPLOAD_FAILED',
        'None of the verification documents could be stored. Please attach them again and retry.',
        400
      );
      return;
    }

    if (failedDocuments.length > 0) {
      console.warn('[Partner] Skipped documents that failed to host:', failedDocuments);
    }

    // 4. If user already exists in Firebase, grab their UID; if password provided, provision Firebase account
    let firebaseUid: string | null = existingUser?.firebaseUid || null;
    try {
      const existingFbUser = await getFirebaseAuth().getUserByEmail(cleanEmail);
      firebaseUid = existingFbUser.uid;
      if (password) {
        await getFirebaseAuth().updateUser(firebaseUid, { password });
      }
    } catch (fbErr: any) {
      if (fbErr.code === 'auth/user-not-found') {
        if (password) {
          const fbUser = await getFirebaseAuth().createUser({
            email: cleanEmail,
            password,
            displayName: finalName,
          });
          firebaseUid = fbUser.uid;
        }
      } else {
        throw fbErr;
      }
    }

    // If a user in DB has this firebaseUid, ensure we associate with them
    if (firebaseUid && !existingUser) {
      const userWithUid = await prisma.user.findUnique({
        where: { firebaseUid },
        include: { vendorProfile: true },
      });
      if (userWithUid) {
        existingUser = userWithUid;
      }
    }

    const assignedPassword = password || 'ServFex@2026';
    const passwordHash = await hashPassword(assignedPassword);

    // 5. Create or attach VendorProfile in PostgreSQL
    const newVendor = await prisma.$transaction(async (tx) => {
      let vendorProfile;
      let targetUserId: string;

      if (existingUser) {
        targetUserId = existingUser.id;
        // User already exists - update user and attach/reactivate vendor profile
        await tx.user.update({
          where: { id: existingUser.id },
          data: {
            name: finalName,
            email: cleanEmail,
            phone: phone || existingUser.phone,
            passwordHash: password ? passwordHash : (existingUser.passwordHash || passwordHash),
            firebaseUid: firebaseUid || existingUser.firebaseUid,
            profilePhotoUrl: uploadedPartnerImage || existingUser.profilePhotoUrl,
            status: 'ACTIVE',
            isVerified: true,
            deletedAt: null,
            role: 'VENDOR',
          },
        });

        if (existingUser.vendorProfile) {
          vendorProfile = await tx.vendorProfile.update({
            where: { id: existingUser.vendorProfile.id },
            data: {
              companyName: finalCompanyName,
              businessLicense: businessLicense || null,
              taxId: taxId || null,
              location: finalLocation,
              warehouseName: warehouseName || null,
              warehouseLocation: finalWarehouseLocation,
              warehousePhone: warehousePhone || null,
              warehouseImageUrl: uploadedWarehouseImage || null,
              latitude: latitude !== undefined ? latitude : null,
              longitude: longitude !== undefined ? longitude : null,
              bio: bio || null,
              commissionRate: new Prisma.Decimal(commissionRate || 15.0),
              kycStatus: 'APPROVED',
              isActive: true,
            },
          });
        } else {
          vendorProfile = await tx.vendorProfile.create({
            data: {
              userId: existingUser.id,
              companyName: finalCompanyName,
              businessLicense: businessLicense || null,
              taxId: taxId || null,
              location: finalLocation,
              warehouseName: warehouseName || null,
              warehouseLocation: finalWarehouseLocation,
              warehousePhone: warehousePhone || null,
              warehouseImageUrl: uploadedWarehouseImage || null,
              latitude: latitude !== undefined ? latitude : null,
              longitude: longitude !== undefined ? longitude : null,
              bio: bio || null,
              commissionRate: new Prisma.Decimal(commissionRate || 15.0),
              kycStatus: 'APPROVED',
              isActive: true,
            },
          });
        }
      } else {
        // Create new user and vendor profile
        const user = await tx.user.create({
          data: {
            name: finalName,
            email: cleanEmail,
            phone: phone || null,
            passwordHash,
            firebaseUid,
            profilePhotoUrl: uploadedPartnerImage || null,
            role: 'VENDOR',
            status: 'ACTIVE',
            isVerified: true,
            vendorProfile: {
              create: {
                companyName: finalCompanyName,
                businessLicense: businessLicense || null,
                taxId: taxId || null,
                location: finalLocation,
                warehouseName: warehouseName || null,
                warehouseLocation: finalWarehouseLocation,
                warehousePhone: warehousePhone || null,
                warehouseImageUrl: uploadedWarehouseImage || null,
                latitude: latitude !== undefined ? latitude : null,
                longitude: longitude !== undefined ? longitude : null,
                bio: bio || null,
                commissionRate: new Prisma.Decimal(commissionRate || 15.0),
                kycStatus: 'APPROVED',
                isActive: true,
              },
            },
          },
          include: { vendorProfile: true },
        });
        targetUserId = user.id;
        vendorProfile = user.vendorProfile!;
      }

      // Persist any attached verification documents
      if (processedDocuments.length > 0) {
        for (const doc of processedDocuments) {
          await tx.document.create({
            data: {
              userId: targetUserId,
              type: doc.type,
              title: doc.title,
              fileUrl: doc.fileUrl,
              verificationStatus: 'APPROVED',
              verifiedAt: new Date(),
            },
          });
        }
      }

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'VENDOR_CREATED',
        entityType: 'VendorProfile',
        entityId: vendorProfile.id,
        after: {
          companyName: finalCompanyName,
          email: cleanEmail,
          location: finalLocation,
          warehouseName,
          warehouseLocation: finalWarehouseLocation,
          warehousePhone,
        },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return vendorProfile;
    }, { maxWait: 15000, timeout: 30000 });

    // Send ServFex Provider Welcome Email with Hub location details and credentials
    sendProviderWelcomeEmail({
      toEmail: cleanEmail,
      name: finalName,
      companyName: finalCompanyName,
      location: finalLocation,
      warehouseName: warehouseName || null,
      warehouseLocation: finalWarehouseLocation || null,
      warehousePhone: warehousePhone || null,
      phone: phone || null,
      password: assignedPassword,
    }).catch((emailErr) => {
      console.warn('[Partner] Notice sending provider welcome email:', emailErr?.message || emailErr);
    });

    sendSuccess(res, newVendor, 201);
  } catch (error) {
    next(error);
  }
};

export const approveKyc = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { reason } = req.body;

    const vendor = await prisma.vendorProfile.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!vendor) {
      sendError(res, 'VENDOR_NOT_FOUND', 'Vendor not found', 404);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const v = await tx.vendorProfile.update({
        where: { id },
        data: {
          kycStatus: 'APPROVED',
          kycRejectionReason: null,
          isActive: true,
        },
      });

      await tx.user.update({
        where: { id: vendor.userId },
        data: { isVerified: true, status: 'ACTIVE' },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'VENDOR_APPROVED',
        entityType: 'VendorProfile',
        entityId: id,
        before: { kycStatus: vendor.kycStatus },
        after: { kycStatus: 'APPROVED' },
        reason: reason || 'Approved by Super Admin',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return v;
    });

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
};

export const rejectKyc = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { reason } = req.body;

    const vendor = await prisma.vendorProfile.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!vendor) {
      sendError(res, 'VENDOR_NOT_FOUND', 'Vendor not found', 404);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const v = await tx.vendorProfile.update({
        where: { id },
        data: {
          kycStatus: 'REJECTED',
          kycRejectionReason: reason,
          isActive: false,
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'VENDOR_REJECTED',
        entityType: 'VendorProfile',
        entityId: id,
        before: { kycStatus: vendor.kycStatus },
        after: { kycStatus: 'REJECTED', reason },
        reason,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return v;
    });

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
};

export const suspendVendor = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { reason } = req.body;

    const vendor = await prisma.vendorProfile.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!vendor) {
      sendError(res, 'VENDOR_NOT_FOUND', 'Vendor not found', 404);
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.vendorProfile.update({
        where: { id },
        data: { isActive: false },
      });

      await tx.user.update({
        where: { id: vendor.userId },
        data: { status: 'SUSPENDED' },
      });

      // Revoke sessions
      await tx.session.updateMany({
        where: { userId: vendor.userId, isValid: true },
        data: { isValid: false },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'VENDOR_SUSPENDED',
        entityType: 'VendorProfile',
        entityId: id,
        before: { isActive: vendor.isActive, status: vendor.user?.status || 'ACTIVE' },
        after: { isActive: false, status: 'SUSPENDED' },
        reason: reason || 'Suspended by Super Admin',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });
    });

    sendSuccess(res, { message: 'Vendor successfully suspended' });
  } catch (error) {
    next(error);
  }
};

export const reactivateVendor = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { reason } = req.body;

    const vendor = await prisma.vendorProfile.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!vendor) {
      sendError(res, 'VENDOR_NOT_FOUND', 'Vendor not found', 404);
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.vendorProfile.update({
        where: { id },
        data: { isActive: true },
      });

      await tx.user.update({
        where: { id: vendor.userId },
        data: { status: 'ACTIVE' },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'VENDOR_REACTIVATED',
        entityType: 'VendorProfile',
        entityId: id,
        before: { isActive: vendor.isActive },
        after: { isActive: true },
        reason: reason || 'Reactivated by Super Admin',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });
    });

    sendSuccess(res, { message: 'Vendor successfully reactivated' });
  } catch (error) {
    next(error);
  }
};

export const updateVendor = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const {
      companyName,
      location,
      bio,
      businessLicense,
      taxId,
      commissionRate,
      latitude,
      longitude,
      warehouseName,
      warehouseLocation,
      warehousePhone,
      warehouseImageUrl,
      reason,
    } = req.body;

    const vendor = await prisma.vendorProfile.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!vendor) {
      sendError(res, 'VENDOR_NOT_FOUND', 'Vendor not found', 404);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const data: any = {};
      if (companyName !== undefined) data.companyName = companyName;
      if (location !== undefined) data.location = location;
      if (bio !== undefined) data.bio = bio;
      if (businessLicense !== undefined) data.businessLicense = businessLicense;
      if (taxId !== undefined) data.taxId = taxId;
      if (commissionRate !== undefined) data.commissionRate = new Prisma.Decimal(commissionRate);
      if (latitude !== undefined) data.latitude = latitude;
      if (longitude !== undefined) data.longitude = longitude;
      if (warehouseName !== undefined) data.warehouseName = warehouseName;
      if (warehouseLocation !== undefined) data.warehouseLocation = warehouseLocation;
      if (warehousePhone !== undefined) data.warehousePhone = warehousePhone;
      if (warehouseImageUrl !== undefined) data.warehouseImageUrl = warehouseImageUrl;

      const v = await tx.vendorProfile.update({
        where: { id },
        data,
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'VENDOR_UPDATED',
        entityType: 'VendorProfile',
        entityId: id,
        before: { location: vendor.location, latitude: vendor.latitude, longitude: vendor.longitude },
        after: data,
        reason: reason || 'Vendor updated by Super Admin',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return v;
    });

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
};

export const addVendorDocument = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { type, title, fileUrl, verificationStatus } = req.body;

    const vendor = await prisma.vendorProfile.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!vendor) {
      sendError(res, 'VENDOR_NOT_FOUND', 'Vendor not found', 404);
      return;
    }

    if (estimatePayloadBytes(fileUrl) > MAX_DOCUMENT_BYTES) {
      sendError(res, 'PAYLOAD_TOO_LARGE', 'This document exceeds the 500MB limit.', 413);
      return;
    }

    const hostedUrl = await resolveHostedUrl(fileUrl, 'servfex/documents');
    if (!hostedUrl) {
      sendError(res, 'DOCUMENT_UPLOAD_FAILED', 'Could not store this document. Try a smaller file or a different format (PDF, PNG, JPG, WebP).', 400);
      return;
    }

    const document = await prisma.document.create({
      data: {
        userId: vendor.userId,
        type: type as DocumentType,
        title: title.trim(),
        fileUrl: hostedUrl,
        verificationStatus: (verificationStatus as KycStatus) || 'APPROVED',
        verifiedAt: verificationStatus === 'APPROVED' ? new Date() : null,
      },
    });

    await logAuditEvent({
      superAdminId: req.user!.userId,
      action: 'DOCUMENT_UPLOADED',
      entityType: 'Document',
      entityId: document.id,
      after: { title, type, vendorId: id },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    sendSuccess(res, document, 201);
  } catch (error) {
    next(error);
  }
};

export const deleteVendorDocument = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id, documentId } = req.params as { id: string; documentId: string };

    const vendor = await prisma.vendorProfile.findUnique({
      where: { id },
    });

    if (!vendor) {
      sendError(res, 'VENDOR_NOT_FOUND', 'Vendor not found', 404);
      return;
    }

    const doc = await prisma.document.findFirst({
      where: { id: documentId, userId: vendor.userId },
    });

    if (!doc) {
      sendError(res, 'DOCUMENT_NOT_FOUND', 'Document not found', 404);
      return;
    }

    await prisma.document.delete({
      where: { id: documentId },
    });

    await logAuditEvent({
      superAdminId: req.user!.userId,
      action: 'DOCUMENT_DELETED',
      entityType: 'Document',
      entityId: documentId,
      before: { title: doc.title, type: doc.type },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    sendSuccess(res, { message: 'Document removed successfully' });
  } catch (error) {
    next(error);
  }
};

export const deleteVendor = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { reason } = req.body || {};

    const vendor = await prisma.vendorProfile.findFirst({
      where: { id },
      include: {
        user: true,
        employees: {
          include: {
            user: true,
          },
        },
      },
    });

    if (!vendor) {
      sendError(res, 'VENDOR_NOT_FOUND', 'Vendor not found', 404);
      return;
    }

    const employeeIds = vendor.employees.map((e) => e.id);
    const employeeUserIds = vendor.employees.map((e) => e.userId);
    const allUserIdsToDelete = [vendor.userId, ...employeeUserIds];

    await prisma.$transaction(
      async (tx) => {
        // 1. Unlink bookings and reviews from vendor and all its employees in parallel
        await Promise.all([
          tx.booking.updateMany({
            where: {
              OR: [
                { vendorId: id },
                ...(employeeIds.length > 0 ? [{ employeeId: { in: employeeIds } }] : []),
              ],
            },
            data: {
              vendorId: null,
              employeeId: null,
            },
          }),
          tx.review.updateMany({
            where: {
              OR: [
                { vendorId: id },
                ...(employeeIds.length > 0 ? [{ employeeId: { in: employeeIds } }] : []),
              ],
            },
            data: {
              vendorId: null,
              employeeId: null,
            },
          }),
        ]);

        // 2. Delete VendorProfile (Postgres/Prisma cascades automatically delete VendorServices, EmployeeProfiles, EmployeeFeedbacks)
        await tx.vendorProfile.delete({
          where: { id },
        });

        // 3. Delete all associated user accounts (cascades to Sessions and Documents)
        await tx.user.deleteMany({
          where: { id: { in: allUserIdsToDelete } },
        });

        // 4. Audit log
        await logAuditEvent({
          superAdminId: req.user!.userId,
          action: 'VENDOR_DELETED',
          entityType: 'VendorProfile',
          entityId: id,
          before: { companyName: vendor.companyName, email: vendor.user.email },
          after: { deleted: true },
          reason: reason || 'Deleted by Super Admin',
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          tx,
        });
      },
      {
        timeout: 30000,
        maxWait: 15000,
      }
    );

    // 5. Delete users from Firebase Auth
    const firebaseUidsToDelete: string[] = [];
    if (vendor.user.firebaseUid) {
      firebaseUidsToDelete.push(vendor.user.firebaseUid);
    }
    for (const emp of vendor.employees) {
      if (emp.user?.firebaseUid) {
        firebaseUidsToDelete.push(emp.user.firebaseUid);
      }
    }

    for (const uid of firebaseUidsToDelete) {
      try {
        await getFirebaseAuth().deleteUser(uid);
      } catch (fbErr: any) {
        if (fbErr.code !== 'auth/user-not-found') {
          console.warn(`[DeleteVendor] Firebase user ${uid} deletion warning:`, fbErr);
        }
      }
    }

    sendSuccess(res, { message: 'Vendor successfully deleted' });
  } catch (error) {
    next(error);
  }
};

export const assignVendorService = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const vendorId = req.params.id as string;
    const { serviceId, customPrice, availability, isActive } = req.body;

    if (!serviceId) {
      sendError(res, 'BAD_REQUEST', 'Service ID is required', 400);
      return;
    }

    const vendor = await prisma.vendorProfile.findUnique({
      where: { id: vendorId },
    });
    if (!vendor) {
      sendError(res, 'VENDOR_NOT_FOUND', 'Vendor not found', 404);
      return;
    }

    const service = await prisma.service.findUnique({
      where: { id: serviceId },
    });
    if (!service) {
      sendError(res, 'SERVICE_NOT_FOUND', 'Service not found', 404);
      return;
    }

    const vendorService = await prisma.vendorService.upsert({
      where: {
        vendorId_serviceId: { vendorId, serviceId },
      },
      create: {
        vendorId,
        serviceId,
        customPrice: customPrice !== undefined && customPrice !== '' && customPrice !== null ? new Prisma.Decimal(customPrice) : null,
        availability: availability || 'Mon-Sat: 09:00 - 18:00',
        isActive: isActive !== undefined ? isActive : true,
      },
      update: {
        ...(customPrice !== undefined ? { customPrice: customPrice !== '' && customPrice !== null ? new Prisma.Decimal(customPrice) : null } : {}),
        ...(availability ? { availability } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
      include: {
        service: {
          select: { id: true, name: true, startingPrice: true },
        },
      },
    });

    await logAuditEvent({
      superAdminId: req.user!.userId,
      action: 'VENDOR_SERVICE_ASSIGNED',
      entityType: 'VendorService',
      entityId: vendorService.id,
      after: { vendorId, serviceId, customPrice },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    sendSuccess(res, vendorService, 201);
  } catch (error) {
    next(error);
  }
};

export const removeVendorService = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id: vendorId, serviceId } = req.params as { id: string; serviceId: string };

    await prisma.vendorService.deleteMany({
      where: {
        vendorId,
        serviceId,
      },
    });

    await logAuditEvent({
      superAdminId: req.user!.userId,
      action: 'VENDOR_SERVICE_REMOVED',
      entityType: 'VendorService',
      entityId: `${vendorId}_${serviceId}`,
      before: { vendorId, serviceId },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    sendSuccess(res, { message: 'Service removed from vendor successfully' });
  } catch (error) {
    next(error);
  }
};
