import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { sendSuccess, sendError } from '../utils/response';

/**
 * List all active service categories.
 * Public - no authentication required.
 */
export const getCatalogCategories = async (_req: Request, res: Response): Promise<void> => {
  try {
    const categories = await prisma.serviceCategory.findMany({
      where: {
        isActive: true,
        deletedAt: null,
      },
      orderBy: {
        displayOrder: 'asc',
      },
      include: {
        subCategories: {
          where: { isActive: true },
          orderBy: { displayOrder: 'asc' },
          include: {
            services: {
              where: { isActive: true, deletedAt: null },
              orderBy: { name: 'asc' },
              select: {
                id: true,
                name: true,
                slug: true,
                startingPrice: true,
                priceUnit: true,
                durationText: true,
                rating: true,
                reviewCount: true,
                iconUrl: true,
              },
            },
          },
        },
        _count: {
          select: { services: true },
        },
      },
    });

    const sanitizedCategories = categories.map((cat) => ({
      ...cat,
      icon: cat.icon && cat.icon.startsWith('data:') && cat.icon.length > 2000 ? (cat.iconUrl || '') : cat.icon,
      iconUrl: cat.iconUrl && cat.iconUrl.startsWith('data:') && cat.iconUrl.length > 2000 ? null : cat.iconUrl,
    }));

    sendSuccess(res, { categories: sanitizedCategories }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

/**
 * List active services with optional category filtering and search.
 * Public - no authentication required.
 */
export const getCatalogServices = async (req: Request, res: Response): Promise<void> => {
  try {
    const categoryId = typeof req.query.categoryId === 'string' ? req.query.categoryId : undefined;
    const subCategoryId = typeof req.query.subCategoryId === 'string' ? req.query.subCategoryId : undefined;
    const categorySlug = typeof req.query.categorySlug === 'string' ? req.query.categorySlug : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const isPopular = req.query.isPopular === 'true';
    const page = parseInt(String(req.query.page || '1'), 10) || 1;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const where: any = {
      isActive: true,
      deletedAt: null,
    };

    if (categoryId) {
      where.categoryId = categoryId;
    } else if (categorySlug) {
      where.category = { slug: categorySlug };
    }

    if (subCategoryId) {
      where.subCategoryId = subCategoryId;
    }

    if (isPopular) {
      where.isPopular = true;
    }

    if (search && search.trim().length > 0) {
      const term = search.trim();
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [services, total] = await Promise.all([
      prisma.service.findMany({
        where,
        take: limit,
        skip,
        orderBy: [{ isPopular: 'desc' }, { rating: 'desc' }],
        include: {
          category: {
            select: { id: true, name: true, slug: true, icon: true, iconUrl: true },
          },
          subCategory: {
            select: { id: true, name: true, displayOrder: true },
          },
          packages: {
            where: { isActive: true },
            orderBy: [{ displayOrder: 'asc' }, { discountedPrice: 'asc' }],
          },
        },
      }),
      prisma.service.count({ where }),
    ]);

    const sanitizedServices = services.map((s) => ({
      ...s,
      imageUrl: s.imageUrl && s.imageUrl.startsWith('data:') && s.imageUrl.length > 2000 ? (s.iconUrl || '') : s.imageUrl,
      category: s.category
        ? {
            ...s.category,
            icon:
              s.category.icon && s.category.icon.startsWith('data:') && s.category.icon.length > 2000
                ? s.category.iconUrl || ''
                : s.category.icon,
          }
        : null,
    }));

    sendSuccess(
      res,
      { services: sanitizedServices },
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

/**
 * Get single service details with packages and vendor count.
 * Public - no authentication required.
 */
export const getCatalogServiceById = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;

    const service = await prisma.service.findFirst({
      where: {
        id,
        isActive: true,
        deletedAt: null,
      },
      include: {
        category: true,
        subCategory: true,
        packages: {
          where: { isActive: true },
          orderBy: [{ displayOrder: 'asc' }, { discountedPrice: 'asc' }],
        },
        reviews: {
          where: { isHidden: false },
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: {
            customer: {
              select: { name: true, profilePhotoUrl: true },
            },
          },
        },
        _count: {
          select: {
            vendorServices: { where: { isActive: true } },
            reviews: { where: { isHidden: false } },
          },
        },
      },
    });

    if (!service) {
      sendError(res, 'NOT_FOUND', 'Service not found or inactive', 404);
      return;
    }

    sendSuccess(res, { service }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

/**
 * Get paginated public reviews for a specific service.
 * Public - no authentication required.
 */
export const getCatalogServiceReviews = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const page = parseInt(String(req.query.page || '1'), 10) || 1;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '10'), 10) || 10, 1), 50);
    const skip = (page - 1) * limit;

    const where = {
      serviceId: id,
      isHidden: false,
    };

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        take: limit,
        skip,
        orderBy: { createdAt: 'desc' },
        include: {
          customer: {
            select: { name: true, profilePhotoUrl: true },
          },
        },
      }),
      prisma.review.count({ where }),
    ]);

    sendSuccess(
      res,
      { reviews },
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
