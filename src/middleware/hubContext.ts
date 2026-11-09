import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma';
import { sendError } from '../utils/response';

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
        managerProfile: { select: { vendorId: true, kind: true } },
      },
    });
    const vendorId =
      user?.vendorProfile?.id ||
      user?.managerProfile?.vendorId ||
      user?.employeeProfile?.vendorId ||
      null;

    if (!vendorId) {
      sendError(res, 'FORBIDDEN', 'Hub context required', 403);
      return;
    }
    const allowed =
      !!user?.vendorProfile ||
      user?.role === 'OPERATIONS_MANAGER' ||
      user?.managerProfile?.kind === 'OPERATIONS';
    if (!allowed) {
      sendError(res, 'FORBIDDEN', 'Only hub partner or operations manager can manage tags', 403);
      return;
    }
    (req as any).hubVendorId = vendorId;
    next();
  } catch (err) {
    console.error(err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to resolve hub', 500);
  }
}
