import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendError, sendSuccess } from '../utils/response';
import { logAuditEvent } from '../utils/audit';
import { Prisma } from '@prisma/client';
import { uploadToCloudinary } from '../utils/cloudinary';
import { invalidateCatalogCache } from './catalog.controller';

export const listServicesQuerySchema = z.object({
  query: z.object({
    page: z.string().optional().default('1').transform((v) => Math.max(1, parseInt(v, 10))),
    limit: z.string().optional().default('20').transform((v) => Math.min(100, Math.max(1, parseInt(v, 10)))),
    categoryId: z.string().optional(),
    search: z.string().optional(),
    isActive: z.string().optional().transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
    sortBy: z.enum(['createdAt', 'name', 'startingPrice', 'rating']).optional().default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
  }),
});

export const createServiceSchema = z.object({
  body: z.object({
    categoryId: z.string().uuid(),
    subCategoryId: z.string().uuid().optional().nullable(),
    name: z.string().min(2),
    slug: z.string().min(2),
    description: z.string().min(5),
    startingPrice: z.number().min(0),
    priceUnit: z.string().optional().default('per service'),
    durationText: z.string().optional().default('60 mins'),
    iconUrl: z.string().optional().nullable(),       // PNG icon for tile
    bannerImages: z.array(z.string()).max(3).optional().default([]),
    bannerVideo: z.string().optional().nullable(),
    isPopular: z.boolean().optional().default(false),
    isActive: z.boolean().optional().default(true),
  }),
});

export const updateServiceSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    categoryId: z.string().uuid().optional(),
    subCategoryId: z.string().uuid().optional().nullable(),
    name: z.string().min(2).optional(),
    slug: z.string().min(2).optional(),
    description: z.string().min(5).optional(),
    startingPrice: z.number().min(0).optional(),
    priceUnit: z.string().optional(),
    durationText: z.string().optional(),
    iconUrl: z.string().optional().nullable(),
    bannerImages: z.array(z.string()).max(3).optional(),
    bannerVideo: z.string().optional().nullable(),
    isPopular: z.boolean().optional(),
    isActive: z.boolean().optional(),
    reason: z.string().optional(),
  }),
});

export const vendorPricingSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    vendorId: z.string().uuid(),
    customPrice: z.number().min(0).optional(),
    isActive: z.boolean().optional(),
    availability: z.string().optional(),
    reason: z.string().optional(),
  }),
});

export const getServices = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, limit, categoryId, search, isActive, sortBy, sortOrder } = req.query as any;
    const skip = (page - 1) * limit;

    const where: any = {
      deletedAt: null,
    };

    if (categoryId) {
      where.categoryId = categoryId;
    }

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [total, services] = await Promise.all([
      prisma.service.count({ where }),
      prisma.service.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          category: { select: { id: true, name: true } },
          subCategory: { select: { id: true, name: true } },
          packages: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }] },
          _count: {
            select: { vendorServices: true, bookings: true },
          },
        },
      }),
    ]);

    sendSuccess(res, services, 200, {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    next(error);
  }
};

export const getServiceById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;

    const service = await prisma.service.findFirst({
      where: { id, deletedAt: null },
      include: {
        category: true,
        packages: true,
        vendorServices: {
          include: {
            vendor: {
              select: {
                id: true,
                companyName: true,
                rating: true,
                user: { select: { name: true, phone: true } },
              },
            },
          },
        },
        _count: {
          select: { bookings: true, reviews: true },
        },
      },
    });

    if (!service) {
      sendError(res, 'SERVICE_NOT_FOUND', 'Service not found', 404);
      return;
    }

    sendSuccess(res, service);
  } catch (error) {
    next(error);
  }
};

export const createService = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const {
      categoryId,
      subCategoryId,
      name,
      slug,
      description,
      startingPrice,
      priceUnit,
      durationText,
      iconUrl,
      bannerImages,
      bannerVideo,
      isPopular,
      isActive,
    } = req.body;

    const existingSlug = await prisma.service.findUnique({ where: { slug: slug.toLowerCase() } });
    if (existingSlug) {
      sendError(res, 'SLUG_EXISTS', 'A service with this slug already exists', 409);
      return;
    }

    // Upload icon PNG to Cloudinary
    let uploadedIconUrl = iconUrl || null;
    if (iconUrl && (iconUrl.startsWith('data:') || iconUrl.startsWith('http'))) {
      try {
        uploadedIconUrl = await uploadToCloudinary(iconUrl, 'servfex/services/icons');
      } catch (e) {
        console.error('[Service] Icon upload warning:', e);
      }
    }

    // Upload up to 3 banner images in parallel
    const uploadedBanners: string[] = [];
    if (bannerImages && bannerImages.length > 0) {
      const toUpload = bannerImages.slice(0, 3);
      const results = await Promise.allSettled(
        toUpload.map((img: string) => uploadToCloudinary(img, 'servfex/services/banners'))
      );
      results.forEach((r, i) => {
        uploadedBanners.push(r.status === 'fulfilled' ? r.value : toUpload[i]);
      });
    }

    // Upload banner video
    let uploadedBannerVideo = bannerVideo || null;
    if (bannerVideo && (bannerVideo.startsWith('data:') || bannerVideo.startsWith('http'))) {
      try {
        uploadedBannerVideo = await uploadToCloudinary(bannerVideo, 'servfex/services/videos');
      } catch (e) {
        console.error('[Service] Video upload warning:', e);
      }
    }

    const service = await prisma.$transaction(async (tx) => {
      const s = await tx.service.create({
        data: {
          categoryId,
          subCategoryId: subCategoryId || null,
          name,
          slug: slug.toLowerCase(),
          description,
          startingPrice: new Prisma.Decimal(startingPrice),
          priceUnit: priceUnit || 'per service',
          durationText: durationText || '60 mins',
          iconUrl: uploadedIconUrl,
          bannerImages: uploadedBanners,
          bannerVideo: uploadedBannerVideo,
          isPopular: isPopular || false,
          isActive: isActive !== undefined ? isActive : true,
        },
        include: {
          category: { select: { id: true, name: true } },
          subCategory: { select: { id: true, name: true } },
          packages: true,
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'SERVICE_CREATED',
        entityType: 'Service',
        entityId: s.id,
        after: { name, slug, startingPrice },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return s;
    });

    invalidateCatalogCache();
    sendSuccess(res, service, 201);
  } catch (error) {
    next(error);
  }
};


export const updateService = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const {
      categoryId,
      subCategoryId,
      name,
      slug,
      description,
      startingPrice,
      priceUnit,
      durationText,
      iconUrl,
      bannerImages,
      bannerVideo,
      isPopular,
      isActive,
      reason,
    } = req.body;

    const existing = await prisma.service.findUnique({ where: { id } });
    if (!existing) {
      sendError(res, 'SERVICE_NOT_FOUND', 'Service not found', 404);
      return;
    }

    // Upload new icon if provided
    let uploadedIconUrl = iconUrl;
    if (iconUrl && (iconUrl.startsWith('data:') || iconUrl.startsWith('http'))) {
      try {
        uploadedIconUrl = await uploadToCloudinary(iconUrl, 'servfex/services/icons');
      } catch (e) {
        console.error('[Service] Icon upload warning:', e);
      }
    }

    // Upload new banner images in parallel if provided
    let uploadedBanners: string[] | undefined;
    if (bannerImages !== undefined) {
      const toUpload = (bannerImages as string[]).slice(0, 3);
      const results = await Promise.allSettled(
        toUpload.map((img) => uploadToCloudinary(img, 'servfex/services/banners'))
      );
      uploadedBanners = results.map((r, i) =>
        r.status === 'fulfilled' ? r.value : toUpload[i]
      );
    }

    // Upload new banner video if provided
    let uploadedBannerVideo = bannerVideo;
    if (bannerVideo && (bannerVideo.startsWith('data:') || bannerVideo.startsWith('http'))) {
      try {
        uploadedBannerVideo = await uploadToCloudinary(bannerVideo, 'servfex/services/videos');
      } catch (e) {
        console.error('[Service] Video upload warning:', e);
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const s = await tx.service.update({
        where: { id },
        data: {
          ...(categoryId ? { categoryId } : {}),
          ...(subCategoryId !== undefined ? { subCategoryId: subCategoryId || null } : {}),
          ...(name ? { name } : {}),
          ...(slug ? { slug: slug.toLowerCase() } : {}),
          ...(description ? { description } : {}),
          ...(startingPrice !== undefined ? { startingPrice: new Prisma.Decimal(startingPrice) } : {}),
          ...(priceUnit ? { priceUnit } : {}),
          ...(durationText ? { durationText } : {}),
          ...(iconUrl !== undefined ? { iconUrl: uploadedIconUrl } : {}),
          ...(uploadedBanners !== undefined ? { bannerImages: uploadedBanners } : {}),
          ...(bannerVideo !== undefined ? { bannerVideo: uploadedBannerVideo } : {}),
          ...(isPopular !== undefined ? { isPopular } : {}),
          ...(isActive !== undefined ? { isActive } : {}),
        },
        include: {
          category: { select: { id: true, name: true } },
          subCategory: { select: { id: true, name: true } },
          packages: true,
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'SERVICE_UPDATED',
        entityType: 'Service',
        entityId: id,
        before: { name: existing.name, price: Number(existing.startingPrice) },
        after: { name: s.name, price: Number(s.startingPrice) },
        reason: reason || undefined,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return s;
    });

    invalidateCatalogCache();
    sendSuccess(res, updated);

  } catch (error) {
    next(error);
  }
};

export const setVendorPricing = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const serviceId = req.params.id as string;
    const { vendorId, customPrice, isActive, availability, reason } = req.body;

    const result = await prisma.$transaction(async (tx) => {
      const vendorService = await tx.vendorService.upsert({
        where: {
          vendorId_serviceId: { vendorId, serviceId },
        },
        create: {
          vendorId,
          serviceId,
          customPrice: customPrice !== undefined ? new Prisma.Decimal(customPrice) : null,
          isActive: isActive !== undefined ? isActive : true,
          availability: availability || 'Mon-Sat: 09:00 - 18:00',
        },
        update: {
          ...(customPrice !== undefined ? { customPrice: new Prisma.Decimal(customPrice) } : {}),
          ...(isActive !== undefined ? { isActive } : {}),
          ...(availability ? { availability } : {}),
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'VENDOR_SERVICE_PRICING_UPDATED',
        entityType: 'VendorService',
        entityId: vendorService.id,
        after: { vendorId, serviceId, customPrice },
        reason: reason || 'Vendor pricing adjusted by Super Admin',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return vendorService;
    });

    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
};

export const softDeleteService = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { reason } = req.body;

    const existing = await prisma.service.findUnique({ where: { id } });
    if (!existing) {
      sendError(res, 'SERVICE_NOT_FOUND', 'Service not found', 404);
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.service.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          isActive: false,
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'SERVICE_ARCHIVED',
        entityType: 'Service',
        entityId: id,
        before: { isActive: existing.isActive },
        after: { isActive: false, deletedAt: new Date() },
        reason: reason || 'Archived by Super Admin',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });
    });

    invalidateCatalogCache();
    sendSuccess(res, { message: 'Service successfully archived' });
  } catch (error) {
    next(error);
  }
};
