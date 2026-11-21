import { CatalogAssignmentPriority } from '@prisma/client';
import { prisma } from '../config/prisma';

/**
 * Catalog-assignment eligibility:
 * A professional is eligible when BOM assigned them the booking's package,
 * subcategory, and/or parent category (Primary or Secondary).
 *
 * Slot capacity / auto-assign = catalog-matched hub WPs whether checked in or online.
 * Pros receive the job first; they check in at the hub and then execute.
 * User.status (ACTIVE / SUSPENDED) does NOT gate slots.
 * BOM-forced unavailable (bomUnavailableAt) is excluded in pickCrew / capacity filter.
 *
 * Migration fallback: if no professional at the hub has any catalog assignments yet,
 * treat all hub service professionals as eligible (legacy behaviour).
 */

type EmployeeWhereBase = {
  vendorId: string;
  expertKind: 'SERVICE_PROFESSIONAL';
  hubCheckedInAt?: { not: null };
};

export type EligibleEmployeeMatch = {
  employeeId: string;
  /** Best match priority for this booking catalog (PRIMARY preferred over SECONDARY). */
  priority: CatalogAssignmentPriority | null;
};

function buildEmployeeWhereBase(params: {
  vendorId: string;
  requireCheckedIn?: boolean;
}): EmployeeWhereBase {
  // Slot capacity + auto-assign: catalog-matched WPs whether checked in / online or not.
  // Pros see the assigned order, then check in at the hub and execute.
  // Do not filter user.status / deletedAt:null here — Mongo null filters drop unset fields,
  // and attendance SUSPENDED must not zero customer slots.
  // BOM-forced unavailable is filtered in pickCrew (bomUnavailableAt), not here.
  return {
    vendorId: params.vendorId,
    expertKind: 'SERVICE_PROFESSIONAL',
    ...(params.requireCheckedIn ? { hubCheckedInAt: { not: null } } : {}),
  };
}

async function hubHasAnyCatalogAssignments(vendorId: string): Promise<boolean> {
  const [anyCat, anySub, anyPkg] = await Promise.all([
    prisma.employeeCategory.findFirst({
      where: { employee: { vendorId } },
      select: { id: true },
    }),
    prisma.employeeSubCategory.findFirst({
      where: { employee: { vendorId } },
      select: { id: true },
    }),
    prisma.employeePackage.findFirst({
      where: { employee: { vendorId } },
      select: { id: true },
    }),
  ]);
  return !!anyCat || !!anySub || !!anyPkg;
}

async function listAllHubPros(employeeWhereBase: EmployeeWhereBase): Promise<EligibleEmployeeMatch[]> {
  const employees = await prisma.employeeProfile.findMany({
    where: employeeWhereBase,
    select: { id: true },
  });
  return employees.map((e) => ({ employeeId: e.id, priority: null }));
}

function mergePriority(
  map: Map<string, CatalogAssignmentPriority | null>,
  employeeId: string,
  priority: CatalogAssignmentPriority
) {
  const existing = map.get(employeeId);
  if (!existing || existing === CatalogAssignmentPriority.SECONDARY) {
    map.set(employeeId, priority);
  }
  if (priority === CatalogAssignmentPriority.PRIMARY) {
    map.set(employeeId, CatalogAssignmentPriority.PRIMARY);
  }
}

export async function findEligibleEmployeesWithPriority(params: {
  vendorId: string;
  categoryId?: string | null;
  subCategoryId?: string | null;
  packageId?: string | null;
  requireCheckedIn?: boolean;
}): Promise<EligibleEmployeeMatch[]> {
  const { vendorId, categoryId, subCategoryId, packageId, requireCheckedIn = false } = params;
  const employeeWhereBase = buildEmployeeWhereBase({ vendorId, requireCheckedIn });
  const match = new Map<string, CatalogAssignmentPriority | null>();

  let resolvedSubCategoryId = subCategoryId || null;
  let resolvedCategoryId = categoryId || null;

  if (packageId) {
    const [byPackage, pkgMeta] = await Promise.all([
      prisma.employeePackage.findMany({
        where: { packageId, employee: employeeWhereBase },
        select: { employeeId: true, priority: true },
      }),
      prisma.servicePackage.findUnique({
        where: { id: packageId },
        select: {
          service: { select: { subCategoryId: true, categoryId: true } },
        },
      }),
    ]);
    byPackage.forEach((r) => mergePriority(match, r.employeeId, r.priority));
    if (!resolvedSubCategoryId) {
      resolvedSubCategoryId = pkgMeta?.service?.subCategoryId || null;
    }
    if (!resolvedCategoryId) {
      resolvedCategoryId = pkgMeta?.service?.categoryId || null;
    }
  }

  if (resolvedSubCategoryId) {
    const [bySub, subMeta] = await Promise.all([
      prisma.employeeSubCategory.findMany({
        where: { subCategoryId: resolvedSubCategoryId, employee: employeeWhereBase },
        select: { employeeId: true, priority: true },
      }),
      !resolvedCategoryId
        ? prisma.serviceSubCategory.findUnique({
            where: { id: resolvedSubCategoryId },
            select: { categoryId: true },
          })
        : Promise.resolve(null),
    ]);
    bySub.forEach((r) => mergePriority(match, r.employeeId, r.priority));
    if (!resolvedCategoryId) {
      resolvedCategoryId = subMeta?.categoryId || null;
    }
  }

  if (resolvedCategoryId) {
    const byCat = await prisma.employeeCategory.findMany({
      where: { categoryId: resolvedCategoryId, employee: employeeWhereBase },
      select: { employeeId: true, priority: true },
    });
    byCat.forEach((r) => mergePriority(match, r.employeeId, r.priority));
  }

  // Category-only path also covers nested sub/package assignees when package/sub unknown.
  if (resolvedCategoryId && match.size === 0 && !packageId && !subCategoryId) {
    const [bySubCat, byPkg] = await Promise.all([
      prisma.employeeSubCategory.findMany({
        where: {
          subCategory: { categoryId: resolvedCategoryId },
          employee: employeeWhereBase,
        },
        select: { employeeId: true, priority: true },
      }),
      prisma.employeePackage.findMany({
        where: {
          package: { service: { categoryId: resolvedCategoryId } },
          employee: employeeWhereBase,
        },
        select: { employeeId: true, priority: true },
      }),
    ]);
    bySubCat.forEach((r) => mergePriority(match, r.employeeId, r.priority));
    byPkg.forEach((r) => mergePriority(match, r.employeeId, r.priority));
  }

  if (match.size > 0) {
    return excludeBomUnavailable(
      [...match.entries()].map(([employeeId, priority]) => ({ employeeId, priority }))
    );
  }

  if (!(await hubHasAnyCatalogAssignments(vendorId))) {
    return excludeBomUnavailable(await listAllHubPros(employeeWhereBase));
  }

  return [];
}

/** Drop pros BOM marked unavailable (Mongo-safe: filter after fetch). */
async function excludeBomUnavailable(
  matches: EligibleEmployeeMatch[]
): Promise<EligibleEmployeeMatch[]> {
  if (matches.length === 0) return matches;
  const blocked = await prisma.employeeProfile.findMany({
    where: {
      id: { in: matches.map((m) => m.employeeId) },
      bomUnavailableAt: { not: null },
    },
    select: { id: true },
  });
  if (blocked.length === 0) return matches;
  const blockedIds = new Set(blocked.map((b) => b.id));
  return matches.filter((m) => !blockedIds.has(m.employeeId));
}

export async function findEligibleEmployeeIds(params: {
  vendorId: string;
  categoryId?: string | null;
  subCategoryId?: string | null;
  packageId?: string | null;
  requireCheckedIn?: boolean;
}): Promise<string[]> {
  const matches = await findEligibleEmployeesWithPriority(params);
  return matches.map((m) => m.employeeId);
}

export async function isEmployeeEligibleForCatalog(params: {
  employeeId: string;
  vendorId: string;
  categoryId?: string | null;
  subCategoryId?: string | null;
  packageId?: string | null;
}): Promise<boolean> {
  const eligible = await findEligibleEmployeeIds({
    vendorId: params.vendorId,
    categoryId: params.categoryId,
    subCategoryId: params.subCategoryId,
    packageId: params.packageId,
  });
  return eligible.includes(params.employeeId);
}

/** @deprecated Use isEmployeeEligibleForCatalog */
export async function isEmployeeEligibleForCategory(params: {
  employeeId: string;
  vendorId: string;
  categoryId: string;
  subCategoryId?: string | null;
  packageId?: string | null;
}): Promise<boolean> {
  return isEmployeeEligibleForCatalog(params);
}

/**
 * How many hub service pros are catalog-assigned to this package
 * (direct package, its subcategory, or parent category). Not gated by
 * availability / check-in / user.status — this is the hard crew-size ceiling.
 */
export async function countHubProsAssignedToPackage(params: {
  vendorId: string;
  packageId: string;
}): Promise<number> {
  const pkg = await prisma.servicePackage.findUnique({
    where: { id: params.packageId },
    select: {
      id: true,
      service: { select: { categoryId: true, subCategoryId: true } },
    },
  });
  if (!pkg) return 0;

  const categoryId = pkg.service.categoryId;
  const subCategoryId = pkg.service.subCategoryId || null;

  const employees = await prisma.employeeProfile.findMany({
    where: {
      vendorId: params.vendorId,
      expertKind: 'SERVICE_PROFESSIONAL',
    },
    select: {
      id: true,
      employeePackages: { select: { packageId: true } },
      employeeSubCategories: { select: { subCategoryId: true } },
      employeeCategories: { select: { categoryId: true } },
    },
  });

  let n = 0;
  for (const emp of employees) {
    const byPkg = emp.employeePackages.some((p) => p.packageId === params.packageId);
    const bySub =
      !!subCategoryId &&
      emp.employeeSubCategories.some((s) => s.subCategoryId === subCategoryId);
    const byCat = emp.employeeCategories.some((c) => c.categoryId === categoryId);
    if (byPkg || bySub || byCat) n += 1;
  }
  return n;
}

/** Max crew size BOM may configure for a package (1..4, never above assigned pros). */
export function maxCrewForAssignedCount(assignedCount: number): number {
  if (assignedCount <= 0) return 1; // draft default until pros are tagged
  return Math.min(4, assignedCount);
}

/** After catalog unassign, shrink hub crew sizes that now exceed assigned headcount. */
export async function clampHubPackageCrewToAssigned(vendorId: string): Promise<void> {
  const configs = await prisma.hubPackageConfig.findMany({
    where: { vendorId, requiredProfessionals: { gt: 1 } },
    select: { id: true, packageId: true, requiredProfessionals: true },
  });
  for (const cfg of configs) {
    const assigned = await countHubProsAssignedToPackage({
      vendorId,
      packageId: cfg.packageId,
    });
    const maxCrew = maxCrewForAssignedCount(assigned);
    if (cfg.requiredProfessionals > maxCrew) {
      await prisma.hubPackageConfig.update({
        where: { id: cfg.id },
        data: { requiredProfessionals: maxCrew },
      });
    }
  }
}

export async function resolveRequiredProfessionals(params: {
  vendorId: string;
  packageId: string | null | undefined;
}): Promise<number> {
  if (!params.packageId) return 1;
  const [cfg, assigned] = await Promise.all([
    prisma.hubPackageConfig.findUnique({
      where: {
        vendorId_packageId: {
          vendorId: params.vendorId,
          packageId: params.packageId,
        },
      },
      select: { requiredProfessionals: true, isActive: true },
    }),
    countHubProsAssignedToPackage({
      vendorId: params.vendorId,
      packageId: params.packageId,
    }),
  ]);
  if (!cfg?.isActive) return 1;
  const wanted = Math.min(4, Math.max(1, cfg.requiredProfessionals || 1));
  // Never demand more bodies than are catalog-assigned to this package.
  if (assigned <= 0) return wanted;
  return Math.min(wanted, assigned);
}
