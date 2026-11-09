import { TagKind } from '@prisma/client';
import { prisma } from '../config/prisma';

/**
 * Dual-tag eligibility:
 * 1. If category is covered by any ADMIN_SPECIALIST tag → only pros with that specialist tag.
 * 2. Else → pros with a HOM_FLEXIBLE tag that includes the category (hub-scoped).
 */

export async function getAdminSpecialistTagIdsForCategory(categoryId: string): Promise<string[]> {
  const links = await prisma.tagCategory.findMany({
    where: {
      categoryId,
      tag: { kind: TagKind.ADMIN_SPECIALIST, isActive: true },
    },
    select: { tagId: true },
  });
  return links.map((l) => l.tagId);
}

export async function getHomFlexibleTagIdsForCategory(
  categoryId: string,
  vendorId: string
): Promise<string[]> {
  const links = await prisma.tagCategory.findMany({
    where: {
      categoryId,
      tag: {
        kind: TagKind.HOM_FLEXIBLE,
        isActive: true,
        vendorId,
      },
    },
    select: { tagId: true },
  });
  return links.map((l) => l.tagId);
}

/** Categories locked to admin specialist tags (HOM-flex pros must not receive these). */
export async function getAdminSpecialistCategoryIds(): Promise<Set<string>> {
  const links = await prisma.tagCategory.findMany({
    where: { tag: { kind: TagKind.ADMIN_SPECIALIST, isActive: true } },
    select: { categoryId: true },
  });
  return new Set(links.map((l) => l.categoryId));
}

export async function findEligibleEmployeeIds(params: {
  vendorId: string;
  categoryId: string;
  requireCheckedIn?: boolean;
}): Promise<string[]> {
  const { vendorId, categoryId, requireCheckedIn = false } = params;

  const specialistTagIds = await getAdminSpecialistTagIdsForCategory(categoryId);

  const employeeWhereBase = {
    vendorId,
    isAvailable: true,
    acceptingRequests: true,
    expertKind: 'SERVICE_PROFESSIONAL' as const,
    user: { status: 'ACTIVE' as const, deletedAt: null },
    ...(requireCheckedIn ? { hubCheckedInAt: { not: null } } : {}),
  };

  if (specialistTagIds.length > 0) {
    const tagged = await prisma.employeeTag.findMany({
      where: {
        tagId: { in: specialistTagIds },
        employee: employeeWhereBase,
      },
      select: { employeeId: true },
    });
    return [...new Set(tagged.map((t) => t.employeeId))];
  }

  const flexTagIds = await getHomFlexibleTagIdsForCategory(categoryId, vendorId);
  if (flexTagIds.length === 0) {
    // No tags configured yet: fall back to all hub service professionals (legacy behaviour).
    const employees = await prisma.employeeProfile.findMany({
      where: employeeWhereBase,
      select: { id: true },
    });
    return employees.map((e) => e.id);
  }

  const tagged = await prisma.employeeTag.findMany({
    where: {
      tagId: { in: flexTagIds },
      employee: employeeWhereBase,
    },
    select: { employeeId: true },
  });
  return [...new Set(tagged.map((t) => t.employeeId))];
}

export async function isEmployeeEligibleForCategory(params: {
  employeeId: string;
  vendorId: string;
  categoryId: string;
}): Promise<boolean> {
  const eligible = await findEligibleEmployeeIds({
    vendorId: params.vendorId,
    categoryId: params.categoryId,
  });
  return eligible.includes(params.employeeId);
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
