import { DEFAULT_HOME_LAYOUT, normalizeHomeLayoutValue } from './settings.controller';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { sendSuccess, sendError } from '../utils/response';

interface CacheEntry<T> {
  data: T;
  meta?: any;
  expiresAt: number;
}

const catalogMemoryCache = new Map<string, CacheEntry<any>>();
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes in-memory cache

export const invalidateCatalogCache = (): void => {
  catalogMemoryCache.clear();
};

const CATALOG_SERVICE_INCLUDE = {
  category: {
    select: { id: true, name: true, slug: true, icon: true, iconUrl: true },
  },
  subCategory: {
    select: { id: true, name: true, displayOrder: true },
  },
  packages: {
    where: { isActive: true },
    orderBy: [{ displayOrder: 'asc' as const }, { discountedPrice: 'asc' as const }],
  },
} satisfies Prisma.ServiceInclude;

const sanitizeCatalogService = (s: any) => ({
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
});

const parseRequestedIds = (raw: unknown): string[] => {
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return [...new Set(values.map((id) => String(id).trim()).filter((id) => id.length > 0))];
};

const loadCatalogServicesByIds = async (ids: string[]) => {
  if (ids.length === 0) return [];
  const fetched = await prisma.service.findMany({
    where: {
      id: { in: ids },
      isActive: true,
      deletedAt: null,
    },
    include: CATALOG_SERVICE_INCLUDE,
  });
  const byId = new Map(fetched.map((s) => [s.id, sanitizeCatalogService(s)]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
};

const attachHomeSectionServices = async (
  sections: Array<{ id: string; title: string; subtitle: string; serviceIds: string[]; enabled: boolean }>
) => {
  const allIds = [...new Set(sections.flatMap((section) => section.serviceIds))];
  const loaded = await loadCatalogServicesByIds(allIds);
  const byId = new Map(loaded.map((service: any) => [service.id, service]));
  return sections.map((section) => ({
    ...section,
    services: section.serviceIds.map((id) => byId.get(id)).filter(Boolean),
  }));
};

/**
 * List all active service categories.
 * Public - no authentication required.
 */
export const getCatalogCategories = async (_req: Request, res: Response): Promise<void> => {
  try {
    const cacheKey = 'categories:all';
    const cached = catalogMemoryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=120');
      sendSuccess(res, cached.data, 200);
      return;
    }

    const categories = await prisma.serviceCategory.findMany({
      where: {
        isActive: true,
        OR: [
          { deletedAt: null },
          { deletedAt: { isSet: false } },
        ],
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
              where: {
                isActive: true,
                OR: [
                  { deletedAt: null },
                  { deletedAt: { isSet: false } },
                ],
              },
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
                imageUrl: true,
                bannerImages: true,
                iconName: true,
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

    const resultData = { categories: sanitizedCategories };
    catalogMemoryCache.set(cacheKey, { data: resultData, expiresAt: Date.now() + CACHE_TTL_MS });

    res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=120');
    sendSuccess(res, resultData, 200);
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
    const requestedIds = parseRequestedIds(req.query.ids);
    const page = parseInt(String(req.query.page || '1'), 10) || 1;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '100'), 10) || 100, 1), 100);
    const skip = (page - 1) * limit;

    const cacheKey = `services:${categoryId || ''}:${subCategoryId || ''}:${categorySlug || ''}:${search || ''}:${isPopular}:${requestedIds.join(',')}:${page}:${limit}`;
    const cached = catalogMemoryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=120');
      sendSuccess(res, cached.data, 200, cached.meta);
      return;
    }

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

    if (requestedIds.length > 0) {
      where.id = { in: requestedIds };
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
        take: requestedIds.length > 0 ? Math.min(Math.max(requestedIds.length, 1), 100) : limit,
        skip: requestedIds.length > 0 ? 0 : skip,
        orderBy: [{ isPopular: 'desc' }, { rating: 'desc' }],
        include: CATALOG_SERVICE_INCLUDE,
      }),
      prisma.service.count({ where }),
    ]);

    const servicesById = new Map(services.map((s) => [s.id, s]));
    const sanitizedServices =
      requestedIds.length > 0
        ? requestedIds
            .map((id) => servicesById.get(id))
            .filter((s): s is NonNullable<typeof s> => s != null)
            .map(sanitizeCatalogService)
        : services.map(sanitizeCatalogService);

    const resultData = { services: sanitizedServices };
    const meta = {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };

    catalogMemoryCache.set(cacheKey, { data: resultData, meta, expiresAt: Date.now() + CACHE_TTL_MS });

    res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=120');
    sendSuccess(res, resultData, 200, meta);
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

    const cacheKey = `service:${id}`;
    const cached = catalogMemoryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=120');
      sendSuccess(res, cached.data, 200);
      return;
    }

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

    const resultData = { service };
    catalogMemoryCache.set(cacheKey, { data: resultData, expiresAt: Date.now() + CACHE_TTL_MS });

    res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=120');
    sendSuccess(res, resultData, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

/**
 * Get popular/trending services.
 * Public - no authentication required.
 */
export const getPopularServices = async (req: Request, res: Response): Promise<void> => {
  try {
    const requestedLimit = Math.min(Math.max(parseInt(String(req.query.limit || '10'), 10) || 10, 1), 50);

    const layoutConfig = await prisma.appConfiguration.findUnique({
      where: { key: 'HOME_LAYOUT' },
    });
    const layoutValue = normalizeHomeLayoutValue(layoutConfig?.value);
    const firstEnabled = Array.isArray(layoutValue.serviceSections)
      ? layoutValue.serviceSections.find((section: any) => section.enabled !== false)
      : null;
    const selectedIds: string[] = Array.isArray(firstEnabled?.serviceIds)
      ? firstEnabled.serviceIds.filter((id: unknown) => typeof id === 'string' && id.length > 0)
      : Array.isArray(layoutValue.popularServiceIds)
        ? layoutValue.popularServiceIds.filter((id: unknown) => typeof id === 'string' && id.length > 0)
        : [];
    const limit = selectedIds.length > 0 ? Math.min(Math.max(selectedIds.length, 1), 50) : requestedLimit;

    const cacheKey = `services:popular:${limit}:${selectedIds.join(',')}`;
    const cached = catalogMemoryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=120');
      sendSuccess(res, cached.data, 200);
      return;
    }

    const include = {
      category: {
        select: { id: true, name: true, slug: true, icon: true, iconUrl: true },
      },
      packages: {
        where: { isActive: true },
        take: 1,
        orderBy: { discountedPrice: 'asc' as const },
      },
    } satisfies Prisma.ServiceInclude;

    let services;
    if (selectedIds.length > 0) {
      const fetched = await prisma.service.findMany({
        where: {
          id: { in: selectedIds },
          isActive: true,
          deletedAt: null,
        },
        include,
      });
      const byId = new Map(fetched.map((s) => [s.id, s]));
      const ordered = [];
      for (const id of selectedIds) {
        const match = byId.get(id);
        if (match) ordered.push(match);
      }
      services = ordered.slice(0, limit);
    } else {
      services = await prisma.service.findMany({
        where: {
          isActive: true,
          isPopular: true,
          deletedAt: null,
        },
        take: limit,
        orderBy: { rating: 'desc' },
        include,
      });
    }

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

    const resultData = { services: sanitizedServices };
    catalogMemoryCache.set(cacheKey, { data: resultData, expiresAt: Date.now() + CACHE_TTL_MS });

    res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=120');
    sendSuccess(res, resultData, 200);
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

/**
 * Get Customer App Home Screen Layout (slides, section visibility, search hints)
 * Public - no authentication required.
 */
export const getCatalogHomeLayout = async (_req: Request, res: Response): Promise<void> => {
  try {
    // Send explicit zero-delay headers so mobile clients and proxies NEVER serve stale cache
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const config = await prisma.appConfiguration.findUnique({
      where: { key: 'HOME_LAYOUT' },
    });

    const data = normalizeHomeLayoutValue(config?.value);
    const serviceSections = await attachHomeSectionServices(data.serviceSections || []);
    const updatedAt = config?.updatedAt ? config.updatedAt.getTime() : Date.now();
    const payload = { ...data, serviceSections, updatedAt };

    sendSuccess(res, payload, 200);
  } catch (err: any) {
    sendSuccess(res, DEFAULT_HOME_LAYOUT, 200);
  }
};

