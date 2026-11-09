import { Request, Response } from 'express';
import { TagKind } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendError, sendSuccess } from '../utils/response';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

export const createAdminTagSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(500).optional(),
  categoryIds: z.array(z.string().uuid()).min(1),
});

export const updateTagCategoriesSchema = z.object({
  categoryIds: z.array(z.string().uuid()).min(1),
});

export const createHomTagSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(500).optional(),
  categoryIds: z.array(z.string().uuid()).min(1),
});

export const setEmployeeTagsSchema = z.object({
  tagIds: z.array(z.string().uuid()),
});

export const setHubPackageCrewSchema = z.object({
  packageId: z.string().uuid(),
  requiredProfessionals: z.number().int().min(1).max(4),
});

function serializeTag(tag: any) {
  return {
    id: tag.id,
    name: tag.name,
    slug: tag.slug,
    kind: tag.kind,
    vendorId: tag.vendorId,
    description: tag.description,
    isActive: tag.isActive,
    categories: (tag.categories || []).map((c: any) => ({
      id: c.category?.id || c.categoryId,
      name: c.category?.name,
    })),
    createdAt: tag.createdAt,
  };
}

/** Super Admin: list all ADMIN_SPECIALIST tags (+ optional all). */
export const adminListTags = async (_req: Request, res: Response): Promise<void> => {
  try {
    const tags = await prisma.serviceTag.findMany({
      where: { kind: TagKind.ADMIN_SPECIALIST },
      include: { categories: { include: { category: { select: { id: true, name: true } } } } },
      orderBy: { name: 'asc' },
    });
    sendSuccess(res, tags.map(serializeTag));
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to list tags', 500);
  }
};

/** Super Admin: create specialist tag. */
export const adminCreateTag = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, description, categoryIds } = req.body as z.infer<typeof createAdminTagSchema>;
    const slug = slugify(name);
    const existing = await prisma.serviceTag.findFirst({
      where: { slug, kind: TagKind.ADMIN_SPECIALIST, vendorId: null },
    });
    if (existing) {
      sendError(res, 'CONFLICT', 'A specialist tag with this name already exists', 409);
      return;
    }
    const categories = await prisma.serviceCategory.findMany({
      where: { id: { in: categoryIds }, deletedAt: null },
      select: { id: true },
    });
    if (categories.length !== categoryIds.length) {
      sendError(res, 'BAD_REQUEST', 'One or more categories are invalid', 400);
      return;
    }

    const tag = await prisma.serviceTag.create({
      data: {
        name: name.trim(),
        slug,
        kind: TagKind.ADMIN_SPECIALIST,
        vendorId: null,
        description: description || null,
        createdBy: req.user!.userId,
        categories: {
          create: categoryIds.map((categoryId: string) => ({ categoryId })),
        },
      },
      include: { categories: { include: { category: { select: { id: true, name: true } } } } },
    });
    sendSuccess(res, serializeTag(tag), 201);
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to create tag', 500);
  }
};

export const adminUpdateTagCategories = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { categoryIds } = req.body as z.infer<typeof updateTagCategoriesSchema>;
    const tag = await prisma.serviceTag.findFirst({
      where: { id, kind: TagKind.ADMIN_SPECIALIST },
    });
    if (!tag) {
      sendError(res, 'NOT_FOUND', 'Tag not found', 404);
      return;
    }
    await prisma.$transaction([
      prisma.tagCategory.deleteMany({ where: { tagId: id } }),
      prisma.tagCategory.createMany({
        data: categoryIds.map((categoryId: string) => ({ tagId: id, categoryId })),
      }),
    ]);
    const updated = await prisma.serviceTag.findUnique({
      where: { id },
      include: { categories: { include: { category: { select: { id: true, name: true } } } } },
    });
    sendSuccess(res, serializeTag(updated));
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to update tag categories', 500);
  }
};

export const adminDeactivateTag = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const tag = await prisma.serviceTag.update({
      where: { id },
      data: { isActive: false },
    });
    sendSuccess(res, { id: tag.id, isActive: tag.isActive });
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to deactivate tag', 500);
  }
};

// ---- Vendor / HOM helpers expect vendorId resolved by caller ----

export async function listTagsForHub(vendorId: string) {
  return prisma.serviceTag.findMany({
    where: {
      isActive: true,
      OR: [
        { kind: TagKind.ADMIN_SPECIALIST, vendorId: null },
        { kind: TagKind.HOM_FLEXIBLE, vendorId },
      ],
    },
    include: { categories: { include: { category: { select: { id: true, name: true } } } } },
    orderBy: [{ kind: 'asc' }, { name: 'asc' }],
  });
}

export const vendorListTags = async (req: Request, res: Response): Promise<void> => {
  try {
    const vendorId = (req as any).hubVendorId as string;
    if (!vendorId) {
      sendError(res, 'FORBIDDEN', 'Hub context required', 403);
      return;
    }
    const tags = await listTagsForHub(vendorId);
    sendSuccess(res, tags.map(serializeTag));
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to list tags', 500);
  }
};

export const vendorCreateHomTag = async (req: Request, res: Response): Promise<void> => {
  try {
    const vendorId = (req as any).hubVendorId as string;
    const { name, description, categoryIds } = req.body as z.infer<typeof createHomTagSchema>;
    const slug = slugify(name);
    const existing = await prisma.serviceTag.findFirst({
      where: { slug, vendorId, kind: TagKind.HOM_FLEXIBLE },
    });
    if (existing) {
      sendError(res, 'CONFLICT', 'A tag with this name already exists for your hub', 409);
      return;
    }
    const tag = await prisma.serviceTag.create({
      data: {
        name: name.trim(),
        slug,
        kind: TagKind.HOM_FLEXIBLE,
        vendorId,
        description: description || null,
        createdBy: req.user!.userId,
        categories: {
          create: categoryIds.map((categoryId: string) => ({ categoryId })),
        },
      },
      include: { categories: { include: { category: { select: { id: true, name: true } } } } },
    });
    sendSuccess(res, serializeTag(tag), 201);
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to create tag', 500);
  }
};

export const vendorSetEmployeeTags = async (req: Request, res: Response): Promise<void> => {
  try {
    const vendorId = (req as any).hubVendorId as string;
    const employeeId = req.params.id as string;
    const { tagIds } = req.body as z.infer<typeof setEmployeeTagsSchema>;

    const employee = await prisma.employeeProfile.findFirst({
      where: { id: employeeId, vendorId },
    });
    if (!employee) {
      sendError(res, 'NOT_FOUND', 'Professional not found at this hub', 404);
      return;
    }

    const allowed = await prisma.serviceTag.findMany({
      where: {
        id: { in: tagIds },
        isActive: true,
        OR: [
          { kind: TagKind.ADMIN_SPECIALIST, vendorId: null },
          { kind: TagKind.HOM_FLEXIBLE, vendorId },
        ],
      },
      select: { id: true },
    });
    if (allowed.length !== tagIds.length) {
      sendError(res, 'BAD_REQUEST', 'One or more tags are not available for this hub', 400);
      return;
    }

    await prisma.$transaction([
      prisma.employeeTag.deleteMany({ where: { employeeId } }),
      prisma.employeeTag.createMany({
        data: tagIds.map((tagId: string) => ({
          employeeId,
          tagId,
          assignedBy: req.user!.userId,
        })),
      }),
    ]);

    const tags = await prisma.employeeTag.findMany({
      where: { employeeId },
      include: { tag: { include: { categories: { include: { category: true } } } } },
    });
    sendSuccess(
      res,
      tags.map((t) => serializeTag(t.tag))
    );
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to set professional tags', 500);
  }
};

export const vendorListHubPackages = async (req: Request, res: Response): Promise<void> => {
  try {
    const vendorId = (req as any).hubVendorId as string;
    const vendorServices = await prisma.vendorService.findMany({
      where: { vendorId, isActive: true },
      include: {
        service: {
          select: {
            id: true,
            name: true,
            categoryId: true,
            packages: {
              where: { isActive: true },
              select: {
                id: true,
                name: true,
                title: true,
                durationMinutes: true,
                duration: true,
                discountedPrice: true,
                originalPrice: true,
              },
              orderBy: { displayOrder: 'asc' },
            },
          },
        },
      },
    });

    const configs = await prisma.hubPackageConfig.findMany({ where: { vendorId } });
    const cfgMap = new Map(configs.map((c) => [c.packageId, c]));

    const packages = vendorServices.flatMap((vs) =>
      vs.service.packages.map((pkg) => ({
        packageId: pkg.id,
        packageName: pkg.name || pkg.title || 'Package',
        serviceId: vs.service.id,
        serviceName: vs.service.name,
        categoryId: vs.service.categoryId,
        durationMinutes: pkg.durationMinutes,
        duration: pkg.duration,
        requiredProfessionals: cfgMap.get(pkg.id)?.requiredProfessionals ?? 1,
      }))
    );
    sendSuccess(res, packages);
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to list hub packages', 500);
  }
};

export const vendorSetHubPackageCrew = async (req: Request, res: Response): Promise<void> => {
  try {
    const vendorId = (req as any).hubVendorId as string;
    const { packageId, requiredProfessionals } = req.body as z.infer<typeof setHubPackageCrewSchema>;

    const assigned = await prisma.vendorService.findFirst({
      where: {
        vendorId,
        isActive: true,
        service: { packages: { some: { id: packageId } } },
      },
    });
    if (!assigned) {
      sendError(res, 'BAD_REQUEST', 'Package is not assigned to this hub', 400);
      return;
    }

    const cfg = await prisma.hubPackageConfig.upsert({
      where: { vendorId_packageId: { vendorId, packageId } },
      create: {
        vendorId,
        packageId,
        requiredProfessionals,
        updatedBy: req.user!.userId,
      },
      update: {
        requiredProfessionals,
        updatedBy: req.user!.userId,
        isActive: true,
      },
    });
    sendSuccess(res, cfg);
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to update crew size', 500);
  }
};
