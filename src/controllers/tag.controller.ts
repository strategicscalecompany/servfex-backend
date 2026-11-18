import { Request, Response } from 'express';
import { z } from 'zod';
import { CatalogAssignmentPriority } from '@prisma/client';
import { prisma } from '../config/prisma';
import { sendError, sendSuccess } from '../utils/response';

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

  for (const vs of vendorServices) {
    const svc = vs.service;
    if (!svc?.category) continue;

    if (!categories.has(svc.category.id)) {
      categories.set(svc.category.id, {
        id: svc.category.id,
        name: svc.category.name,
        price: null,
        subCategories: [],
        _order: svc.category.displayOrder ?? 0,
      });
    }
    const cat = categories.get(svc.category.id)!;

    const packages: PackageNode[] = (svc.packages || []).map((pkg) => {
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
      price: null,
      packages: pkgs,
    });
  }

  return [...categories.values()]
    .sort((a, b) => a._order - b._order || a.name.localeCompare(b.name))
    .map(({ _order, ...rest }) => {
      const subCategories = rest.subCategories
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
        ...rest,
        price: minPriceLabel(subCategories.flatMap((s) => s.packages.map((p) => p.price))),
        subCategories,
      };
    });
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
    const vendorServices = await prisma.vendorService.findMany({
      where: { vendorId, isActive: true },
      include: {
        service: {
          select: {
            id: true,
            name: true,
            categoryId: true,
            subCategoryId: true,
            category: { select: { id: true, name: true } },
            subCategory: { select: { id: true, name: true } },
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
        categoryName: vs.service.category?.name || null,
        subCategoryId: vs.service.subCategoryId || null,
        subCategoryName: vs.service.subCategory?.name || null,
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
