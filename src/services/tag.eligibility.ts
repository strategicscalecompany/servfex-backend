import { CatalogAssignmentPriority } from '@prisma/client';
import { prisma } from '../config/prisma';

/**
 * Catalog-assignment eligibility:
 * A professional is eligible when BOM assigned them the booking's package,
 * subcategory, and/or parent category (Primary or Secondary).
 *
 * Migration fallback: if no professional at the hub has any catalog assignments yet,
 * treat all hub service professionals as eligible (legacy behaviour).
 */

type EmployeeWhereBase = {
  vendorId: string;
  isAvailable: true;
  acceptingRequests: true;
  /** BOM-marked unavailable pros stay out of free-slot capacity until restore or check-in. */
  bomUnavailableAt: null;
  expertKind: 'SERVICE_PROFESSIONAL';
  user: { status: 'ACTIVE'; deletedAt: null };
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
  return {
    vendorId: params.vendorId,
    isAvailable: true,
    acceptingRequests: true,
    bomUnavailableAt: null,
    expertKind: 'SERVICE_PROFESSIONAL',
    user: { status: 'ACTIVE', deletedAt: null },
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
    return [...match.entries()].map(([employeeId, priority]) => ({ employeeId, priority }));
  }

  if (!(await hubHasAnyCatalogAssignments(vendorId))) {
    return listAllHubPros(employeeWhereBase);
  }

  return [];
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

export async function resolveRequiredProfessionals(params: {
  vendorId: string;
  packageId: string | null | undefined;
}): Promise<number> {
  if (!params.packageId) return 1;
  const cfg = await prisma.hubPackageConfig.findUnique({
    where: {
      vendorId_packageId: {
        vendorId: params.vendorId,
        packageId: params.packageId,
      },
    },
    select: { requiredProfessionals: true, isActive: true },
  });
  if (!cfg?.isActive) return 1;
  return Math.min(4, Math.max(1, cfg.requiredProfessionals || 1));
}
