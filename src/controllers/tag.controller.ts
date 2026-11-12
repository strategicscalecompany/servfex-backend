import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendError, sendSuccess } from '../utils/response';

export const setEmployeeCatalogSchema = z.object({
  subCategoryIds: z.array(z.string().uuid()).default([]),
  packageIds: z.array(z.string().uuid()).default([]),
});

export const setHubPackageCrewSchema = z.object({
  packageId: z.string().uuid(),
  requiredProfessionals: z.number().int().min(1).max(4),
});

/** Distinct catalog categories currently assigned to this hub via VendorService. */
export async function listHubAssignedCategories(vendorId: string) {
  const assignments = await prisma.vendorService.findMany({
    where: {
      vendorId,
      isActive: true,
      service: {
        isActive: true,
        OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }],
      },
    },
    select: {
      service: {
        select: {
          categoryId: true,
          category: { select: { id: true, name: true } },
        },
      },
    },
  });

  const byId = new Map<string, { id: string; name: string }>();
  for (const row of assignments) {
    const cat = row.service?.category;
    if (cat?.id) {
      byId.set(cat.id, { id: cat.id, name: cat.name });
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Hub catalog tree for professional onboarding:
 * categories → subcategories → packages (only services assigned to this hub).
 */
export async function listHubCatalogTree(vendorId: string) {
  const vendorServices = await prisma.vendorService.findMany({
    where: {
      vendorId,
      isActive: true,
      service: {
        isActive: true,
        OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }],
      },
    },
    include: {
      service: {
        select: {
          id: true,
          name: true,
          categoryId: true,
          subCategoryId: true,
          category: { select: { id: true, name: true, displayOrder: true } },
          subCategory: { select: { id: true, name: true, displayOrder: true, categoryId: true } },
          packages: {
            where: { isActive: true },
            select: {
              id: true,
              name: true,
              title: true,
              displayOrder: true,
              discountedPrice: true,
              originalPrice: true,
              duration: true,
            },
            orderBy: { displayOrder: 'asc' },
          },
        },
      },
    },
  });

  type PackageNode = {
    id: string;
    name: string;
    serviceId: string;
    serviceName: string;
    discountedPrice: string | null;
    originalPrice: string | null;
    duration: string | null;
  };
  type SubNode = {
    id: string;
    name: string;
    packages: PackageNode[];
  };
  type CatNode = {
    id: string;
    name: string;
    subCategories: SubNode[];
  };

  const categories = new Map<string, CatNode & { _order: number }>();
  const orphanPackagesByCategory = new Map<string, PackageNode[]>();

  for (const vs of vendorServices) {
    const svc = vs.service;
    if (!svc?.category) continue;

    if (!categories.has(svc.category.id)) {
      categories.set(svc.category.id, {
        id: svc.category.id,
        name: svc.category.name,
        subCategories: [],
        _order: svc.category.displayOrder ?? 0,
      });
    }
    const cat = categories.get(svc.category.id)!;

    const packages: PackageNode[] = (svc.packages || []).map((pkg) => ({
      id: pkg.id,
      name: pkg.name || pkg.title || 'Package',
      serviceId: svc.id,
      serviceName: svc.name,
      discountedPrice: pkg.discountedPrice ?? null,
      originalPrice: pkg.originalPrice ?? null,
      duration: pkg.duration ?? null,
    }));

    if (svc.subCategory) {
      let sub = cat.subCategories.find((s) => s.id === svc.subCategory!.id);
      if (!sub) {
        sub = {
          id: svc.subCategory.id,
          name: svc.subCategory.name,
          packages: [],
        };
        cat.subCategories.push(sub);
      }
      for (const pkg of packages) {
        if (!sub.packages.some((p) => p.id === pkg.id)) sub.packages.push(pkg);
      }
    } else if (packages.length > 0) {
      const existing = orphanPackagesByCategory.get(svc.category.id) || [];
      for (const pkg of packages) {
        if (!existing.some((p) => p.id === pkg.id)) existing.push(pkg);
      }
      orphanPackagesByCategory.set(svc.category.id, existing);
    }
  }

  // Surface packages without a subcategory under a synthetic "Other" bucket per category.
  for (const [catId, pkgs] of orphanPackagesByCategory) {
    const cat = categories.get(catId);
    if (!cat || pkgs.length === 0) continue;
    cat.subCategories.push({
      id: `__uncategorized__:${catId}`,
      name: 'Other packages',
      packages: pkgs,
    });
  }

  return [...categories.values()]
    .sort((a, b) => a._order - b._order || a.name.localeCompare(b.name))
    .map(({ _order, ...rest }) => ({
      ...rest,
      subCategories: rest.subCategories
        .map((s) => ({
          ...s,
          // Synthetic ids are UI-only; clients must not POST them as subCategoryIds.
          selectable: !s.id.startsWith('__uncategorized__:'),
          packages: s.packages,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

export const vendorListHubCategories = async (req: Request, res: Response): Promise<void> => {
  try {
    const vendorId = (req as any).hubVendorId as string;
    if (!vendorId) {
      sendError(res, 'FORBIDDEN', 'Hub context required', 403);
      return;
    }
    const categories = await listHubAssignedCategories(vendorId);
    sendSuccess(res, { categories });
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to list hub categories', 500);
  }
};

export const vendorListHubCatalogTree = async (req: Request, res: Response): Promise<void> => {
  try {
    const vendorId = (req as any).hubVendorId as string;
    if (!vendorId) {
      sendError(res, 'FORBIDDEN', 'Hub context required', 403);
      return;
    }
    const tree = await listHubCatalogTree(vendorId);
    sendSuccess(res, { categories: tree });
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to list hub catalog', 500);
  }
};

async function assertHubOwnsSubCategories(vendorId: string, subCategoryIds: string[]) {
  if (subCategoryIds.length === 0) return;
  const realIds = subCategoryIds.filter((id) => !id.startsWith('__uncategorized__:'));
  if (realIds.length !== subCategoryIds.length) {
    throw Object.assign(new Error('Invalid subcategory selection'), { code: 'BAD_REQUEST' });
  }
  const assigned = await prisma.vendorService.findMany({
    where: {
      vendorId,
      isActive: true,
      service: { subCategoryId: { in: realIds } },
    },
    select: { service: { select: { subCategoryId: true } } },
  });
  const allowed = new Set(
    assigned.map((a) => a.service.subCategoryId).filter((id): id is string => !!id)
  );
  if (realIds.some((id) => !allowed.has(id))) {
    throw Object.assign(new Error('One or more subcategories are not assigned to this hub'), {
      code: 'BAD_REQUEST',
    });
  }
}

async function assertHubOwnsPackages(vendorId: string, packageIds: string[]) {
  if (packageIds.length === 0) return;
  const assigned = await prisma.vendorService.findMany({
    where: {
      vendorId,
      isActive: true,
      service: { packages: { some: { id: { in: packageIds } } } },
    },
    select: {
      service: {
        select: {
          packages: {
            where: { id: { in: packageIds } },
            select: { id: true },
          },
        },
      },
    },
  });
  const allowed = new Set(assigned.flatMap((a) => a.service.packages.map((p) => p.id)));
  if (packageIds.some((id) => !allowed.has(id))) {
    throw Object.assign(new Error('One or more packages are not assigned to this hub'), {
      code: 'BAD_REQUEST',
    });
  }
}

async function serializeEmployeeCatalog(employeeId: string) {
  const [subs, pkgs] = await Promise.all([
    prisma.employeeSubCategory.findMany({
      where: { employeeId },
      include: {
        subCategory: {
          select: {
            id: true,
            name: true,
            categoryId: true,
            category: { select: { id: true, name: true } },
          },
        },
      },
    }),
    prisma.employeePackage.findMany({
      where: { employeeId },
      include: {
        package: {
          select: {
            id: true,
            name: true,
            title: true,
            serviceId: true,
            service: { select: { id: true, name: true, subCategoryId: true } },
          },
        },
      },
    }),
  ]);

  return {
    subCategories: subs.map((s) => ({
      id: s.subCategory.id,
      name: s.subCategory.name,
      categoryId: s.subCategory.categoryId,
      categoryName: s.subCategory.category?.name,
    })),
    packages: pkgs.map((p) => ({
      id: p.package.id,
      name: p.package.name || p.package.title || 'Package',
      serviceId: p.package.serviceId,
      serviceName: p.package.service?.name,
      subCategoryId: p.package.service?.subCategoryId,
    })),
  };
}

export const vendorGetEmployeeCatalog = async (req: Request, res: Response): Promise<void> => {
  try {
    const vendorId = (req as any).hubVendorId as string;
    const employeeId = req.params.id as string;
    const employee = await prisma.employeeProfile.findFirst({
      where: { id: employeeId, vendorId },
      select: { id: true },
    });
    if (!employee) {
      sendError(res, 'NOT_FOUND', 'Professional not found at this hub', 404);
      return;
    }
    sendSuccess(res, await serializeEmployeeCatalog(employeeId));
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to load professional catalog', 500);
  }
};

export const vendorSetEmployeeCatalog = async (req: Request, res: Response): Promise<void> => {
  try {
    const vendorId = (req as any).hubVendorId as string;
    const employeeId = req.params.id as string;
    const { subCategoryIds, packageIds } = req.body as z.infer<typeof setEmployeeCatalogSchema>;

    const employee = await prisma.employeeProfile.findFirst({
      where: { id: employeeId, vendorId },
    });
    if (!employee) {
      sendError(res, 'NOT_FOUND', 'Professional not found at this hub', 404);
      return;
    }

    const uniqueSubs = [...new Set(subCategoryIds)];
    const uniquePkgs = [...new Set(packageIds)];

    try {
      await assertHubOwnsSubCategories(vendorId, uniqueSubs);
      await assertHubOwnsPackages(vendorId, uniquePkgs);
    } catch (e: any) {
      sendError(res, e.code || 'BAD_REQUEST', e.message || 'Invalid catalog selection', 400);
      return;
    }

    if (uniqueSubs.length === 0 && uniquePkgs.length === 0) {
      sendError(
        res,
        'BAD_REQUEST',
        'Assign at least one subcategory or package to this professional',
        400
      );
      return;
    }

    await prisma.$transaction([
      prisma.employeeSubCategory.deleteMany({ where: { employeeId } }),
      prisma.employeePackage.deleteMany({ where: { employeeId } }),
      ...(uniqueSubs.length > 0
        ? [
            prisma.employeeSubCategory.createMany({
              data: uniqueSubs.map((subCategoryId) => ({
                employeeId,
                subCategoryId,
                assignedBy: req.user!.userId,
              })),
            }),
          ]
        : []),
      ...(uniquePkgs.length > 0
        ? [
            prisma.employeePackage.createMany({
              data: uniquePkgs.map((packageId) => ({
                employeeId,
                packageId,
                assignedBy: req.user!.userId,
              })),
            }),
          ]
        : []),
    ]);

    sendSuccess(res, await serializeEmployeeCatalog(employeeId));
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to set professional catalog', 500);
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
