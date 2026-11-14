import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendError, sendSuccess } from '../utils/response';
import {
  isValidCoordinate,
  resolveWarehouse,
  type WarehouseCandidate,
} from '../services/dispatch.rules';
import {
  generateAvailableSlots,
  listAvailableDates,
  resolveBookingDurationMinutes,
} from '../services/slot.engine';
import { createSlotHold, holdToDisplay, SlotHoldError } from '../services/slot.hold';
import {
  listFreeCheckedInSubstitutes,
  markCrewAbsentAndMaybeSubstitute,
} from '../services/crew.assign';
import { SlotType } from '@prisma/client';

export const availabilityQuerySchema = z.object({
  serviceId: z.string().uuid(),
  packageId: z.string().uuid().optional(),
  addressId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const holdSlotSchema = z.object({
  serviceId: z.string().uuid(),
  packageId: z.string().uuid().optional().nullable(),
  addressId: z.string().uuid(),
  scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  scheduledStartAt: z.string().min(10),
  scheduledEndAt: z.string().min(10),
  slotType: z.enum(['NORMAL', 'EXPRESS']).optional(),
});

export const crewAbsentSchema = z.object({
  absentEmployeeId: z.string().uuid(),
  substituteEmployeeId: z.string().uuid().optional().nullable(),
});

/** Short TTL cache — hub routing rarely changes mid-session; avoids re-scanning all vendors. */
const hubResolveCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof resolveHubForAddressUncached>> }>();
const HUB_CACHE_TTL_MS = 45_000;

async function resolveHubForAddress(serviceId: string, addressId: string, userId: string) {
  const key = `${userId}:${serviceId}:${addressId}`;
  const hit = hubResolveCache.get(key);
  if (hit && Date.now() - hit.at < HUB_CACHE_TTL_MS) return hit.value;
  const value = await resolveHubForAddressUncached(serviceId, addressId, userId);
  hubResolveCache.set(key, { at: Date.now(), value });
  if (hubResolveCache.size > 500) {
    const cutoff = Date.now() - HUB_CACHE_TTL_MS;
    for (const [k, v] of hubResolveCache) {
      if (v.at < cutoff) hubResolveCache.delete(k);
    }
  }
  return value;
}

async function resolveHubForAddressUncached(serviceId: string, addressId: string, userId: string) {
  // Slim queries: only the package we need + vendors that actually offer this service
  // (or have an empty catalog = general partner). Avoid loading every employee row.
  const [service, address, candidateVendors] = await Promise.all([
    prisma.service.findFirst({
      where: { id: serviceId, isActive: true, deletedAt: null },
      select: {
        id: true,
        categoryId: true,
        subCategoryId: true,
        durationText: true,
        packages: {
          where: { isActive: true },
          select: { id: true, durationMinutes: true, duration: true },
        },
      },
    }),
    prisma.userAddress.findFirst({
      where: { id: addressId, userId },
      select: {
        id: true,
        latitude: true,
        longitude: true,
        city: true,
      },
    }),
    prisma.vendorProfile.findMany({
      where: {
        isActive: true,
        kycStatus: { not: 'REJECTED' },
        OR: [
          { vendorServices: { none: {} } },
          { vendorServices: { some: { serviceId, isActive: true } } },
        ],
      },
      select: {
        id: true,
        latitude: true,
        longitude: true,
        serviceRadiusKm: true,
        location: true,
        _count: {
          select: { employees: { where: { isAvailable: true } } },
        },
      },
    }),
  ]);

  if (!service || !address) return null;

  const warehouseCandidates: WarehouseCandidate[] = candidateVendors.map((vendor) => ({
    id: vendor.id,
    latitude: vendor.latitude,
    longitude: vendor.longitude,
    serviceRadiusKm: vendor.serviceRadiusKm ?? 25,
    location: vendor.location || '',
    offersService: true,
    availableExperts: vendor._count.employees,
  }));

  const point = isValidCoordinate(address.latitude, address.longitude)
    ? { lat: address.latitude as number, lng: address.longitude as number }
    : null;
  const resolution = resolveWarehouse(warehouseCandidates, point, address.city, null);
  if (!resolution) return { service, address, vendorId: null as string | null };

  return { service, address, vendorId: resolution.vendorId };
}

export const getAvailableDates = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const parsed = availabilityQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, 'BAD_REQUEST', 'Invalid query', 400);
      return;
    }
    const { serviceId, packageId, addressId, fromDate } = parsed.data;
    const resolved = await resolveHubForAddress(serviceId, addressId, userId);
    if (!resolved?.vendorId) {
      sendSuccess(res, { dates: [], message: 'No hub serves this location' });
      return;
    }
    const pkg = packageId
      ? resolved.service.packages.find((p) => p.id === packageId)
      : resolved.service.packages[0];
    const duration = resolveBookingDurationMinutes({
      packageDurationMinutes: pkg?.durationMinutes,
      packageDurationText: pkg?.duration,
      serviceDurationText: resolved.service.durationText,
    });
    const today = new Date();
    const from =
      fromDate ||
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const dates = await listAvailableDates({
      vendorId: resolved.vendorId,
      categoryId: resolved.service.categoryId,
      subCategoryId: resolved.service.subCategoryId,
      packageId: pkg?.id,
      durationMinutes: duration,
      fromDateYmd: from,
      days: 7,
    });
    sendSuccess(res, { dates, vendorId: resolved.vendorId, durationMinutes: duration });
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to load available dates', 500);
  }
};

export const getAvailableSlots = async (req: Request, res: Response): Promise<void> => {
  const t0 = Date.now();
  try {
    const userId = req.user!.userId;
    const parsed = availabilityQuerySchema.safeParse(req.query);
    if (!parsed.success || !parsed.data.date) {
      sendError(res, 'BAD_REQUEST', 'serviceId, addressId and date are required', 400);
      return;
    }
    const { serviceId, packageId, addressId, date } = parsed.data;
    const resolved = await resolveHubForAddress(serviceId, addressId, userId);
    const tHub = Date.now();
    if (!resolved?.vendorId) {
      sendSuccess(res, { slots: [] });
      return;
    }
    const pkg = packageId
      ? resolved.service.packages.find((p) => p.id === packageId)
      : resolved.service.packages[0];
    const duration = resolveBookingDurationMinutes({
      packageDurationMinutes: pkg?.durationMinutes,
      packageDurationText: pkg?.duration,
      serviceDurationText: resolved.service.durationText,
    });
    const slots = await generateAvailableSlots({
      vendorId: resolved.vendorId,
      categoryId: resolved.service.categoryId,
      subCategoryId: resolved.service.subCategoryId,
      packageId: pkg?.id,
      durationMinutes: duration,
      dateYmd: date,
    });
    console.log(
      `[slots] date=${date} hub=${tHub - t0}ms gen=${Date.now() - tHub}ms total=${Date.now() - t0}ms n=${slots.length}`
    );
    sendSuccess(res, {
      slots: slots.map((s) => ({
        scheduledDate: s.scheduledDate,
        scheduledStartAt: s.startAt.toISOString(),
        scheduledEndAt: s.endAt.toISOString(),
        scheduledTimeSlot: s.label,
        slotType: s.slotType,
        requiredProfessionals: s.requiredProfessionals,
        availablePros: s.availablePros,
      })),
      vendorId: resolved.vendorId,
      durationMinutes: duration,
    });
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to load slots', 500);
  }
};

export const holdSlot = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const body = req.body as z.infer<typeof holdSlotSchema>;
    const resolved = await resolveHubForAddress(body.serviceId, body.addressId, userId);
    if (!resolved?.vendorId) {
      sendError(res, 'BAD_REQUEST', 'No hub serves this location', 400);
      return;
    }

    let customer = await prisma.customerProfile.findUnique({ where: { userId } });
    if (!customer) {
      customer = await prisma.customerProfile.create({ data: { userId } });
    }

    const startAt = new Date(body.scheduledStartAt);
    const endAt = new Date(body.scheduledEndAt);
    if (!(endAt > startAt)) {
      sendError(res, 'BAD_REQUEST', 'Invalid slot window', 400);
      return;
    }

    const hold = await createSlotHold({
      customerUserId: userId,
      customerId: customer.id,
      totalBookings: customer.totalBookings || 0,
      vendorId: resolved.vendorId,
      serviceId: body.serviceId,
      categoryId: resolved.service.categoryId,
      packageId: body.packageId,
      addressId: body.addressId,
      scheduledDate: body.scheduledDate,
      startAt,
      endAt,
      slotType: (body.slotType as SlotType) || SlotType.NORMAL,
    });

    sendSuccess(res, holdToDisplay(hold), 201);
  } catch (err) {
    if (err instanceof SlotHoldError) {
      sendError(res, err.code, err.message, err.httpStatus);
      return;
    }
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to hold slot', 500);
  }
};

export const listBookingSubstituteOptions = async (req: Request, res: Response): Promise<void> => {
  try {
    const options = await listFreeCheckedInSubstitutes({ bookingId: req.params.id as string });
    sendSuccess(res, { options, offlinePairAllowed: true });
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to list substitutes', 500);
  }
};

export const markBookingCrewAbsent = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await markCrewAbsentAndMaybeSubstitute({
      bookingId: req.params.id as string,
      absentEmployeeId: req.body.absentEmployeeId,
      actorUserId: req.user!.userId,
      substituteEmployeeId: req.body.substituteEmployeeId,
    });
    sendSuccess(res, result);
  } catch (err: any) {
    console.error(err);
    sendError(res, 'BAD_REQUEST', err?.message || 'Failed to update crew', 400);
  }
};
