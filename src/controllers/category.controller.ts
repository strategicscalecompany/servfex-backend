import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendError, sendSuccess } from '../utils/response';
import { logAuditEvent } from '../utils/audit';
import { uploadToCloudinary } from '../utils/cloudinary';
import { invalidateCatalogCache } from './catalog.controller';

export const createCategorySchema = z.object({
  body: z.object({
    name: z.string().min(2),
    slug: z.string().min(2),
    iconUrl: z.string().optional(),  // PNG/JPG Cloudinary URL or base64
    description: z.string().optional(),
    displayOrder: z.number().int().optional().default(0),
    isActive: z.boolean().optional().default(true),
  }),
});

export const updateCategorySchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    name: z.string().min(2).optional(),
    slug: z.string().min(2).optional(),
    iconUrl: z.string().optional().nullable(),  // PNG/JPG Cloudinary URL or base64
    description: z.string().optional(),
    displayOrder: z.number().int().optional(),
    isActive: z.boolean().optional(),
    reason: z.string().optional(),
  }),
});


export const reorderCategoriesSchema = z.object({
  body: z.object({
    orders: z.array(
      z.object({
        id: z.string().uuid(),
        displayOrder: z.number().int(),
      })
    ),
  }),
});

export const getCategories = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const categories = await prisma.serviceCategory.findMany({
      where: {
        OR: [
          { deletedAt: null },
          { deletedAt: { isSet: false } },
        ],
      },
      orderBy: { displayOrder: 'asc' },
      include: {
        subCategories: {
          where: { isActive: true },
          orderBy: { displayOrder: 'asc' },
          include: {
            _count: {
              select: {
                services: {
                  where: {
                    OR: [
                      { deletedAt: null },
                      { deletedAt: { isSet: false } },
                    ],
                  },
                },
              },
            },
          },
        },
        _count: {
          select: {
            services: {
              where: {
                OR: [
                  { deletedAt: null },
                  { deletedAt: { isSet: false } },
                ],
              },
            },
          },
        },
      },
    });

    sendSuccess(res, categories);
  } catch (error) {
    next(error);
  }
};

export const createCategory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, slug, iconUrl, description, displayOrder, isActive } = req.body;

    let finalSlug = slug.toLowerCase();
    let existing = await prisma.serviceCategory.findUnique({
      where: { slug: finalSlug },
    });

    let counter = 1;
    while (existing) {
      finalSlug = `${slug.toLowerCase()}-${counter}`;
      existing = await prisma.serviceCategory.findUnique({
        where: { slug: finalSlug },
      });
      counter++;
    }

    // Upload PNG icon to Cloudinary
    let uploadedIconUrl = iconUrl || null;
    if (iconUrl && (iconUrl.startsWith('data:') || iconUrl.startsWith('http'))) {
      try {
        uploadedIconUrl = await uploadToCloudinary(iconUrl, 'servfex/categories');
      } catch (uploadErr) {
        console.error('[Category] Cloudinary upload warning, saving fallback:', uploadErr);
      }
    }

    const category = await prisma.$transaction(async (tx) => {
      const cat = await tx.serviceCategory.create({
        data: {
          name,
          slug: finalSlug,
          iconUrl: uploadedIconUrl,
          description: description || null,
          displayOrder: displayOrder || 0,
          isActive: isActive !== undefined ? isActive : true,
          deletedAt: null,
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'CATEGORY_CREATED',
        entityType: 'ServiceCategory',
        entityId: cat.id,
        after: { name, slug },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return cat;
    });

    invalidateCatalogCache();
    sendSuccess(res, category, 201);
  } catch (error) {
    next(error);
  }
};


export const updateCategory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { name, slug, iconUrl, description, displayOrder, isActive, reason } = req.body;

    const category = await prisma.serviceCategory.findUnique({ where: { id } });
    if (!category) {
      sendError(res, 'CATEGORY_NOT_FOUND', 'Category not found', 404);
      return;
    }

    let uploadedIconUrl = iconUrl;
    if (iconUrl && (iconUrl.startsWith('data:') || iconUrl.startsWith('http'))) {
      try {
        uploadedIconUrl = await uploadToCloudinary(iconUrl, 'servfex/categories');
      } catch (uploadErr) {
        console.error('[Category] Cloudinary upload warning, saving fallback:', uploadErr);
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const cat = await tx.serviceCategory.update({
        where: { id },
        data: {
          ...(name ? { name } : {}),
          ...(slug ? { slug: slug.toLowerCase() } : {}),
          ...(iconUrl !== undefined ? { iconUrl: uploadedIconUrl } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(displayOrder !== undefined ? { displayOrder } : {}),
          ...(isActive !== undefined ? { isActive } : {}),
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'CATEGORY_UPDATED',
        entityType: 'ServiceCategory',
        entityId: id,
        before: { name: category.name, slug: category.slug, isActive: category.isActive },
        after: { name: cat.name, slug: cat.slug, isActive: cat.isActive },
        reason: reason || undefined,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return cat;
    });

    invalidateCatalogCache();
    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
};


export const reorderCategories = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { orders } = req.body;

    await prisma.$transaction(async (tx) => {
      for (const item of orders) {
        await tx.serviceCategory.update({
          where: { id: item.id },
          data: { displayOrder: item.displayOrder },
        });
      }

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'CATEGORIES_REORDERED',
        entityType: 'ServiceCategory',
        entityId: 'BATCH',
        after: { count: orders.length },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });
    });

    invalidateCatalogCache();
    sendSuccess(res, { message: 'Categories reordered successfully' });
  } catch (error) {
    next(error);
  }
};

export const softDeleteCategory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { reason } = req.body;

    const category = await prisma.serviceCategory.findUnique({ where: { id } });
    if (!category) {
      sendError(res, 'CATEGORY_NOT_FOUND', 'Category not found', 404);
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.serviceCategory.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          isActive: false,
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'CATEGORY_ARCHIVED',
        entityType: 'ServiceCategory',
        entityId: id,
        before: { isActive: category.isActive },
        after: { isActive: false, deletedAt: new Date() },
        reason: reason || 'Archived by Super Admin',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });
    });

    invalidateCatalogCache();
    sendSuccess(res, { message: 'Category archived successfully' });
  } catch (error) {
    next(error);
  }
};
