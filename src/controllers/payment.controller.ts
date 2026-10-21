import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendError, sendSuccess } from '../utils/response';
import { logAuditEvent } from '../utils/audit';
import { Prisma } from '@prisma/client';
import { asDecimal, sumMoney, toMoney } from '../utils/money';

export const listPaymentsQuerySchema = z.object({
  query: z.object({
    page: z.string().optional().default('1').transform((v) => Math.max(1, parseInt(v, 10))),
    limit: z.string().optional().default('20').transform((v) => Math.min(100, Math.max(1, parseInt(v, 10)))),
    status: z.enum(['PENDING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED']).optional(),
    method: z.enum(['ONLINE', 'CASH', 'UPI', 'CARD', 'WALLET']).optional(),
    search: z.string().optional(),
    sortBy: z.enum(['createdAt', 'amount']).optional().default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
  }),
});

export const refundSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    amount: z.number().min(0.01, 'Refund amount must be greater than zero'),
    reason: z.string().min(3, 'A reason is required for processing refund'),
  }),
});

export const getPayments = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, limit, status, method, search, sortBy, sortOrder } = req.query as any;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (status) {
      where.status = status;
    }
    if (method) {
      where.method = method;
    }

    if (search) {
      where.OR = [
        { transactionRef: { contains: search, mode: 'insensitive' } },
        { booking: { bookingNumber: { contains: search, mode: 'insensitive' } } },
        { booking: { customer: { user: { name: { contains: search, mode: 'insensitive' } } } } },
      ];
    }

    const [total, payments] = await Promise.all([
      prisma.payment.count({ where }),
      prisma.payment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          booking: {
            select: {
              id: true,
              bookingNumber: true,
              totalAmount: true,
              customer: {
                include: { user: { select: { name: true, phone: true } } },
              },
              service: { select: { name: true } },
            },
          },
          refunds: true,
        },
      }),
    ]);

    sendSuccess(res, payments, 200, {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    next(error);
  }
};

export const getPaymentById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;

    const payment = await prisma.payment.findUnique({
      where: { id },
      include: {
        booking: {
          include: {
            customer: { include: { user: true } },
            vendor: true,
            service: true,
          },
        },
        refunds: true,
      },
    });

    if (!payment) {
      sendError(res, 'PAYMENT_NOT_FOUND', 'Payment record not found', 404);
      return;
    }

    sendSuccess(res, payment);
  } catch (error) {
    next(error);
  }
};

export const processRefund = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const paymentId = req.params.id as string;
    const { amount, reason } = req.body;
    const idempotencyKey = (req.headers['idempotency-key'] as string) || null;

    // Check idempotency if key was provided
    if (idempotencyKey) {
      const existingRefund = await prisma.refund.findUnique({
        where: { idempotencyKey },
      });
      if (existingRefund) {
        sendSuccess(res, existingRefund, 200);
        return;
      }
    }

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { refunds: true },
    });

    if (!payment) {
      sendError(res, 'PAYMENT_NOT_FOUND', 'Payment not found', 404);
      return;
    }

    if (payment.status !== 'PAID' && payment.status !== 'PARTIALLY_REFUNDED') {
      sendError(res, 'INVALID_PAYMENT_STATUS', `Cannot refund a payment with status ${payment.status}`, 400);
      return;
    }

    const refundDecimal = asDecimal(amount);
    const existingRefundTotal = sumMoney(payment.refunds.map((r) => r.amount));
    const maxRefundable = asDecimal(payment.amount).minus(existingRefundTotal);

    if (refundDecimal.greaterThan(maxRefundable)) {
      sendError(
        res,
        'EXCEEDS_REFUNDABLE_AMOUNT',
        `Maximum refundable amount is ${maxRefundable.toString()} INR`,
        400
      );
      return;
    }

    const isFullRefund = refundDecimal.equals(maxRefundable);
    const newPaymentStatus = isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED';

    const result = await prisma.$transaction(async (tx) => {
      // 1. Create Refund Record
      const refund = await tx.refund.create({
        data: {
          paymentId,
          bookingId: payment.bookingId,
          amount: toMoney(refundDecimal),
          reason,
          status: 'COMPLETED',
          processedBy: req.user!.userId,
          idempotencyKey,
        },
      });

      // 2. Update Payment Record Status
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: newPaymentStatus,
        },
      });

      // 3. Update Booking Payment Status (Derived Summary)
      await tx.booking.update({
        where: { id: payment.bookingId },
        data: {
          paymentStatus: newPaymentStatus,
        },
      });

      // 4. Audit Log
      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'REFUND_PROCESSED',
        entityType: 'Refund',
        entityId: refund.id,
        after: {
          paymentId,
          amount: Number(refundDecimal),
          newPaymentStatus,
          reason,
        },
        reason,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return refund;
    });

    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
};

export const getFinancialReconciliation = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const [paidPayments, completedRefunds] = await Promise.all([
      prisma.payment.findMany({
        where: { status: 'PAID' },
        select: { amount: true, method: true },
      }),
      prisma.refund.findMany({
        where: { status: 'COMPLETED' },
        select: { amount: true },
      }),
    ]);

    const gross = Number(sumMoney(paidPayments.map((p) => p.amount)));
    const refunds = Number(sumMoney(completedRefunds.map((r) => r.amount)));
    const net = asDecimal(gross).minus(asDecimal(refunds));

    const methodTotals = new Map<string, { total: Prisma.Decimal; count: number }>();
    for (const payment of paidPayments) {
      const current = methodTotals.get(payment.method) || { total: asDecimal(0), count: 0 };
      current.total = current.total.plus(asDecimal(payment.amount));
      current.count += 1;
      methodTotals.set(payment.method, current);
    }

    sendSuccess(res, {
      grossVolume: gross,
      totalRefunds: refunds,
      netVolume: Number(net),
      currency: 'INR',
      methodsBreakdown: Array.from(methodTotals.entries()).map(([method, data]) => ({
        method,
        total: Number(data.total),
        count: data.count,
      })),
    });
  } catch (error) {
    next(error);
  }
};
