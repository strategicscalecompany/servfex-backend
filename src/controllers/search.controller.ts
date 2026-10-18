import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendSuccess } from '../utils/response';

export const globalSearchSchema = z.object({
  query: z.object({
    q: z.string().min(2, 'Search term must be at least 2 characters'),
  }),
});

export const globalSearch = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const q = (req.query.q as string).trim();

    // Parallel Server-Side Global Queries
    const [customers, vendors, employees, bookings, services, payments] = await Promise.all([
      // Customers
      prisma.user.findMany({
        where: {
          role: 'CUSTOMER',
          deletedAt: null,
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            { phone: { contains: q } },
          ],
        },
        take: 5,
        select: { id: true, name: true, email: true, phone: true, status: true },
      }),

      // Vendors
      prisma.vendorProfile.findMany({
        where: {
          OR: [
            { companyName: { contains: q, mode: 'insensitive' } },
            { location: { contains: q, mode: 'insensitive' } },
            { user: { name: { contains: q, mode: 'insensitive' } } },
            { user: { email: { contains: q, mode: 'insensitive' } } },
          ],
        },
        take: 5,
        select: {
          id: true,
          companyName: true,
          location: true,
          kycStatus: true,
          isActive: true,
          user: { select: { name: true, email: true, phone: true } },
        },
      }),

      // Employees
      prisma.employeeProfile.findMany({
        where: {
          OR: [
            { specialization: { contains: q, mode: 'insensitive' } },
            { phone: { contains: q } },
            { user: { name: { contains: q, mode: 'insensitive' } } },
          ],
        },
        take: 5,
        select: {
          id: true,
          specialization: true,
          phone: true,
          isAvailable: true,
          user: { select: { name: true, email: true } },
          vendor: { select: { companyName: true } },
        },
      }),

      // Bookings
      prisma.booking.findMany({
        where: {
          OR: [
            { bookingNumber: { contains: q, mode: 'insensitive' } },
            { customer: { user: { name: { contains: q, mode: 'insensitive' } } } },
          ],
        },
        take: 5,
        select: {
          id: true,
          bookingNumber: true,
          status: true,
          totalAmount: true,
          scheduledDate: true,
          service: { select: { name: true } },
        },
      }),

      // Services
      prisma.service.findMany({
        where: {
          deletedAt: null,
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { slug: { contains: q, mode: 'insensitive' } },
          ],
        },
        take: 5,
        select: { id: true, name: true, startingPrice: true, category: { select: { name: true } } },
      }),

      // Payments
      prisma.payment.findMany({
        where: {
          OR: [{ transactionRef: { contains: q, mode: 'insensitive' } }],
        },
        take: 5,
        select: { id: true, transactionRef: true, amount: true, status: true, method: true },
      }),
    ]);

    sendSuccess(res, {
      query: q,
      results: {
        customers,
        vendors,
        employees,
        bookings,
        services,
        payments,
      },
    });
  } catch (error) {
    next(error);
  }
};
