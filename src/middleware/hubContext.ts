import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma';
import { sendError } from '../utils/response';

const HUB_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Resolve assigned hub IDs for a HOM (primary vendorId + zone CSV names/UUIDs). */
async function resolveManagerAssignedHubIds(manager: {
  vendorId: string | null;
  zone: string | null;
}): Promise<string[]> {
  const ids = new Set<string>();
  if (manager.vendorId) ids.add(manager.vendorId);

  const parts = (manager.zone || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length === 0) return [...ids];

  const vendors = await prisma.vendorProfile.findMany({
    select: { id: true, companyName: true, warehouseName: true },
  });
  const byId = new Map(vendors.map((v) => [v.id, v.id]));
  const byName = new Map<string, string>();
  for (const v of vendors) {
    if (v.warehouseName) byName.set(v.warehouseName.trim().toLowerCase(), v.id);
    if (v.companyName) byName.set(v.companyName.trim().toLowerCase(), v.id);
  }

  for (const part of parts) {
    if (HUB_UUID_RE.test(part)) {
      const id = byId.get(part);
      if (id) ids.add(id);
    } else {
      const id = byName.get(part.toLowerCase());
      if (id) ids.add(id);
    }
  }

  return [...ids];
}

/** Attaches hubVendorId for VENDOR / OPERATIONS_MANAGER (and employee tied to a hub). */
export async function requireHubContext(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      sendError(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        role: true,
        vendorProfile: { select: { id: true } },
        employeeProfile: { select: { vendorId: true } },
        managerProfile: { select: { vendorId: true, kind: true, zone: true } },
      },
    });

    const allowed =
      !!user?.vendorProfile ||
      user?.role === 'OPERATIONS_MANAGER' ||
      user?.managerProfile?.kind === 'OPERATIONS';
    if (!allowed) {
      sendError(res, 'FORBIDDEN', 'Only hub partner or operations manager can manage this hub', 403);
      return;
    }

    const requested =
      (typeof req.query.vendorId === 'string' && req.query.vendorId.trim()) ||
      (typeof req.headers['x-hub-vendor-id'] === 'string' &&
        String(req.headers['x-hub-vendor-id']).trim()) ||
      '';

    let vendorId: string | null = null;

    if (user?.vendorProfile?.id) {
      vendorId = user.vendorProfile.id;
    } else if (user?.role === 'OPERATIONS_MANAGER' || user?.managerProfile?.kind === 'OPERATIONS') {
      const assigned = await resolveManagerAssignedHubIds({
        vendorId: user.managerProfile?.vendorId || null,
        zone: user.managerProfile?.zone || null,
      });
      if (requested) {
        if (!assigned.includes(requested)) {
          sendError(res, 'FORBIDDEN', 'You can only use a hub you are assigned to', 403);
          return;
        }
        vendorId = requested;
      } else {
        vendorId = user.managerProfile?.vendorId || assigned[0] || null;
      }
    } else {
      vendorId = user?.employeeProfile?.vendorId || null;
    }

    if (!vendorId) {
      sendError(res, 'FORBIDDEN', 'Hub context required', 403);
      return;
    }
    (req as any).hubVendorId = vendorId;
    next();
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to resolve hub', 500);
  }
}
