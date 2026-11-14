import { SlotHoldStatus, SlotType } from '@prisma/client';
import { prisma } from '../config/prisma';
import { SLOT_HOLD_TTL_SECONDS, formatTimeSlotLabel } from '../config/scheduling';
import { countFreeEligiblePros } from './slot.engine';
import { resolveRequiredProfessionals } from './tag.eligibility';

const TIE_WINDOW_MS = 250;

export class SlotHoldError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus = 409
  ) {
    super(message);
    this.name = 'SlotHoldError';
  }
}

function priorityScore(totalBookings: number): number {
  // Higher wins in a true tie. New customers (0) get a large bonus.
  if (totalBookings <= 0) return 1_000_000;
  return totalBookings;
}

export async function createSlotHold(params: {
  customerUserId: string;
  customerId: string | null;
  totalBookings: number;
  vendorId: string;
  serviceId: string;
  categoryId: string;
  packageId?: string | null;
  addressId?: string | null;
  scheduledDate: string;
  startAt: Date;
  endAt: Date;
  slotType?: SlotType;
}) {
  const now = new Date();
  const required = await resolveRequiredProfessionals({
    vendorId: params.vendorId,
    packageId: params.packageId,
  });

  // Expire stale holds first
  await prisma.slotHold.updateMany({
    where: { status: SlotHoldStatus.ACTIVE, expiresAt: { lte: now } },
    data: { status: SlotHoldStatus.EXPIRED },
  });

  // Existing active hold by same customer on same interval → extend
  const mine = await prisma.slotHold.findFirst({
    where: {
      customerUserId: params.customerUserId,
      vendorId: params.vendorId,
      scheduledStartAt: params.startAt,
      scheduledEndAt: params.endAt,
      status: SlotHoldStatus.ACTIVE,
      expiresAt: { gt: now },
    },
  });
  if (mine) {
    return prisma.slotHold.update({
      where: { id: mine.id },
      data: { expiresAt: new Date(now.getTime() + SLOT_HOLD_TTL_SECONDS * 1000) },
    });
  }

  const competing = await prisma.slotHold.findMany({
    where: {
      vendorId: params.vendorId,
      status: SlotHoldStatus.ACTIVE,
      expiresAt: { gt: now },
      scheduledStartAt: params.startAt,
      scheduledEndAt: params.endAt,
    },
    orderBy: { createdAt: 'asc' },
  });

  if (competing.length > 0) {
    const earliest = competing[0];
    const isTie = now.getTime() - earliest.createdAt.getTime() <= TIE_WINDOW_MS;
    if (!isTie) {
      throw new SlotHoldError(
        'SLOT_TAKEN',
        'Sorry, this slot was just taken by another customer. Please hurry and pick another before it’s gone.'
      );
    }
    // True race: prefer higher priorityScore (new customers / loyalty)
    const myScore = priorityScore(params.totalBookings);
    if (myScore <= earliest.priorityScore) {
      throw new SlotHoldError(
        'SLOT_TAKEN',
        'Sorry, this slot was just taken by another customer. Please hurry and pick another before it’s gone.'
      );
    }
    // Steal hold for higher priority
    await prisma.slotHold.update({
      where: { id: earliest.id },
      data: { status: SlotHoldStatus.RELEASED },
    });
  }

  const free = await countFreeEligiblePros({
    vendorId: params.vendorId,
    categoryId: params.categoryId,
    packageId: params.packageId,
    startAt: params.startAt,
    endAt: params.endAt,
    requireCheckedIn: true,
    excludeHoldCapacity: true,
  });
  // Re-count with holds except we just released; still need enough free pros
  // (same checked-in pool used for today / tomorrow / week slot offers).
  const freeWithHolds = await countFreeEligiblePros({
    vendorId: params.vendorId,
    categoryId: params.categoryId,
    packageId: params.packageId,
    startAt: params.startAt,
    endAt: params.endAt,
    requireCheckedIn: true,
    excludeHoldCapacity: false,
  });
  void free;
  if (freeWithHolds < required) {
    throw new SlotHoldError(
      'SLOT_UNAVAILABLE',
      'Sorry, this slot was just taken by another customer. Please hurry and pick another before it’s gone.'
    );
  }

  return prisma.slotHold.create({
    data: {
      customerUserId: params.customerUserId,
      customerId: params.customerId,
      vendorId: params.vendorId,
      serviceId: params.serviceId,
      packageId: params.packageId || null,
      addressId: params.addressId || null,
      scheduledDate: params.scheduledDate,
      scheduledStartAt: params.startAt,
      scheduledEndAt: params.endAt,
      slotType: params.slotType || SlotType.NORMAL,
      requiredProfessionals: required,
      status: SlotHoldStatus.ACTIVE,
      expiresAt: new Date(now.getTime() + SLOT_HOLD_TTL_SECONDS * 1000),
      priorityScore: priorityScore(params.totalBookings),
    },
  });
}

export async function consumeSlotHold(holdId: string, customerUserId: string) {
  const now = new Date();
  const hold = await prisma.slotHold.findFirst({
    where: {
      id: holdId,
      customerUserId,
      status: SlotHoldStatus.ACTIVE,
      expiresAt: { gt: now },
    },
  });
  if (!hold) {
    throw new SlotHoldError(
      'HOLD_EXPIRED',
      'Your slot hold expired. Please pick a time again.',
      409
    );
  }
  await prisma.slotHold.update({
    where: { id: hold.id },
    data: { status: SlotHoldStatus.CONSUMED },
  });
  return hold;
}

export function holdToDisplay(hold: {
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  scheduledDate: string;
  slotType: SlotType;
  expiresAt: Date;
  id: string;
  requiredProfessionals: number;
}) {
  return {
    holdId: hold.id,
    scheduledDate: hold.scheduledDate,
    scheduledTimeSlot: formatTimeSlotLabel(hold.scheduledStartAt, hold.scheduledEndAt),
    scheduledStartAt: hold.scheduledStartAt.toISOString(),
    scheduledEndAt: hold.scheduledEndAt.toISOString(),
    slotType: hold.slotType,
    requiredProfessionals: hold.requiredProfessionals,
    expiresAt: hold.expiresAt.toISOString(),
  };
}
