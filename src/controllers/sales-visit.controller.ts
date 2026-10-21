import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendSuccess, sendError } from '../utils/response';
import { estimatePayloadBytes, MAX_DOCUMENT_BYTES, resolveHostedUrl } from '../utils/cloudinary';
import { isTestingWorkflowEnabled, uniqueHostedImageUrls } from '../config/testing-workflow';

const PHONE_PATTERN = /^[+\d][\d\s-]{8,19}$/;

export const createSalesVisitSchema = z.object({
  locationName: z.string().min(2, 'Warehouse / hub / location name is required'),
  addressLine: z.string().min(3, 'Location address is required'),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  inChargeName: z.string().min(2, 'In-charge person name is required'),
  inChargePhone: z.string().min(10, 'In-charge mobile number is required').regex(PHONE_PATTERN, 'Enter a valid mobile number'),
  inChargeEmail: z.string().email('Enter a valid email address').optional().or(z.literal('')),
  photoPayloads: z.array(z.string().min(8)).max(12).optional(),
  photoUrls: z.array(z.string().min(8)).max(12).optional(),
  notes: z.string().max(2000).optional(),
});

export const updateSalesVisitSchema = createSalesVisitSchema.partial();

async function resolveSalesManagerActor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      employeeProfile: true,
      vendorProfile: true,
      managerProfile: true,
    },
  });

  const vendorId =
    user?.employeeProfile?.vendorId || user?.vendorProfile?.id || user?.managerProfile?.vendorId || null;

  return {
    user,
    vendorId,
    employeeId: user?.employeeProfile?.id || null,
    expertKind: user?.employeeProfile?.expertKind || null,
    isVendor: !!user?.vendorProfile,
    isManager: user?.role === 'OPERATIONS_MANAGER',
    isSalesManager: user?.employeeProfile?.expertKind === 'SALES_MANAGER',
  };
}

async function hostVisitPhotos(payloads: string[] | undefined, existing: string[] | undefined): Promise<string[]> {
  const hosted: string[] = uniqueHostedImageUrls(existing);
  const incoming = Array.isArray(payloads) ? payloads : [];
  for (const payload of incoming) {
    if (estimatePayloadBytes(payload) > MAX_DOCUMENT_BYTES) {
      throw Object.assign(new Error('Each visit photograph must be 500MB or smaller'), { code: 'PAYLOAD_TOO_LARGE' });
    }
    const url = await resolveHostedUrl(payload, 'servfex/visits');
    if (url && !hosted.includes(url)) {
      hosted.push(url);
    }
  }
  return hosted;
}

export const listSalesVisits = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const actor = await resolveSalesManagerActor(userId);
    if (!actor.vendorId) {
      sendError(res, 'NOT_FOUND', 'Vendor or Sales Manager profile not found', 404);
      return;
    }

    const page = parseInt(String(req.query.page || '1'), 10) || 1;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const where: { vendorId: string; employeeId?: string } = { vendorId: actor.vendorId };
    if (actor.isSalesManager && actor.employeeId) {
      where.employeeId = actor.employeeId;
    } else if (!actor.isVendor && !actor.isManager) {
      sendError(res, 'FORBIDDEN', 'Only a Sales Manager or Provider can view visits', 403);
      return;
    }

    const [visits, total] = await Promise.all([
      prisma.salesVisit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          employee: {
            select: {
              id: true,
              expertKind: true,
              user: { select: { id: true, name: true, phone: true } },
            },
          },
        },
      }),
      prisma.salesVisit.count({ where }),
    ]);

    sendSuccess(res, { visits }, 200, {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const getSalesVisitById = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const actor = await resolveSalesManagerActor(userId);
    if (!actor.vendorId) {
      sendError(res, 'NOT_FOUND', 'Vendor or Sales Manager profile not found', 404);
      return;
    }

    const visit = await prisma.salesVisit.findFirst({
      where: { id, vendorId: actor.vendorId },
      include: {
        employee: {
          select: {
            id: true,
            expertKind: true,
            user: { select: { id: true, name: true, phone: true } },
          },
        },
      },
    });

    if (!visit) {
      sendError(res, 'NOT_FOUND', 'Visit not found', 404);
      return;
    }

    if (actor.isSalesManager && visit.employeeId !== actor.employeeId) {
      sendError(res, 'FORBIDDEN', 'You can only view your own visits', 403);
      return;
    }

    sendSuccess(res, { visit }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const createSalesVisit = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const actor = await resolveSalesManagerActor(userId);

    if (!actor.employeeId || !actor.vendorId) {
      sendError(res, 'FORBIDDEN', 'Only an authenticated Sales Manager can create visits', 403);
      return;
    }
    if (isTestingWorkflowEnabled() && !actor.isSalesManager) {
      sendError(res, 'FORBIDDEN', 'Visit capture is only available to Sales Managers', 403);
      return;
    }

    const {
      locationName,
      addressLine,
      latitude,
      longitude,
      inChargeName,
      inChargePhone,
      inChargeEmail,
      photoPayloads,
      photoUrls,
      notes,
    } = req.body;

    let hostedPhotos: string[];
    try {
      hostedPhotos = await hostVisitPhotos(photoPayloads, photoUrls);
    } catch (uploadErr: any) {
      sendError(res, uploadErr.code || 'IMAGE_UPLOAD_FAILED', uploadErr.message, uploadErr.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400);
      return;
    }

    const visit = await prisma.salesVisit.create({
      data: {
        employeeId: actor.employeeId,
        vendorId: actor.vendorId,
        locationName: String(locationName).trim(),
        addressLine: String(addressLine).trim(),
        latitude: latitude ?? null,
        longitude: longitude ?? null,
        inChargeName: String(inChargeName).trim(),
        inChargePhone: String(inChargePhone).replace(/\s+/g, ''),
        inChargeEmail: inChargeEmail ? String(inChargeEmail).toLowerCase().trim() : null,
        photoUrls: hostedPhotos,
        notes: notes ? String(notes).trim() : null,
      },
      include: {
        employee: {
          select: {
            id: true,
            expertKind: true,
            user: { select: { id: true, name: true, phone: true } },
          },
        },
      },
    });

    sendSuccess(res, { visit }, 201);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const updateSalesVisit = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const actor = await resolveSalesManagerActor(userId);

    if (!actor.employeeId || !actor.isSalesManager) {
      sendError(res, 'FORBIDDEN', 'Only the Sales Manager who created a visit can update it', 403);
      return;
    }

    const existing = await prisma.salesVisit.findFirst({
      where: { id, employeeId: actor.employeeId, vendorId: actor.vendorId || undefined },
    });
    if (!existing) {
      sendError(res, 'NOT_FOUND', 'Visit not found', 404);
      return;
    }

    const {
      locationName,
      addressLine,
      latitude,
      longitude,
      inChargeName,
      inChargePhone,
      inChargeEmail,
      photoPayloads,
      photoUrls,
      notes,
    } = req.body;

    let hostedPhotos = existing.photoUrls;
    if (photoPayloads || photoUrls) {
      try {
        hostedPhotos = await hostVisitPhotos(photoPayloads, photoUrls ?? existing.photoUrls);
      } catch (uploadErr: any) {
        sendError(res, uploadErr.code || 'IMAGE_UPLOAD_FAILED', uploadErr.message, uploadErr.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400);
        return;
      }
    }

    const visit = await prisma.salesVisit.update({
      where: { id },
      data: {
        ...(locationName ? { locationName: String(locationName).trim() } : {}),
        ...(addressLine ? { addressLine: String(addressLine).trim() } : {}),
        ...(latitude !== undefined ? { latitude } : {}),
        ...(longitude !== undefined ? { longitude } : {}),
        ...(inChargeName ? { inChargeName: String(inChargeName).trim() } : {}),
        ...(inChargePhone ? { inChargePhone: String(inChargePhone).replace(/\s+/g, '') } : {}),
        ...(inChargeEmail !== undefined
          ? { inChargeEmail: inChargeEmail ? String(inChargeEmail).toLowerCase().trim() : null }
          : {}),
        photoUrls: hostedPhotos,
        ...(notes !== undefined ? { notes: notes ? String(notes).trim() : null } : {}),
      },
      include: {
        employee: {
          select: {
            id: true,
            expertKind: true,
            user: { select: { id: true, name: true, phone: true } },
          },
        },
      },
    });

    sendSuccess(res, { visit }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};

export const deleteSalesVisit = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const actor = await resolveSalesManagerActor(userId);

    const visit = await prisma.salesVisit.findFirst({
      where: { id, vendorId: actor.vendorId || undefined },
    });
    if (!visit) {
      sendError(res, 'NOT_FOUND', 'Visit not found', 404);
      return;
    }

    const canDelete =
      (actor.isSalesManager && visit.employeeId === actor.employeeId) || actor.isVendor;
    if (!canDelete) {
      sendError(res, 'FORBIDDEN', 'You cannot delete this visit', 403);
      return;
    }

    await prisma.salesVisit.delete({ where: { id } });
    sendSuccess(res, { message: 'Visit deleted' }, 200);
  } catch (err: any) {
    sendError(res, 'INTERNAL_SERVER_ERROR', err.message, 500);
  }
};
