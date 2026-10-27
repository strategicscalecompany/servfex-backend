import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendError, sendSuccess } from '../utils/response';
import { logAuditEvent } from '../utils/audit';
import { uploadToCloudinary } from '../utils/cloudinary';

export const createSubCategorySchema = z.object({
  body: z.object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    iconUrl: z.string().optional(),
    displayOrder: z.number().int().optional().default(0),
    isActive: z.boolean().optional().default(true),
  }),
});

export const updateSubCategorySchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    name: z.string().min(2).optional(),
    iconUrl: z.string().optional().nullable(),
    displayOrder: z.number().int().optional(),
    isActive: z.boolean().optional(),
    reason: z.string().optional(),
  }),
});

export const reorderSubCategoriesSchema = z.object({
  body: z.object({
    orders: z.array(
      z.object({
        id: z.string().uuid(),
        displayOrder: z.number().int(),
      })
    ),
  }),
});

/**
 * GET /admin/categories/:categoryId/sub-categories
 * List all sub-categories for a category, ordered by displayOrder
 */
export const getSubCategories = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const categoryId = req.params.categoryId as string;

    const category = await prisma.serviceCategory.findUnique({
      where: { id: categoryId, deletedAt: null },
    });
    if (!category) {
      sendError(res, 'CATEGORY_NOT_FOUND', 'Category not found', 404);
      return;
    }

    const subCategories = await prisma.serviceSubCategory.findMany({
      where: { categoryId, isActive: true },
      orderBy: { displayOrder: 'asc' },
      include: {
        _count: {
          select: { services: { where: { deletedAt: null } } },
        },
      },
    });

    sendSuccess(res, subCategories);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /admin/categories/:categoryId/sub-categories
 * Create a new sub-category under a category
 */
export const createSubCategory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const categoryId = req.params.categoryId as string;
    const { name, iconUrl, displayOrder, isActive } = req.body;

    const category = await prisma.serviceCategory.findUnique({
      where: { id: categoryId, deletedAt: null },
    });
    if (!category) {
      sendError(res, 'CATEGORY_NOT_FOUND', 'Parent category not found', 404);
      return;
    }

    // Upload icon to Cloudinary if base64 or URL provided
    let finalIconUrl: string | null = iconUrl || null;
    if (iconUrl && (iconUrl.startsWith('data:') || iconUrl.startsWith('http'))) {
      try {
        finalIconUrl = await uploadToCloudinary(iconUrl, 'servfex/sub-categories');
      } catch (uploadErr) {
        console.error('[SubCategory] Cloudinary upload warning:', uploadErr);
      }
    }

    const subCategory = await prisma.$transaction(async (tx) => {
      const sc = await tx.serviceSubCategory.create({
        data: {
          categoryId,
          name: name.trim(),
          iconUrl: finalIconUrl,
          displayOrder: displayOrder ?? 0,
          isActive: isActive !== undefined ? isActive : true,
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'SUB_CATEGORY_CREATED',
        entityType: 'ServiceSubCategory',
        entityId: sc.id,
        after: { name, categoryId },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return sc;
    });

    sendSuccess(res, subCategory, 201);
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /admin/sub-categories/:id
 * Update a sub-category name, order, or active state
 */
export const updateSubCategory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { name, iconUrl, displayOrder, isActive, reason } = req.body;

    const existing = await prisma.serviceSubCategory.findUnique({ where: { id } });
    if (!existing) {
      sendError(res, 'SUB_CATEGORY_NOT_FOUND', 'Sub-category not found', 404);
      return;
    }

    // Upload icon to Cloudinary if base64 provided
    let finalIconUrl: string | null | undefined = undefined;
    if (iconUrl !== undefined) {
      if (iconUrl === null) {
        finalIconUrl = null;
      } else if (iconUrl.startsWith('data:') || iconUrl.startsWith('http')) {
        try {
          finalIconUrl = await uploadToCloudinary(iconUrl, 'servfex/sub-categories');
        } catch (uploadErr) {
          console.error('[SubCategory] Cloudinary upload warning:', uploadErr);
          finalIconUrl = iconUrl;
        }
      } else {
        finalIconUrl = iconUrl;
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const sc = await tx.serviceSubCategory.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name: name.trim() } : {}),
          ...(finalIconUrl !== undefined ? { iconUrl: finalIconUrl } : {}),
          ...(displayOrder !== undefined ? { displayOrder } : {}),
          ...(isActive !== undefined ? { isActive } : {}),
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'SUB_CATEGORY_UPDATED',
        entityType: 'ServiceSubCategory',
        entityId: id,
        before: { name: existing.name, isActive: existing.isActive },
        after: { name: sc.name, isActive: sc.isActive },
        reason: reason || undefined,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return sc;
    });

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /admin/sub-categories/reorder
 * Bulk reorder sub-categories
 */
export const reorderSubCategories = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { orders } = req.body;

    await prisma.$transaction(async (tx) => {
      for (const item of orders) {
        await tx.serviceSubCategory.update({
          where: { id: item.id },
          data: { displayOrder: item.displayOrder },
        });
      }

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'SUB_CATEGORIES_REORDERED',
        entityType: 'ServiceSubCategory',
        entityId: 'BATCH',
        after: { count: orders.length },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });
    });

    sendSuccess(res, { message: 'Sub-categories reordered successfully' });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /admin/sub-categories/:id
 * Delete a sub-category (sets services' subCategoryId to null)
 */
export const deleteSubCategory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { reason } = req.body;

    const existing = await prisma.serviceSubCategory.findUnique({ where: { id } });
    if (!existing) {
      sendError(res, 'SUB_CATEGORY_NOT_FOUND', 'Sub-category not found', 404);
      return;
    }

    await prisma.$transaction(async (tx) => {
      // Nullify subCategoryId on services that belong to this sub-category
      await tx.service.updateMany({
        where: { subCategoryId: id },
        data: { subCategoryId: null },
      });

      await tx.serviceSubCategory.delete({ where: { id } });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'SUB_CATEGORY_DELETED',
        entityType: 'ServiceSubCategory',
        entityId: id,
        before: { name: existing.name, categoryId: existing.categoryId },
        reason: reason || 'Deleted by Super Admin',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });
    });

    sendSuccess(res, { message: 'Sub-category deleted successfully' });
  } catch (error) {
    next(error);
  }
};
