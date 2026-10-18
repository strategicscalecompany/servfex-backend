import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendError, sendSuccess } from '../utils/response';
import { logAuditEvent } from '../utils/audit';

export const listReviewsQuerySchema = z.object({
  query: z.object({
    page: z.string().optional().default('1').transform((v) => Math.max(1, parseInt(v, 10))),
    limit: z.string().optional().default('20').transform((v) => Math.min(100, Math.max(1, parseInt(v, 10)))),
    rating: z.string().optional().transform((v) => (v ? parseInt(v, 10) : undefined)),
    isHidden: z.string().optional().transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
    hasReports: z.string().optional().transform((v) => (v === 'true' ? true : undefined)),
    search: z.string().optional(),
    sortBy: z.enum(['createdAt', 'rating', 'reportCount']).optional().default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
  }),
});

export const hideReviewSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    reason: z.string().min(3, 'A reason is required to hide a review'),
  }),
});

export const getReviews = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, limit, rating, isHidden, hasReports, search, sortBy, sortOrder } = req.query as any;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (rating !== undefined) {
      where.rating = rating;
    }
    if (isHidden !== undefined) {
      where.isHidden = isHidden;
    }
    if (hasReports) {
      where.reportCount = { gt: 0 };
    }
    if (search) {
      where.OR = [
        { comment: { contains: search, mode: 'insensitive' } },
        { customer: { name: { contains: search, mode: 'insensitive' } } },
        { service: { name: { contains: search, mode: 'insensitive' } } },
        { vendor: { companyName: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [total, reviews] = await Promise.all([
      prisma.review.count({ where }),
      prisma.review.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          customer: { select: { id: true, name: true, email: true, profilePhotoUrl: true } },
          service: { select: { id: true, name: true } },
          vendor: { select: { id: true, companyName: true } },
          employee: { include: { user: { select: { name: true } } } },
          booking: { select: { id: true, bookingNumber: true } },
        },
      }),
    ]);

    sendSuccess(res, reviews, 200, {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    next(error);
  }
};

export const hideReview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { reason } = req.body;

    const review = await prisma.review.findUnique({ where: { id } });
    if (!review) {
      sendError(res, 'REVIEW_NOT_FOUND', 'Review not found', 404);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const r = await tx.review.update({
        where: { id },
        data: { isHidden: true },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'REVIEW_HIDDEN',
        entityType: 'Review',
        entityId: id,
        before: { isHidden: review.isHidden },
        after: { isHidden: true },
        reason,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return r;
    });

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
};

export const restoreReview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { reason } = req.body;

    const review = await prisma.review.findUnique({ where: { id } });
    if (!review) {
      sendError(res, 'REVIEW_NOT_FOUND', 'Review not found', 404);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const r = await tx.review.update({
        where: { id },
        data: { isHidden: false },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'REVIEW_RESTORED',
        entityType: 'Review',
        entityId: id,
        before: { isHidden: review.isHidden },
        after: { isHidden: false },
        reason: reason || 'Restored by Super Admin',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return r;
    });

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
};

export const deleteReview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { reason } = req.body;

    const review = await prisma.review.findUnique({ where: { id } });
    if (!review) {
      sendError(res, 'REVIEW_NOT_FOUND', 'Review not found', 404);
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.review.delete({ where: { id } });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'REVIEW_DELETED',
        entityType: 'Review',
        entityId: id,
        before: { rating: review.rating, comment: review.comment },
        reason: reason || 'Deleted as spam/abuse by Super Admin',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });
    });

    sendSuccess(res, { message: 'Review successfully removed' });
  } catch (error) {
    next(error);
  }
};

export const getEmployeeFeedback = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const feedback = await prisma.employeeFeedback.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        employee: {
          include: {
            user: { select: { name: true } },
            vendor: { select: { companyName: true } },
          },
        },
        user: { select: { name: true, email: true } },
      },
    });

    sendSuccess(res, feedback);
  } catch (error) {
    next(error);
  }
};
