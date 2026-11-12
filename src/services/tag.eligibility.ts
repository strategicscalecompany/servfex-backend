import { prisma } from '../config/prisma';

/**
 * Catalog-assignment eligibility:
 * A professional is eligible when they have been assigned the booking's package
 * and/or its service subcategory (set during Partner/HOM onboarding).
 *
 * Migration fallback: if no professional at the hub has any catalog assignments yet,
 * treat all hub service professionals as eligible (legacy behaviour).
 */

type EmployeeWhereBase = {
  vendorId: string;
  isAvailable: true;
  acceptingRequests: true;
  expertKind: 'SERVICE_PROFESSIONAL';
  user: { status: 'ACTIVE'; deletedAt: null };
  hubCheckedInAt?: { not: null };
};

function buildEmployeeWhereBase(params: {
  vendorId: string;
  requireCheckedIn?: boolean;
}): EmployeeWhereBase {
  return {
    vendorId: params.vendorId,
    isAvailable: true,
    acceptingRequests: true,
    expertKind: 'SERVICE_PROFESSIONAL',
    user: { status: 'ACTIVE', deletedAt: null },
    ...(params.requireCheckedIn ? { hubCheckedInAt: { not: null } } : {}),
  };
}

async function hubHasAnyCatalogAssignments(vendorId: string): Promise<boolean> {
  const [anySub, anyPkg] = await Promise.all([
    prisma.employeeSubCategory.findFirst({
      where: { employee: { vendorId } },
      select: { id: true },
    }),
    prisma.employeePackage.findFirst({
      where: { employee: { vendorId } },
      select: { id: true },
    }),
  ]);
  return !!anySub || !!anyPkg;
}

async function listAllHubPros(employeeWhereBase: EmployeeWhereBase): Promise<string[]> {
  const employees = await prisma.employeeProfile.findMany({
    where: employeeWhereBase,
    select: { id: true },
  });
  return employees.map((e) => e.id);
}

export async function findEligibleEmployeeIds(params: {
  vendorId: string;
  categoryId?: string | null;
  subCategoryId?: string | null;
  packageId?: string | null;
  requireCheckedIn?: boolean;
}): Promise<string[]> {
  const { vendorId, categoryId, subCategoryId, packageId, requireCheckedIn = false } = params;
  const employeeWhereBase = buildEmployeeWhereBase({ vendorId, requireCheckedIn });

  if (!(await hubHasAnyCatalogAssignments(vendorId))) {
    return listAllHubPros(employeeWhereBase);
  }

  const eligible = new Set<string>();

  if (packageId) {
    const byPackage = await prisma.employeePackage.findMany({
      where: {
        packageId,
        employee: employeeWhereBase,
      },
      select: { employeeId: true },
    });
    byPackage.forEach((r) => eligible.add(r.employeeId));
  }

  let resolvedSubCategoryId = subCategoryId || null;
  if (!resolvedSubCategoryId && packageId) {
    const pkg = await prisma.servicePackage.findUnique({
      where: { id: packageId },
      select: { service: { select: { subCategoryId: true } } },
    });
    resolvedSubCategoryId = pkg?.service?.subCategoryId || null;
  }

  if (resolvedSubCategoryId) {
    const bySub = await prisma.employeeSubCategory.findMany({
      where: {
        subCategoryId: resolvedSubCategoryId,
        employee: employeeWhereBase,
      },
      select: { employeeId: true },
    });
    bySub.forEach((r) => eligible.add(r.employeeId));
  }

  // Category-only lookups (slots / crew when package unknown): any assignment under that category.
  if (eligible.size === 0 && categoryId && !packageId && !resolvedSubCategoryId) {
    const [bySubCat, byPkg] = await Promise.all([
      prisma.employeeSubCategory.findMany({
        where: {
          subCategory: { categoryId },
          employee: employeeWhereBase,
        },
        select: { employeeId: true },
      }),
      prisma.employeePackage.findMany({
        where: {
          package: { service: { categoryId } },
          employee: employeeWhereBase,
        },
        select: { employeeId: true },
      }),
    ]);
    bySubCat.forEach((r) => eligible.add(r.employeeId));
    byPkg.forEach((r) => eligible.add(r.employeeId));
  }

  return [...eligible];
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
