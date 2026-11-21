import { prisma } from '../config/prisma';
import { SLOT_GAP_MINUTES } from '../config/scheduling';
import {
  countValidBeforePhotos,
  countValidCompletionPhotos,
  hasRequiredBeforePhotos,
  hasRequiredCompletionPhotos,
  MIN_BEFORE_PHOTOS,
  MIN_COMPLETION_PHOTOS,
} from '../config/testing-workflow';
import { DispatchError } from './dispatch.errors';

export type VisitChainBooking = {
  id: string;
  bookingNumber: string;
  cartGroupId: string | null;
  cartGroupIndex: number | null;
  visitChainPrimaryId: string | null;
  employeeId: string | null;
  helperEmployeeId: string | null;
  addressId: string;
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
  status: string;
  totalAmount: string;
  qrChallengeToken: string | null;
  qrChallengeExpiresAt: Date | null;
  qrVerifiedAt: Date | null;
  completionOtpToken: string | null;
  completionOtpExpiresAt: Date | null;
  completionOtpVerifiedAt: Date | null;
  beforePhotoUrls: string[];
  completionPhotoUrls: string[];
  paymentStatus: string;
  paymentMethod: string;
  cashCollectedAt: Date | null;
  cashCollectedAmount: string | null;
};

const CHAIN_SELECT = {
  id: true,
  bookingNumber: true,
  cartGroupId: true,
  cartGroupIndex: true,
  visitChainPrimaryId: true,
  employeeId: true,
  helperEmployeeId: true,
  addressId: true,
  scheduledStartAt: true,
  scheduledEndAt: true,
  status: true,
  totalAmount: true,
  qrChallengeToken: true,
  qrChallengeExpiresAt: true,
  qrVerifiedAt: true,
  completionOtpToken: true,
  completionOtpExpiresAt: true,
  completionOtpVerifiedAt: true,
  beforePhotoUrls: true,
  completionPhotoUrls: true,
  paymentStatus: true,
  paymentMethod: true,
  cashCollectedAt: true,
  cashCollectedAmount: true,
} as const;

/** Gap between end of A and start of B must be in [0, SLOT_GAP_MINUTES] (15m packing). */
export function isContiguousSlots(
  earlierEnd: Date | null | undefined,
  laterStart: Date | null | undefined,
  maxGapMinutes = SLOT_GAP_MINUTES
): boolean {
  if (!earlierEnd || !laterStart) return false;
  const gapMs = laterStart.getTime() - earlierEnd.getTime();
  if (gapMs < 0) return false;
  return gapMs <= maxGapMinutes * 60 * 1000;
}

export function sortChainBySchedule<T extends { scheduledStartAt: Date | null; cartGroupIndex: number | null; id: string }>(
  rows: T[]
): T[] {
  return [...rows].sort((a, b) => {
    const aStart = a.scheduledStartAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const bStart = b.scheduledStartAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (aStart !== bStart) return aStart - bStart;
    const ai = a.cartGroupIndex ?? 0;
    const bi = b.cartGroupIndex ?? 0;
    if (ai !== bi) return ai - bi;
    return a.id.localeCompare(b.id);
  });
}

export function isVisitChainActive(rows: VisitChainBooking[]): boolean {
  if (rows.length < 2) return false;
  const sorted = sortChainBySchedule(rows);
  const lead = sorted[0].employeeId;
  const addressId = sorted[0].addressId;
  if (!lead || !addressId) return false;
  if (!sorted.every((r) => r.employeeId === lead && r.addressId === addressId)) return false;
  for (let i = 1; i < sorted.length; i++) {
    if (!isContiguousSlots(sorted[i - 1].scheduledEndAt, sorted[i].scheduledStartAt)) {
      return false;
    }
  }
  return true;
}

export async function loadCartGroupBookings(cartGroupId: string): Promise<VisitChainBooking[]> {
  const rows = await prisma.booking.findMany({
    where: { cartGroupId },
    select: CHAIN_SELECT,
  });
  return sortChainBySchedule(rows as VisitChainBooking[]);
}

export async function loadVisitChain(bookingId: string): Promise<VisitChainBooking[]> {
  const seed = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: CHAIN_SELECT,
  });
  if (!seed) return [];
  if (seed.visitChainPrimaryId) {
    const rows = await prisma.booking.findMany({
      where: { visitChainPrimaryId: seed.visitChainPrimaryId },
      select: CHAIN_SELECT,
    });
    if (rows.length >= 2) return sortChainBySchedule(rows as VisitChainBooking[]);
  }
  if (seed.cartGroupId) {
    const group = await loadCartGroupBookings(seed.cartGroupId);
    // Return the full cart for UI (one visit card) even before OTP-link qualifies.
    // Shared OTP still requires isVisitChainActive via relinkVisitChainForCartGroup.
    if (group.length >= 2) return group;
  }
  return [seed as VisitChainBooking];
}

export function visitChainDto(chain: VisitChainBooking[]) {
  const sorted = sortChainBySchedule(chain);
  const primary = sorted[0];
  // Display chain: linked visit OR same multi-package cart checkout.
  const isChain =
    sorted.length >= 2 &&
    (Boolean(primary.visitChainPrimaryId) || Boolean(primary.cartGroupId));
  return {
    cartGroupId: primary.cartGroupId,
    cartGroupIndex: primary.cartGroupIndex,
    visitChainPrimaryId: primary.visitChainPrimaryId,
    isVisitChain: isChain,
    siblingBookingIds: isChain ? sorted.map((b) => b.id) : [],
    visitChain: isChain
      ? sorted.map((b) => ({
          id: b.id,
          bookingNumber: b.bookingNumber,
          cartGroupIndex: b.cartGroupIndex,
          scheduledStartAt: b.scheduledStartAt,
          scheduledEndAt: b.scheduledEndAt,
          status: b.status,
          totalAmount: b.totalAmount,
          beforePhotoCount: countValidBeforePhotos(b.beforePhotoUrls),
          completionPhotoCount: countValidCompletionPhotos(b.completionPhotoUrls),
          beforePhotosReady: hasRequiredBeforePhotos(b.beforePhotoUrls),
          completionPhotosReady: hasRequiredCompletionPhotos(b.completionPhotoUrls),
        }))
      : [],
  };
}

/** After cart creates, link contiguous same-pro siblings and sync start OTP from primary. */
export async function relinkVisitChainForCartGroup(cartGroupId: string): Promise<VisitChainBooking[]> {
  const group = await loadCartGroupBookings(cartGroupId);
  if (!isVisitChainActive(group)) {
    // Clear stale chain markers if group no longer qualifies.
    const stale = group.filter((g) => g.visitChainPrimaryId);
    if (stale.length > 0) {
      await prisma.booking.updateMany({
        where: { id: { in: stale.map((s) => s.id) } },
        data: { visitChainPrimaryId: null },
      });
    }
    return group;
  }

  const sorted = sortChainBySchedule(group);
  const primaryId = sorted[0].id;
  const startToken = sorted[0].qrChallengeToken;
  const startExpires = sorted[0].qrChallengeExpiresAt;

  for (const row of sorted) {
    await prisma.booking.update({
      where: { id: row.id },
      data: {
        visitChainPrimaryId: primaryId,
        ...(startToken
          ? {
              qrChallengeToken: startToken,
              qrChallengeExpiresAt: startExpires,
            }
          : {}),
      },
    });
  }

  return loadVisitChain(primaryId);
}

export async function syncSharedStartOtpToChain(
  primaryId: string,
  token: string,
  expiresAt: Date
): Promise<void> {
  const chain = await loadVisitChain(primaryId);
  if (chain.length < 2) {
    await prisma.booking.update({
      where: { id: primaryId },
      data: { qrChallengeToken: token, qrChallengeExpiresAt: expiresAt },
    });
    return;
  }
  await prisma.booking.updateMany({
    where: { id: { in: chain.map((c) => c.id) } },
    data: {
      qrChallengeToken: token,
      qrChallengeExpiresAt: expiresAt,
      startOtpAttempts: 0,
      startOtpLockedUntil: null,
    },
  });
}

export async function syncSharedCompletionOtpToChain(
  primaryId: string,
  token: string,
  expiresAt: Date
): Promise<void> {
  const chain = await loadVisitChain(primaryId);
  const ids = chain.length >= 2 ? chain.map((c) => c.id) : [primaryId];
  await prisma.booking.updateMany({
    where: { id: { in: ids } },
    data: {
      completionOtpToken: token,
      completionOtpExpiresAt: expiresAt,
      completionOtpVerifiedAt: null,
      completionOtpAttempts: 0,
    },
  });
}

export function sumChainAmount(chain: VisitChainBooking[]): string {
  let total = 0;
  for (const row of chain) {
    const n = Number.parseFloat(String(row.totalAmount || '0'));
    if (Number.isFinite(n)) total += n;
  }
  return total.toFixed(2);
}

export function assertChainBeforePhotosReady(chain: VisitChainBooking[]): void {
  for (const row of chain) {
    if (!hasRequiredBeforePhotos(row.beforePhotoUrls)) {
      throw new DispatchError(
        'PHOTOS_REQUIRED',
        `Upload at least ${MIN_BEFORE_PHOTOS} before photographs for booking #${row.bookingNumber} before closing this visit. Currently ${countValidBeforePhotos(row.beforePhotoUrls)} stored.`,
        400
      );
    }
  }
}

export function assertChainCompletionPhotosReady(chain: VisitChainBooking[]): void {
  for (const row of chain) {
    if (!hasRequiredCompletionPhotos(row.completionPhotoUrls)) {
      throw new DispatchError(
        'COMPLETION_PHOTOS_REQUIRED',
        `Upload at least ${MIN_COMPLETION_PHOTOS} after-work photographs for booking #${row.bookingNumber}. Currently ${countValidCompletionPhotos(row.completionPhotoUrls)} stored.`,
        400
      );
    }
  }
}

/** Prefer lead (+ helper) already assigned on an earlier cart-group sibling. */
export async function findPreferredCrewForCartGroup(
  cartGroupId: string | null | undefined
): Promise<string[]> {
  if (!cartGroupId) return [];
  const siblings = await loadCartGroupBookings(cartGroupId);
  const withCrew = siblings.find((s) => s.employeeId);
  if (!withCrew?.employeeId) return [];
  const ids = [withCrew.employeeId];
  if (withCrew.helperEmployeeId) ids.push(withCrew.helperEmployeeId);
  return ids;
}
