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

/** Same doorstep; if both sides are assigned, require the same lead pro. */
export function canChainTogether(
  a: Pick<VisitChainBooking, 'addressId' | 'employeeId'>,
  b: Pick<VisitChainBooking, 'addressId' | 'employeeId'>
): boolean {
  if (!a.addressId || !b.addressId || a.addressId !== b.addressId) return false;
  if (a.employeeId && b.employeeId && a.employeeId !== b.employeeId) return false;
  return true;
}

/**
 * Expand around `seedId` to the contiguous back-to-back visit only
 * (e.g. 3–4pm same day). Non-adjacent / next-day cart siblings stay out.
 */
export function contiguousVisitSegmentAround<
  T extends {
    id: string;
    addressId: string;
    employeeId: string | null;
    scheduledStartAt: Date | null;
    scheduledEndAt: Date | null;
    cartGroupIndex: number | null;
  },
>(rows: T[], seedId: string): T[] {
  if (rows.length === 0) return [];
  const sorted = sortChainBySchedule(rows);
  const seedIdx = sorted.findIndex((r) => r.id === seedId);
  if (seedIdx < 0) return sorted.filter((r) => r.id === seedId);

  let left = seedIdx;
  let right = seedIdx;
  while (left > 0) {
    const prev = sorted[left - 1];
    const cur = sorted[left];
    if (!canChainTogether(prev, cur) || !isContiguousSlots(prev.scheduledEndAt, cur.scheduledStartAt)) {
      break;
    }
    left -= 1;
  }
  while (right < sorted.length - 1) {
    const cur = sorted[right];
    const next = sorted[right + 1];
    if (!canChainTogether(cur, next) || !isContiguousSlots(cur.scheduledEndAt, next.scheduledStartAt)) {
      break;
    }
    right += 1;
  }
  return sorted.slice(left, right + 1);
}

/** Split a cart into contiguous same-doorstep visit segments. */
export function splitContiguousVisitSegments<
  T extends {
    id: string;
    addressId: string;
    employeeId: string | null;
    scheduledStartAt: Date | null;
    scheduledEndAt: Date | null;
    cartGroupIndex: number | null;
  },
>(rows: T[]): T[][] {
  if (rows.length === 0) return [];
  const sorted = sortChainBySchedule(rows);
  const segments: T[][] = [];
  let current: T[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = current[current.length - 1];
    const next = sorted[i];
    if (canChainTogether(prev, next) && isContiguousSlots(prev.scheduledEndAt, next.scheduledStartAt)) {
      current.push(next);
    } else {
      segments.push(current);
      current = [next];
    }
  }
  segments.push(current);
  return segments;
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

  // Prefer the contiguous segment around this booking — never the whole multi-day cart.
  let pool: VisitChainBooking[] = [seed as VisitChainBooking];
  if (seed.visitChainPrimaryId) {
    const rows = await prisma.booking.findMany({
      where: { visitChainPrimaryId: seed.visitChainPrimaryId },
      select: CHAIN_SELECT,
    });
    if (rows.length >= 2) pool = rows as VisitChainBooking[];
  } else if (seed.cartGroupId) {
    pool = await loadCartGroupBookings(seed.cartGroupId);
  }

  const segment = contiguousVisitSegmentAround(pool, seed.id);
  const resolved = segment.length >= 1 ? segment : [seed as VisitChainBooking];

  // Stale multi-day cart links: clear visitChainPrimaryId so OTP is not written to a sibling job.
  if (seed.visitChainPrimaryId) {
    const linkedIds = new Set(pool.map((r) => r.id));
    const segmentIds = new Set(resolved.map((r) => r.id));
    const orphanIds = [...linkedIds].filter((id) => !segmentIds.has(id));
    if (resolved.length < 2 || orphanIds.length > 0) {
      const clearIds = resolved.length < 2 ? [seed.id, ...orphanIds] : orphanIds;
      if (clearIds.length > 0) {
        void prisma.booking
          .updateMany({
            where: { id: { in: clearIds }, visitChainPrimaryId: { not: null } },
            data: { visitChainPrimaryId: null },
          })
          .catch(() => undefined);
      }
    }
  }

  return resolved;
}

export function visitChainDto(chain: VisitChainBooking[]) {
  const sorted = sortChainBySchedule(chain);
  const primary = sorted[0];
  // One visit card only for contiguous back-to-back packages (same doorstep).
  const isChain = sorted.length >= 2;
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

/** After cart creates, link each contiguous same-pro segment separately (not the whole cart). */
export async function relinkVisitChainForCartGroup(cartGroupId: string): Promise<VisitChainBooking[]> {
  const group = await loadCartGroupBookings(cartGroupId);
  const segments = splitContiguousVisitSegments(group);

  const keepLinkedIds = new Set<string>();
  for (const segment of segments) {
    if (!isVisitChainActive(segment)) continue;
    const sorted = sortChainBySchedule(segment);
    const primaryId = sorted[0].id;
    const startToken = sorted[0].qrChallengeToken;
    const startExpires = sorted[0].qrChallengeExpiresAt;
    for (const row of sorted) {
      keepLinkedIds.add(row.id);
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
  }

  const stale = group.filter((g) => g.visitChainPrimaryId && !keepLinkedIds.has(g.id));
  if (stale.length > 0) {
    await prisma.booking.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: { visitChainPrimaryId: null },
    });
  }

  return group.length > 0 ? loadVisitChain(group[0].id) : [];
}

/** Sync OTP onto the contiguous visit around `bookingId` (never a stale primary sibling). */
export async function syncSharedStartOtpToChain(
  bookingId: string,
  token: string,
  expiresAt: Date
): Promise<void> {
  const chain = await loadVisitChain(bookingId);
  const ids = (chain.length >= 1 ? chain.map((c) => c.id) : [bookingId]).filter(Boolean);
  await prisma.booking.updateMany({
    where: { id: { in: ids } },
    data: {
      qrChallengeToken: token,
      qrChallengeExpiresAt: expiresAt,
      startOtpAttempts: 0,
      startOtpLockedUntil: null,
    },
  });
}

export async function syncSharedCompletionOtpToChain(
  bookingId: string,
  token: string,
  expiresAt: Date
): Promise<void> {
  const chain = await loadVisitChain(bookingId);
  const ids = (chain.length >= 1 ? chain.map((c) => c.id) : [bookingId]).filter(Boolean);
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
