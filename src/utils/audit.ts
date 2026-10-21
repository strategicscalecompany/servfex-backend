import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';

export interface CreateAuditLogParams {
  superAdminId: string;
  action: string;
  entityType: string;
  entityId: string | any;
  before?: Record<string, any> | null;
  after?: Record<string, any> | null;
  changes?: Record<string, any> | null;
  reason?: string;
  ipAddress?: string | string[] | any;
  userAgent?: string | string[] | any;
  tx?: Prisma.TransactionClient;
}

export const logAuditEvent = async (params: CreateAuditLogParams) => {
  const db = params.tx || prisma;
  try {
    const formattedUserAgent = Array.isArray(params.userAgent)
      ? params.userAgent.join(', ')
      : params.userAgent || null;

    const formattedIp = Array.isArray(params.ipAddress)
      ? params.ipAddress.join(', ')
      : params.ipAddress || null;

    return await db.auditLog.create({
      data: {
        superAdminId: params.superAdminId,
        action: params.action,
        entityType: params.entityType,
        entityId: String(params.entityId),
        before: params.before ? (params.before as Prisma.InputJsonValue) : undefined,
        after: params.after ? (params.after as Prisma.InputJsonValue) : undefined,
        changes: params.changes ? (params.changes as Prisma.InputJsonValue) : undefined,
        reason: params.reason || null,
        ipAddress: formattedIp,
        userAgent: formattedUserAgent,
      },
    });
  } catch (error) {
    console.error('Failed to create audit log:', error);
    return null;
  }
};
