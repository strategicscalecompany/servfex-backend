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
  parseDurationMinutes,
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

async function resolveHubForAddress(serviceId: string, addressId: string, userId: string) {
  const [service, address, candidateVendors] = await Promise.all([
    prisma.service.findFirst({
      where: { id: serviceId, isActive: true, deletedAt: null },
      include: {
        packages: { where: { isActive: true } },
      },
    }),
    prisma.userAddress.findFirst({ where: { id: addressId, userId } }),
    prisma.vendorProfile.findMany({
      where: { isActive: true, kycStatus: { not: 'REJECTED' } },
      select: {
        id: true,
        latitude: true,
        longitude: true,
        serviceRadiusKm: true,
        location: true,
        vendorServices: { where: { isActive: true }, select: { serviceId: true } },
        employees: { where: { isAvailable: true }, select: { id: true }, take: 25 },
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
    offersService:
      vendor.vendorServices.length === 0 ||
      vendor.vendorServices.some((vs) => vs.serviceId === serviceId),
    availableExperts: vendor.employees.length,
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
    const duration = parseDurationMinutes(pkg?.durationMinutes, pkg?.duration || resolved.service.durationText);
    const today = new Date();
    const from =
      fromDate ||
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const dates = await listAvailableDates({
      vendorId: resolved.vendorId,
      categoryId: resolved.service.categoryId,
      packageId: pkg?.id,
      durationMinutes: duration,
      fromDateYmd: from,
      days: 14,
    });
    sendSuccess(res, { dates, vendorId: resolved.vendorId, durationMinutes: duration });
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to load available dates', 500);
  }
};

export const getAvailableSlots = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const parsed = availabilityQuerySchema.safeParse(req.query);
    if (!parsed.success || !parsed.data.date) {
      sendError(res, 'BAD_REQUEST', 'serviceId, addressId and date are required', 400);
      return;
    }
    const { serviceId, packageId, addressId, date } = parsed.data;
    const resolved = await resolveHubForAddress(serviceId, addressId, userId);
    if (!resolved?.vendorId) {
      sendSuccess(res, { slots: [] });
      return;
    }
    const pkg = packageId
      ? resolved.service.packages.find((p) => p.id === packageId)
      : resolved.service.packages[0];
    const duration = parseDurationMinutes(pkg?.durationMinutes, pkg?.duration || resolved.service.durationText);
    const slots = await generateAvailableSlots({
      vendorId: resolved.vendorId,
      categoryId: resolved.service.categoryId,
      packageId: pkg?.id,
      durationMinutes: duration,
      dateYmd: date,
    });
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

    const customer = await prisma.customerProfile.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });

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
