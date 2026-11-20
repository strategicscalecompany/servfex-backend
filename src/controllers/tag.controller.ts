import { Request, Response } from 'express';
import { z } from 'zod';
import { CatalogAssignmentPriority } from '@prisma/client';
import { prisma } from '../config/prisma';
import { sendError, sendSuccess } from '../utils/response';
import { invalidateCatalogCache } from './catalog.controller';
import { emitHubCatalogUpdated } from '../utils/realtime';
import {
  clampHubPackageCrewToAssigned,
  countHubProsAssignedToPackage,
  maxCrewForAssignedCount,
} from '../services/tag.eligibility';

export const setEmployeeCatalogSchema = z.object({
  categoryIds: z.array(z.string().uuid()).default([]),
  subCategoryIds: z.array(z.string().uuid()).default([]),
  packageIds: z.array(z.string().uuid()).default([]),
  /** Optional per-id priority map; missing ids default to SECONDARY. At most one PRIMARY total. */
  priorities: z.record(z.enum(['PRIMARY', 'SECONDARY'])).optional().default({}),
});

export const catalogAssignmentTargetType = z.enum(['CATEGORY', 'SUBCATEGORY', 'PACKAGE']);

export const setCatalogAssignmentsSchema = z.object({
  targetType: catalogAssignmentTargetType,
  targetId: z.string().uuid(),
  assignments: z
    .array(
      z.object({
        employeeId: z.string().uuid(),
        priority: z.enum(['PRIMARY', 'SECONDARY']),
      })
    )
    .default([]),
});

export const setHubPackageCrewSchema = z.object({
  packageId: z.string().uuid(),
  requiredProfessionals: z.number().int().min(1).max(4),
});

/** Package-level hub-radius availability (BOM Assign tab). Off until explicitly enabled. */
export const setHubPackageAvailabilitySchema = z.object({
  packageId: z.string().uuid(),
  isActive: z.boolean(),
});

/** @deprecated Prefer setHubPackageAvailabilitySchema — kept for older app builds. */
export const setHubServiceAvailabilitySchema = z.object({
  serviceId: z.string().uuid(),
  isActive: z.boolean(),
});

function assertBomWriter(req: Request): void {
  if (req.user?.role !== 'OPERATIONS_MANAGER') {
    throw Object.assign(
      new Error('Only Business Operation Managers can assign catalog to professionals'),
      { code: 'FORBIDDEN', status: 403 }
    );
  }
}

async function findPrimaryAssignment(employeeId: string): Promise<{
  targetType: 'CATEGORY' | 'SUBCATEGORY' | 'PACKAGE';
  targetId: string;
} | null> {
  const [cat, sub, pkg] = await Promise.all([
    prisma.employeeCategory.findFirst({
      where: { employeeId, priority: CatalogAssignmentPriority.PRIMARY },
      select: { categoryId: true },
    }),
    prisma.employeeSubCategory.findFirst({
      where: { employeeId, priority: CatalogAssignmentPriority.PRIMARY },
      select: { subCategoryId: true },
    }),
    prisma.employeePackage.findFirst({
      where: { employeeId, priority: CatalogAssignmentPriority.PRIMARY },
      select: { packageId: true },
    }),
  ]);
  if (cat) return { targetType: 'CATEGORY', targetId: cat.categoryId };
  if (sub) return { targetType: 'SUBCATEGORY', targetId: sub.subCategoryId };
  if (pkg) return { targetType: 'PACKAGE', targetId: pkg.packageId };
  return null;
}

async function assertHubOwnsCategories(vendorId: string, categoryIds: string[]) {
  if (categoryIds.length === 0) return;
  const assigned = await prisma.vendorService.findMany({
    where: {
      vendorId,
      isActive: true,
      service: { categoryId: { in: categoryIds } },
    },
    select: { service: { select: { categoryId: true } } },
  });
  const allowed = new Set(assigned.map((a) => a.service.categoryId).filter(Boolean));
  if (categoryIds.some((id) => !allowed.has(id))) {
    throw Object.assign(new Error('One or more categories are not assigned to this hub'), {
      code: 'BAD_REQUEST',
    });
  }
}

/** Distinct categories that still have at least one BOM-enabled package on this hub. */
export async function listHubAssignedCategories(vendorId: string) {
  const enabled = await prisma.hubPackageConfig.findMany({
    where: { vendorId, isActive: true },
    select: {
      package: {
        select: {
          service: {
            select: {
              categoryId: true,
              category: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  });

  const byId = new Map<string, { id: string; name: string }>();
  for (const row of enabled) {
    const cat = row.package?.service?.category;
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
  const [vendorServices, enabledConfigs] = await Promise.all([
    prisma.vendorService.findMany({
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
    }),
    prisma.hubPackageConfig.findMany({
      where: { vendorId, isActive: true },
      select: { packageId: true },
    }),
  ]);
  const enabledPackageIds = new Set(enabledConfigs.map((c) => c.packageId));

  type PackageNode = {
    id: string;
    name: string;
    serviceId: string;
    serviceName: string;
    discountedPrice: string | null;
    originalPrice: string | null;
    price: string | null;
    duration: string | null;
  };
  type SubNode = {
    id: string;
    name: string;
    price: string | null;
    packages: PackageNode[];
  };
  type CatNode = {
    id: string;
    name: string;
    price: string | null;
    subCategories: SubNode[];
  };

  const parsePrice = (raw: string | null | undefined): number | null => {
    if (!raw) return null;
    const n = Number(String(raw).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const minPriceLabel = (prices: Array<string | null | undefined>): string | null => {
    const nums = prices.map(parsePrice).filter((n): n is number => n != null);
    if (nums.length === 0) return null;
    return String(Math.min(...nums));
  };

  const categories = new Map<string, CatNode & { _order: number }>();
  const orphanPackagesByCategory = new Map<string, PackageNode[]>();

  const ensureCategory = (category: { id: string; name: string; displayOrder?: number | null }) => {
    if (!categories.has(category.id)) {
      categories.set(category.id, {
        id: category.id,
        name: category.name,
        price: null,
        subCategories: [],
        _order: category.displayOrder ?? 0,
      });
    }
    return categories.get(category.id)!;
  };

  for (const vs of vendorServices) {
    const svc = vs.service;
    if (!svc?.category) continue;

    // Services page only shows packages BOM has toggled on for this hub.
    const packages: PackageNode[] = (svc.packages || [])
      .filter((pkg) => enabledPackageIds.has(pkg.id))
      .map((pkg) => {
        const price = pkg.discountedPrice || pkg.originalPrice || null;
        return {
          id: pkg.id,
          name: pkg.name || pkg.title || 'Package',
          serviceId: svc.id,
          serviceName: svc.name,
          discountedPrice: pkg.discountedPrice ?? null,
          originalPrice: pkg.originalPrice ?? null,
          price,
          duration: pkg.duration ?? null,
        };
      });
    // Skip services / categories with zero enabled packages (no empty shells).
    if (packages.length === 0) continue;

    const cat = ensureCategory(svc.category);

    if (svc.subCategory) {
      let sub = cat.subCategories.find((s) => s.id === svc.subCategory!.id);
      if (!sub) {
        sub = {
          id: svc.subCategory.id,
          name: svc.subCategory.name,
          price: null,
          packages: [],
        };
        cat.subCategories.push(sub);
      }
      for (const pkg of packages) {
        if (!sub.packages.some((p) => p.id === pkg.id)) sub.packages.push(pkg);
      }
    } else {
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
      price: null,
      packages: pkgs,
    });
  }

  return [...categories.values()]
    .map(({ _order, ...rest }) => {
      const subCategories = rest.subCategories
        .filter((s) => s.packages.length > 0)
        .map((s) => {
          const price = minPriceLabel(s.packages.map((p) => p.price));
          return {
            ...s,
            price,
            // Synthetic ids are UI-only; clients must not POST them as subCategoryIds.
            selectable: !s.id.startsWith('__uncategorized__:'),
            packages: s.packages,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        _order,
        ...rest,
        price: minPriceLabel(subCategories.flatMap((s) => s.packages.map((p) => p.price))),
        subCategories,
      };
    })
    // Drop categories that have no enabled packages left.
    .filter((c) => c.subCategories.some((s) => s.packages.length > 0))
    .sort((a, b) => a._order - b._order || a.name.localeCompare(b.name))
    .map(({ _order, ...rest }) => rest);
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
  const [cats, subs, pkgs, primary] = await Promise.all([
    prisma.employeeCategory.findMany({
      where: { employeeId },
      include: {
        category: { select: { id: true, name: true } },
      },
    }),
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
    findPrimaryAssignment(employeeId),
  ]);

  return {
    categories: cats.map((c) => ({
      id: c.category.id,
      name: c.category.name,
      priority: c.priority,
    })),
    subCategories: subs.map((s) => ({
      id: s.subCategory.id,
      name: s.subCategory.name,
      categoryId: s.subCategory.categoryId,
      categoryName: s.subCategory.category?.name,
      priority: s.priority,
    })),
    packages: pkgs.map((p) => ({
      id: p.package.id,
      name: p.package.name || p.package.title || 'Package',
      serviceId: p.package.serviceId,
      serviceName: p.package.service?.name,
      subCategoryId: p.package.service?.subCategoryId,
      priority: p.priority,
    })),
    primary,
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
    try {
      assertBomWriter(req);
    } catch (e: any) {
      sendError(res, e.code || 'FORBIDDEN', e.message || 'Forbidden', e.status || 403);
      return;
    }

    const vendorId = (req as any).hubVendorId as string;
    const employeeId = req.params.id as string;
    const { categoryIds, subCategoryIds, packageIds, priorities } = req.body as z.infer<
      typeof setEmployeeCatalogSchema
    >;

    const employee = await prisma.employeeProfile.findFirst({
      where: { id: employeeId, vendorId },
    });
    if (!employee) {
      sendError(res, 'NOT_FOUND', 'Professional not found at this hub', 404);
      return;
    }

    const uniqueCats = [...new Set(categoryIds)];
    const uniqueSubs = [...new Set(subCategoryIds)];
    const uniquePkgs = [...new Set(packageIds)];

    try {
      await assertHubOwnsCategories(vendorId, uniqueCats);
      await assertHubOwnsSubCategories(vendorId, uniqueSubs);
      await assertHubOwnsPackages(vendorId, uniquePkgs);
    } catch (e: any) {
      sendError(res, e.code || 'BAD_REQUEST', e.message || 'Invalid catalog selection', 400);
      return;
    }

    const resolvePriority = (id: string): CatalogAssignmentPriority =>
      priorities?.[id] === 'PRIMARY'
        ? CatalogAssignmentPriority.PRIMARY
        : CatalogAssignmentPriority.SECONDARY;

    const primaryTargets = [
      ...uniqueCats.filter((id) => resolvePriority(id) === CatalogAssignmentPriority.PRIMARY).map(
        (id) => ({ type: 'CATEGORY' as const, id })
      ),
      ...uniqueSubs.filter((id) => resolvePriority(id) === CatalogAssignmentPriority.PRIMARY).map(
        (id) => ({ type: 'SUBCATEGORY' as const, id })
      ),
      ...uniquePkgs.filter((id) => resolvePriority(id) === CatalogAssignmentPriority.PRIMARY).map(
        (id) => ({ type: 'PACKAGE' as const, id })
      ),
    ];
    if (primaryTargets.length > 1) {
      sendError(res, 'BAD_REQUEST', 'A professional can have only one primary catalog assignment', 400);
      return;
    }

    await prisma.$transaction([
      prisma.employeeCategory.deleteMany({ where: { employeeId } }),
      prisma.employeeSubCategory.deleteMany({ where: { employeeId } }),
      prisma.employeePackage.deleteMany({ where: { employeeId } }),
      ...(uniqueCats.length > 0
        ? [
            prisma.employeeCategory.createMany({
              data: uniqueCats.map((categoryId) => ({
                employeeId,
                categoryId,
                priority: resolvePriority(categoryId),
                assignedBy: req.user!.userId,
              })),
            }),
          ]
        : []),
      ...(uniqueSubs.length > 0
        ? [
            prisma.employeeSubCategory.createMany({
              data: uniqueSubs.map((subCategoryId) => ({
                employeeId,
                subCategoryId,
                priority: resolvePriority(subCategoryId),
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
                priority: resolvePriority(packageId),
                assignedBy: req.user!.userId,
              })),
            }),
          ]
        : []),
    ]);

    await clampHubPackageCrewToAssigned(vendorId);
    sendSuccess(res, await serializeEmployeeCatalog(employeeId));
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to set professional catalog', 500);
  }
};

export const vendorGetCatalogAssignments = async (req: Request, res: Response): Promise<void> => {
  try {
    const vendorId = (req as any).hubVendorId as string;
    const targetType = String(req.query.targetType || '').toUpperCase();
    const targetId = String(req.query.targetId || '');

    if (!['CATEGORY', 'SUBCATEGORY', 'PACKAGE'].includes(targetType) || !targetId) {
      sendError(res, 'BAD_REQUEST', 'targetType and targetId are required', 400);
      return;
    }

    try {
      if (targetType === 'CATEGORY') await assertHubOwnsCategories(vendorId, [targetId]);
      else if (targetType === 'SUBCATEGORY') await assertHubOwnsSubCategories(vendorId, [targetId]);
      else await assertHubOwnsPackages(vendorId, [targetId]);
    } catch (e: any) {
      sendError(res, e.code || 'BAD_REQUEST', e.message || 'Invalid catalog target', 400);
      return;
    }

    const pros = await prisma.employeeProfile.findMany({
      where: {
        vendorId,
        expertKind: 'SERVICE_PROFESSIONAL',
        user: { deletedAt: null },
      },
      select: {
        id: true,
        phone: true,
        user: { select: { id: true, name: true, phone: true, status: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const employeeIds = pros.map((p) => p.id);
    const [catRows, subRows, pkgRows, primaryCats, primarySubs, primaryPkgs] = await Promise.all([
      targetType === 'CATEGORY'
        ? prisma.employeeCategory.findMany({
            where: { categoryId: targetId, employeeId: { in: employeeIds } },
            select: { employeeId: true, priority: true },
          })
        : Promise.resolve([] as Array<{ employeeId: string; priority: CatalogAssignmentPriority }>),
      targetType === 'SUBCATEGORY'
        ? prisma.employeeSubCategory.findMany({
            where: { subCategoryId: targetId, employeeId: { in: employeeIds } },
            select: { employeeId: true, priority: true },
          })
        : Promise.resolve([] as Array<{ employeeId: string; priority: CatalogAssignmentPriority }>),
      targetType === 'PACKAGE'
        ? prisma.employeePackage.findMany({
            where: { packageId: targetId, employeeId: { in: employeeIds } },
            select: { employeeId: true, priority: true },
          })
        : Promise.resolve([] as Array<{ employeeId: string; priority: CatalogAssignmentPriority }>),
      prisma.employeeCategory.findMany({
        where: {
          employeeId: { in: employeeIds },
          priority: CatalogAssignmentPriority.PRIMARY,
        },
        select: { employeeId: true, categoryId: true },
      }),
      prisma.employeeSubCategory.findMany({
        where: {
          employeeId: { in: employeeIds },
          priority: CatalogAssignmentPriority.PRIMARY,
        },
        select: { employeeId: true, subCategoryId: true },
      }),
      prisma.employeePackage.findMany({
        where: {
          employeeId: { in: employeeIds },
          priority: CatalogAssignmentPriority.PRIMARY,
        },
        select: { employeeId: true, packageId: true },
      }),
    ]);

    const assignedMap = new Map(
      [...catRows, ...subRows, ...pkgRows].map((r) => [r.employeeId, r.priority])
    );
    const primaryByEmployee = new Map<string, { targetType: string; targetId: string }>();
    for (const r of primaryCats) {
      primaryByEmployee.set(r.employeeId, { targetType: 'CATEGORY', targetId: r.categoryId });
    }
    for (const r of primarySubs) {
      primaryByEmployee.set(r.employeeId, { targetType: 'SUBCATEGORY', targetId: r.subCategoryId });
    }
    for (const r of primaryPkgs) {
      primaryByEmployee.set(r.employeeId, { targetType: 'PACKAGE', targetId: r.packageId });
    }

    sendSuccess(res, {
      targetType,
      targetId,
      professionals: pros.map((p) => {
        const assignedPriority = assignedMap.get(p.id) || null;
        const primary = primaryByEmployee.get(p.id) || null;
        const primaryIsThisTarget =
          !!assignedPriority &&
          assignedPriority === CatalogAssignmentPriority.PRIMARY &&
          primary?.targetType === targetType &&
          primary?.targetId === targetId;
        const hasPrimaryElsewhere = !!primary && !primaryIsThisTarget;
        return {
          employeeId: p.id,
          userId: p.user.id,
          name: p.user.name,
          phone: p.user.phone || p.phone,
          status: p.user.status,
          assigned: !!assignedPriority,
          priority: assignedPriority,
          hasPrimaryElsewhere,
          canSelectPrimary: !hasPrimaryElsewhere,
        };
      }),
    });
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to load catalog assignments', 500);
  }
};

export const vendorSetCatalogAssignments = async (req: Request, res: Response): Promise<void> => {
  try {
    try {
      assertBomWriter(req);
    } catch (e: any) {
      sendError(res, e.code || 'FORBIDDEN', e.message || 'Forbidden', e.status || 403);
      return;
    }

    const vendorId = (req as any).hubVendorId as string;
    const { targetType, targetId, assignments } = req.body as z.infer<
      typeof setCatalogAssignmentsSchema
    >;

    try {
      if (targetType === 'CATEGORY') await assertHubOwnsCategories(vendorId, [targetId]);
      else if (targetType === 'SUBCATEGORY') await assertHubOwnsSubCategories(vendorId, [targetId]);
      else await assertHubOwnsPackages(vendorId, [targetId]);
    } catch (e: any) {
      sendError(res, e.code || 'BAD_REQUEST', e.message || 'Invalid catalog target', 400);
      return;
    }

    const uniqueAssignments = new Map<string, 'PRIMARY' | 'SECONDARY'>();
    for (const row of assignments) {
      uniqueAssignments.set(row.employeeId, row.priority);
    }
    const employeeIds = [...uniqueAssignments.keys()];

    if (employeeIds.length > 0) {
      const hubPros = await prisma.employeeProfile.findMany({
        where: {
          vendorId,
          id: { in: employeeIds },
          expertKind: 'SERVICE_PROFESSIONAL',
          user: { deletedAt: null },
        },
        select: { id: true },
      });
      if (hubPros.length !== employeeIds.length) {
        sendError(res, 'BAD_REQUEST', 'One or more professionals are not at this hub', 400);
        return;
      }
    }

    // Enforce one PRIMARY total per pro (excluding this target, which we are rewriting).
    for (const [employeeId, priority] of uniqueAssignments) {
      if (priority !== 'PRIMARY') continue;
      const existing = await findPrimaryAssignment(employeeId);
      if (
        existing &&
        !(existing.targetType === targetType && existing.targetId === targetId)
      ) {
        sendError(
          res,
          'PRIMARY_ALREADY_SET',
          'This professional already has a primary catalog assignment',
          400
        );
        return;
      }
    }

    const assignedBy = req.user!.userId;

    await prisma.$transaction(async (tx) => {
      if (targetType === 'CATEGORY') {
        await tx.employeeCategory.deleteMany({
          where: {
            categoryId: targetId,
            employee: { vendorId },
          },
        });
        if (employeeIds.length > 0) {
          await tx.employeeCategory.createMany({
            data: employeeIds.map((employeeId) => ({
              employeeId,
              categoryId: targetId,
              priority:
                uniqueAssignments.get(employeeId) === 'PRIMARY'
                  ? CatalogAssignmentPriority.PRIMARY
                  : CatalogAssignmentPriority.SECONDARY,
              assignedBy,
            })),
          });
        }
      } else if (targetType === 'SUBCATEGORY') {
        await tx.employeeSubCategory.deleteMany({
          where: {
            subCategoryId: targetId,
            employee: { vendorId },
          },
        });
        if (employeeIds.length > 0) {
          await tx.employeeSubCategory.createMany({
            data: employeeIds.map((employeeId) => ({
              employeeId,
              subCategoryId: targetId,
              priority:
                uniqueAssignments.get(employeeId) === 'PRIMARY'
                  ? CatalogAssignmentPriority.PRIMARY
                  : CatalogAssignmentPriority.SECONDARY,
              assignedBy,
            })),
          });
        }
      } else {
        await tx.employeePackage.deleteMany({
          where: {
            packageId: targetId,
            employee: { vendorId },
          },
        });
        if (employeeIds.length > 0) {
          await tx.employeePackage.createMany({
            data: employeeIds.map((employeeId) => ({
              employeeId,
              packageId: targetId,
              priority:
                uniqueAssignments.get(employeeId) === 'PRIMARY'
                  ? CatalogAssignmentPriority.PRIMARY
                  : CatalogAssignmentPriority.SECONDARY,
              assignedBy,
            })),
          });
        }
      }
    });

    await clampHubPackageCrewToAssigned(vendorId);

    // Re-use GET serializer shape.
    req.query = { targetType, targetId };
    await vendorGetCatalogAssignments(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      sendError(res, 'INTERNAL_ERROR', 'Failed to save catalog assignments', 500);
    }
  }
};

export const vendorListHubPackages = async (req: Request, res: Response): Promise<void> => {
  try {
    const vendorId = (req as any).hubVendorId as string;
    // Full Super Admin catalog — BOM alone decides which packages this hub offers.
    const [catalogPackages, vendorServices, configs, employees] = await Promise.all([
      prisma.servicePackage.findMany({
        where: {
          isActive: true,
          service: {
            isActive: true,
            OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }],
          },
        },
        select: {
          id: true,
          name: true,
          title: true,
          durationMinutes: true,
          duration: true,
          discountedPrice: true,
          originalPrice: true,
          service: {
            select: {
              id: true,
              name: true,
              categoryId: true,
              subCategoryId: true,
              category: { select: { id: true, name: true } },
              subCategory: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      }),
      prisma.vendorService.findMany({
        where: { vendorId },
        select: { id: true, serviceId: true },
      }),
      prisma.hubPackageConfig.findMany({ where: { vendorId } }),
      prisma.employeeProfile.findMany({
        where: {
          vendorId,
          expertKind: 'SERVICE_PROFESSIONAL',
        },
        select: {
          id: true,
          employeeCategories: { select: { categoryId: true } },
          employeeSubCategories: { select: { subCategoryId: true } },
          employeePackages: { select: { packageId: true } },
        },
      }),
    ]);

    const cfgMap = new Map(configs.map((c) => [c.packageId, c]));
    const vsByServiceId = new Map(vendorServices.map((vs) => [vs.serviceId, vs]));

    const countEmployeesForPackage = (pkg: {
      id: string;
      categoryId: string;
      subCategoryId: string | null;
    }): number => {
      let n = 0;
      for (const emp of employees) {
        const byPkg = emp.employeePackages.some((p) => p.packageId === pkg.id);
        const bySub =
          !!pkg.subCategoryId &&
          emp.employeeSubCategories.some((s) => s.subCategoryId === pkg.subCategoryId);
        const byCat = emp.employeeCategories.some((c) => c.categoryId === pkg.categoryId);
        if (byPkg || bySub || byCat) n += 1;
      }
      return n;
    };

    const packages = catalogPackages.map((pkg) => {
      const service = pkg.service;
      const vs = vsByServiceId.get(service.id);
      const employeeCount = countEmployeesForPackage({
        id: pkg.id,
        categoryId: service.categoryId,
        subCategoryId: service.subCategoryId || null,
      });
      const maxCrew = maxCrewForAssignedCount(employeeCount);
      const rawRequired = cfgMap.get(pkg.id)?.requiredProfessionals ?? 1;
      const enabled = cfgMap.get(pkg.id)?.isActive === true;
      return {
        packageId: pkg.id,
        packageName: pkg.name || pkg.title || 'Package',
        serviceId: service.id,
        serviceName: service.name,
        vendorServiceId: vs?.id || '',
        categoryId: service.categoryId,
        categoryName: service.category?.name || null,
        subCategoryId: service.subCategoryId || null,
        subCategoryName: service.subCategory?.name || null,
        durationMinutes: pkg.durationMinutes,
        duration: pkg.duration,
        requiredProfessionals: Math.min(maxCrew, Math.max(1, rawRequired)),
        employeeCount,
        maxCrew,
        /** Off until BOM enables this package for the hub. */
        isActive: enabled,
        availabilityMessage: enabled ? null : 'Currently not available',
      };
    });
    packages.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return String(a.packageName).localeCompare(String(b.packageName));
    });
    sendSuccess(res, packages);
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to list hub packages', 500);
  }
};

export const vendorSetHubPackageCrew = async (req: Request, res: Response): Promise<void> => {
  try {
    assertBomWriter(req);
    const vendorId = (req as any).hubVendorId as string;
    const { packageId, requiredProfessionals } = req.body as z.infer<typeof setHubPackageCrewSchema>;

    const pkg = await prisma.servicePackage.findFirst({
      where: {
        id: packageId,
        isActive: true,
        service: {
          isActive: true,
          OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }],
        },
      },
      select: { id: true, serviceId: true },
    });
    if (!pkg) {
      sendError(res, 'BAD_REQUEST', 'Package not found in catalog', 400);
      return;
    }

    const assigned = await countHubProsAssignedToPackage({ vendorId, packageId });
    const maxCrew = maxCrewForAssignedCount(assigned);
    if (requiredProfessionals > maxCrew) {
      sendError(
        res,
        'CREW_EXCEEDS_ASSIGNED',
        assigned <= 0
          ? 'Assign professionals to this package on Services before setting crew size above 1.'
          : `Only ${assigned} professional(s) are assigned to this package. Crew size cannot exceed ${maxCrew}.`,
        400
      );
      return;
    }

    const cfg = await prisma.hubPackageConfig.upsert({
      where: { vendorId_packageId: { vendorId, packageId } },
      create: {
        vendorId,
        packageId,
        requiredProfessionals,
        // Crew size alone must not enable the package for customers.
        isActive: false,
        updatedBy: req.user!.userId,
      },
      update: {
        requiredProfessionals,
        updatedBy: req.user!.userId,
      },
    });

    emitHubCatalogUpdated(vendorId, {
      hubId: vendorId,
      serviceId: pkg.serviceId,
      packageId,
      requiredProfessionals: cfg.requiredProfessionals,
      reason: 'crew_size',
    });

    sendSuccess(res, cfg);
  } catch (err: any) {
    if (err?.status === 403) {
      sendError(res, err.code || 'FORBIDDEN', err.message, 403);
      return;
    }
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to update crew size', 500);
  }
};

/**
 * BOM assigns a catalog package to this hub (creates VendorService link) or pauses it.
 * Super Admin cannot assign hub catalog — only the hub's BOM.
 */
export const vendorSetHubPackageAvailability = async (req: Request, res: Response): Promise<void> => {
  try {
    assertBomWriter(req);
    const vendorId = (req as any).hubVendorId as string;
    const { packageId, isActive } = req.body as z.infer<typeof setHubPackageAvailabilitySchema>;

    const pkg = await prisma.servicePackage.findFirst({
      where: {
        id: packageId,
        isActive: true,
        service: {
          isActive: true,
          OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }],
        },
      },
      select: { id: true, serviceId: true },
    });
    if (!pkg) {
      sendError(res, 'BAD_REQUEST', 'Package not found in catalog', 400);
      return;
    }

    const existing = await prisma.hubPackageConfig.findUnique({
      where: { vendorId_packageId: { vendorId, packageId } },
      select: { requiredProfessionals: true },
    });

    // Enabling a package is how BOM assigns the parent service to the hub.
    const vendorService = await prisma.vendorService.upsert({
      where: { vendorId_serviceId: { vendorId, serviceId: pkg.serviceId } },
      create: {
        vendorId,
        serviceId: pkg.serviceId,
        isActive: isActive,
        availability: 'Mon-Sat: 09:00 - 18:00',
      },
      update: {
        // Keep service link active while any package may still be on; force on when enabling.
        ...(isActive ? { isActive: true } : {}),
      },
      select: { id: true, serviceId: true },
    });

    const updated = await prisma.hubPackageConfig.upsert({
      where: { vendorId_packageId: { vendorId, packageId } },
      create: {
        vendorId,
        packageId,
        requiredProfessionals: existing?.requiredProfessionals ?? 1,
        isActive,
        updatedBy: req.user!.userId,
      },
      update: {
        isActive,
        updatedBy: req.user!.userId,
      },
      select: {
        packageId: true,
        isActive: true,
        requiredProfessionals: true,
      },
    });

    if (!isActive) {
      // If no packages remain enabled for this service on the hub, mark VendorService inactive.
      const stillOn = await prisma.hubPackageConfig.count({
        where: {
          vendorId,
          isActive: true,
          package: { serviceId: pkg.serviceId },
        },
      });
      if (stillOn === 0) {
        await prisma.vendorService.update({
          where: { id: vendorService.id },
          data: { isActive: false },
        });
      }
    }

    invalidateCatalogCache();
    emitHubCatalogUpdated(vendorId, {
      hubId: vendorId,
      serviceId: pkg.serviceId,
      packageId: updated.packageId,
      isActive: updated.isActive,
      reason: 'availability',
    });

    sendSuccess(res, {
      packageId: updated.packageId,
      serviceId: pkg.serviceId,
      isActive: updated.isActive,
      availabilityMessage: updated.isActive ? null : 'Currently not available',
    });
  } catch (err: any) {
    if (err?.status === 403) {
      sendError(res, err.code || 'FORBIDDEN', err.message, 403);
      return;
    }
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to update package availability', 500);
  }
};

/** @deprecated Older app builds — maps service toggle to enabling/disabling all packages under that service. */
export const vendorSetHubServiceAvailability = async (req: Request, res: Response): Promise<void> => {
  try {
    assertBomWriter(req);
    const vendorId = (req as any).hubVendorId as string;
    const { serviceId, isActive } = req.body as z.infer<typeof setHubServiceAvailabilitySchema>;

    const existing = await prisma.vendorService.findFirst({
      where: { vendorId, serviceId },
      select: {
        id: true,
        service: { select: { packages: { where: { isActive: true }, select: { id: true } } } },
      },
    });
    if (!existing) {
      sendError(res, 'BAD_REQUEST', 'Service is not assigned to this hub', 400);
      return;
    }

    await prisma.vendorService.update({
      where: { id: existing.id },
      data: { isActive },
    });

    for (const pkg of existing.service.packages) {
      await prisma.hubPackageConfig.upsert({
        where: { vendorId_packageId: { vendorId, packageId: pkg.id } },
        create: {
          vendorId,
          packageId: pkg.id,
          requiredProfessionals: 1,
          isActive,
          updatedBy: req.user!.userId,
        },
        update: { isActive, updatedBy: req.user!.userId },
      });
    }

    invalidateCatalogCache();
    emitHubCatalogUpdated(vendorId, {
      hubId: vendorId,
      serviceId,
      isActive,
      reason: 'availability',
    });

    sendSuccess(res, {
      serviceId,
      isActive,
      availabilityMessage: isActive ? null : 'Currently not available',
    });
  } catch (err: any) {
    if (err?.status === 403) {
      sendError(res, err.code || 'FORBIDDEN', err.message, 403);
      return;
    }
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to update service availability', 500);
  }
};
