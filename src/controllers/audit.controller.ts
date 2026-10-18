import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendError, sendSuccess } from '../utils/response';

export const listAuditLogsQuerySchema = z.object({
  query: z.object({
    page: z.string().optional().default('1').transform((v) => Math.max(1, parseInt(v, 10))),
    limit: z.string().optional().default('20').transform((v) => Math.min(100, Math.max(1, parseInt(v, 10)))),
    action: z.string().optional(),
    entityType: z.string().optional(),
    entityId: z.string().optional(),
    search: z.string().optional(),
    sortBy: z.enum(['createdAt']).optional().default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
  }),
});

export const getAuditLogs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, limit, action, entityType, entityId, search, sortBy, sortOrder } = req.query as any;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (action) {
      where.action = action;
    }
    if (entityType) {
      where.entityType = entityType;
    }
    if (entityId) {
      where.entityId = entityId;
    }

    if (search) {
      where.OR = [
        { action: { contains: search, mode: 'insensitive' } },
        { entityType: { contains: search, mode: 'insensitive' } },
        { reason: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          superAdmin: {
            select: { id: true, name: true, email: true },
          },
        },
      }),
    ]);

    sendSuccess(res, logs, 200, {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    next(error);
  }
};

export const getAuditLogById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;

    const log = await prisma.auditLog.findUnique({
      where: { id },
      include: {
        superAdmin: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    if (!log) {
      sendError(res, 'AUDIT_LOG_NOT_FOUND', 'Audit record not found', 404);
      return;
    }

    sendSuccess(res, log);
  } catch (error) {
    next(error);
  }
};
