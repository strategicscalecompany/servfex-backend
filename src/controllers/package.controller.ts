import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendError, sendSuccess } from '../utils/response';
import { logAuditEvent } from '../utils/audit';
import { uploadToCloudinary } from '../utils/cloudinary';
import { Prisma } from '@prisma/client';

// ==========================================
// VALIDATION SCHEMAS
// ==========================================

const processStepSchema = z.object({
  stepNumber: z.number().int().optional(),
  title: z.string().min(1),
  description: z.string(),
  imageUrl: z.string().optional().nullable(),
});

const requirementSchema = z.object({
  iconUrl: z.string(),
  label: z.string().min(1),
});

const faqSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
});

export const createPackageSchema = z.object({
  body: z.object({
    // Identity
    name: z.string().min(2),
    shortDescription: z.string().optional(),
    badgeText: z.string().optional(),

    // Pricing
    originalPrice: z.number().min(0),
    discountedPrice: z.number().min(0),
    savingsLabel: z.string().optional(),
    pricePerUnitLabel: z.string().optional(),
    duration: z.string().optional().default('60 mins'),

    // Media
    cardImage: z.string().optional(),
    detailBannerImages: z.array(z.string()).max(4).optional().default([]),

    // Detail content
    highlights: z.array(z.string()).optional().default([]),
    processSteps: z.array(processStepSchema).optional().default([]),
    whatsIncluded: z.array(z.string()).optional().default([]),
    requirements: z.array(requirementSchema).optional().default([]),
    pleaseNote: z.array(z.string()).optional().default([]),
    faqs: z.array(faqSchema).optional().default([]),

    // Meta
    displayOrder: z.number().int().optional().default(0),
    isPopular: z.boolean().optional().default(false),
    isActive: z.boolean().optional().default(true),
  }),
});

export const updatePackageSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    name: z.string().min(2).optional(),
    shortDescription: z.string().optional().nullable(),
    badgeText: z.string().optional().nullable(),
    originalPrice: z.number().min(0).optional(),
    discountedPrice: z.number().min(0).optional(),
    savingsLabel: z.string().optional().nullable(),
    pricePerUnitLabel: z.string().optional().nullable(),
    duration: z.string().optional(),
    cardImage: z.string().optional().nullable(),
    detailBannerImages: z.array(z.string()).max(4).optional(),
    highlights: z.array(z.string()).optional(),
    processSteps: z.array(processStepSchema).optional(),
    whatsIncluded: z.array(z.string()).optional(),
    requirements: z.array(requirementSchema).optional(),
    pleaseNote: z.array(z.string()).optional(),
    faqs: z.array(faqSchema).optional(),
    displayOrder: z.number().int().optional(),
    isPopular: z.boolean().optional(),
    isActive: z.boolean().optional(),
    reason: z.string().optional(),
  }),
});

export const reorderPackagesSchema = z.object({
  body: z.object({
    orders: z.array(z.object({ id: z.string().uuid(), displayOrder: z.number().int() })),
  }),
});

// ==========================================
// HELPERS
// ==========================================

/**
 * Upload banner images array to Cloudinary in parallel
 */
async function uploadBannerImages(images: string[]): Promise<string[]> {
  return Promise.all(
    images.map(async (img) => {
      if (!img) return img;
      try {
        return await uploadToCloudinary(img, 'servfex/packages/banners');
      } catch {
        return img; // fallback to original on upload error
      }
    })
  );
}

/**
 * Upload requirement icons to Cloudinary in parallel
 */
async function uploadRequirementIcons(requirements: Array<{ iconUrl: string; label: string }>): Promise<typeof requirements> {
  return Promise.all(
    requirements.map(async (req) => {
      if (!req.iconUrl) return req;
      try {
        const uploaded = await uploadToCloudinary(req.iconUrl, 'servfex/packages/icons');
        return { ...req, iconUrl: uploaded };
      } catch {
        return req;
      }
    })
  );
}

/**
 * Upload process step images to Cloudinary in parallel
 */
async function uploadProcessStepImages(steps: Array<{ title: string; description: string; imageUrl?: string | null; stepNumber?: number }>): Promise<typeof steps> {
  return Promise.all(
    steps.map(async (step, idx) => {
      if (!step.imageUrl) return { ...step, stepNumber: step.stepNumber ?? idx + 1 };
      try {
        const uploaded = await uploadToCloudinary(step.imageUrl, 'servfex/packages/steps');
        return { ...step, stepNumber: step.stepNumber ?? idx + 1, imageUrl: uploaded };
      } catch {
        return { ...step, stepNumber: step.stepNumber ?? idx + 1 };
      }
    })
  );
}

// ==========================================
// CONTROLLERS
// ==========================================

/**
 * GET /admin/services/:serviceId/packages
 * List all packages for a service
 */
export const getPackages = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const serviceId = req.params.serviceId as string;

    const service = await prisma.service.findUnique({
      where: { id: serviceId, deletedAt: null },
    });
    if (!service) {
      sendError(res, 'SERVICE_NOT_FOUND', 'Service not found', 404);
      return;
    }

    const packages = await prisma.servicePackage.findMany({
      where: { serviceId, isActive: true },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });

    sendSuccess(res, packages);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /admin/packages/:id
 * Get full package detail
 */
export const getPackageById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;

    const pkg = await prisma.servicePackage.findUnique({
      where: { id },
      include: {
        service: {
          select: { id: true, name: true, categoryId: true },
        },
      },
    });

    if (!pkg) {
      sendError(res, 'PACKAGE_NOT_FOUND', 'Package not found', 404);
      return;
    }

    sendSuccess(res, pkg);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /admin/services/:serviceId/packages
 * Create a new package under a service
 */
export const createPackage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const serviceId = req.params.serviceId as string;
    const {
      name, shortDescription, badgeText,
      originalPrice, discountedPrice, savingsLabel, pricePerUnitLabel, duration,
      cardImage, detailBannerImages,
      highlights, processSteps, whatsIncluded, requirements, pleaseNote, faqs,
      displayOrder, isPopular, isActive,
    } = req.body;

    const service = await prisma.service.findUnique({ where: { id: serviceId, deletedAt: null } });
    if (!service) {
      sendError(res, 'SERVICE_NOT_FOUND', 'Service not found', 404);
      return;
    }

    // Upload all media in parallel
    const [
      uploadedCardImage,
      uploadedBanners,
      uploadedSteps,
      uploadedRequirements,
    ] = await Promise.all([
      cardImage ? uploadToCloudinary(cardImage, 'servfex/packages/cards').catch(() => cardImage) : Promise.resolve(null),
      uploadBannerImages(detailBannerImages || []),
      uploadProcessStepImages(processSteps || []),
      uploadRequirementIcons(requirements || []),
    ]);

    const pkg = await prisma.$transaction(async (tx) => {
      const created = await tx.servicePackage.create({
        data: {
          serviceId,
          name,
          shortDescription: shortDescription || null,
          badgeText: badgeText || null,
          originalPrice: new Prisma.Decimal(originalPrice),
          discountedPrice: new Prisma.Decimal(discountedPrice),
          savingsLabel: savingsLabel || null,
          pricePerUnitLabel: pricePerUnitLabel || null,
          duration: duration || '60 mins',
          cardImage: uploadedCardImage || null,
          detailBannerImages: uploadedBanners,
          highlights: highlights || [],
          processSteps: uploadedSteps as any,
          whatsIncluded: whatsIncluded || [],
          requirements: uploadedRequirements as any,
          pleaseNote: pleaseNote || [],
          faqs: faqs || [],
          displayOrder: displayOrder ?? 0,
          isPopular: isPopular || false,
          isActive: isActive !== undefined ? isActive : true,
          // Keep legacy fields populated for backwards compat
          title: name,
          description: shortDescription || name,
          price: new Prisma.Decimal(discountedPrice),
          durationMinutes: 60,
          features: highlights || [],
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'PACKAGE_CREATED',
        entityType: 'ServicePackage',
        entityId: created.id,
        after: { name, serviceId, discountedPrice },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return created;
    });

    sendSuccess(res, pkg, 201);
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /admin/packages/:id
 * Update a package
 */
export const updatePackage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const {
      name, shortDescription, badgeText,
      originalPrice, discountedPrice, savingsLabel, pricePerUnitLabel, duration,
      cardImage, detailBannerImages,
      highlights, processSteps, whatsIncluded, requirements, pleaseNote, faqs,
      displayOrder, isPopular, isActive, reason,
    } = req.body;

    const existing = await prisma.servicePackage.findUnique({ where: { id } });
    if (!existing) {
      sendError(res, 'PACKAGE_NOT_FOUND', 'Package not found', 404);
      return;
    }

    // Upload new media in parallel (only if provided)
    const [uploadedCardImage, uploadedBanners, uploadedSteps, uploadedRequirements] = await Promise.all([
      cardImage !== undefined
        ? (cardImage ? uploadToCloudinary(cardImage, 'servfex/packages/cards').catch(() => cardImage) : Promise.resolve(null))
        : Promise.resolve(undefined),
      detailBannerImages ? uploadBannerImages(detailBannerImages) : Promise.resolve(undefined),
      processSteps ? uploadProcessStepImages(processSteps) : Promise.resolve(undefined),
      requirements ? uploadRequirementIcons(requirements) : Promise.resolve(undefined),
    ]);

    const updated = await prisma.$transaction(async (tx) => {
      const pkg = await tx.servicePackage.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name, title: name } : {}),
          ...(shortDescription !== undefined ? { shortDescription, description: shortDescription } : {}),
          ...(badgeText !== undefined ? { badgeText } : {}),
          ...(originalPrice !== undefined ? { originalPrice: new Prisma.Decimal(originalPrice) } : {}),
          ...(discountedPrice !== undefined ? {
            discountedPrice: new Prisma.Decimal(discountedPrice),
            price: new Prisma.Decimal(discountedPrice),
          } : {}),
          ...(savingsLabel !== undefined ? { savingsLabel } : {}),
          ...(pricePerUnitLabel !== undefined ? { pricePerUnitLabel } : {}),
          ...(duration !== undefined ? { duration } : {}),
          ...(uploadedCardImage !== undefined ? { cardImage: uploadedCardImage } : {}),
          ...(uploadedBanners !== undefined ? { detailBannerImages: uploadedBanners } : {}),
          ...(highlights !== undefined ? { highlights, features: highlights } : {}),
          ...(uploadedSteps !== undefined ? { processSteps: uploadedSteps as any } : {}),
          ...(whatsIncluded !== undefined ? { whatsIncluded } : {}),
          ...(uploadedRequirements !== undefined ? { requirements: uploadedRequirements as any } : {}),
          ...(pleaseNote !== undefined ? { pleaseNote } : {}),
          ...(faqs !== undefined ? { faqs } : {}),
          ...(displayOrder !== undefined ? { displayOrder } : {}),
          ...(isPopular !== undefined ? { isPopular } : {}),
          ...(isActive !== undefined ? { isActive } : {}),
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'PACKAGE_UPDATED',
        entityType: 'ServicePackage',
        entityId: id,
        before: { name: existing.name },
        after: { name: pkg.name },
        reason: reason || undefined,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return pkg;
    });

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /admin/packages/reorder
 * Bulk reorder packages within a service
 */
export const reorderPackages = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { orders } = req.body;

    await prisma.$transaction(async (tx) => {
      for (const item of orders) {
        await tx.servicePackage.update({
          where: { id: item.id },
          data: { displayOrder: item.displayOrder },
        });
      }

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'PACKAGES_REORDERED',
        entityType: 'ServicePackage',
        entityId: 'BATCH',
        after: { count: orders.length },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });
    });

    sendSuccess(res, { message: 'Packages reordered successfully' });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /admin/packages/:id
 * Delete a package
 */
export const deletePackage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { reason } = req.body;

    const existing = await prisma.servicePackage.findUnique({ where: { id } });
    if (!existing) {
      sendError(res, 'PACKAGE_NOT_FOUND', 'Package not found', 404);
      return;
    }

    const hasBookings = await prisma.booking.count({ where: { packageId: id } });
    if (hasBookings > 0) {
      sendError(res, 'PACKAGE_HAS_BOOKINGS', 'Cannot delete a package that has existing bookings. Deactivate it instead.', 409);
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.servicePackage.delete({ where: { id } });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'PACKAGE_DELETED',
        entityType: 'ServicePackage',
        entityId: id,
        before: { name: existing.name, serviceId: existing.serviceId },
        reason: reason || 'Deleted by Super Admin',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });
    });

    sendSuccess(res, { message: 'Package deleted successfully' });
  } catch (error) {
    next(error);
  }
};
