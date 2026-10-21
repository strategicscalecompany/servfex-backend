import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma';
import { sendSuccess } from '../utils/response';
import { sumMoney } from '../utils/money';

export const getDashboardStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    // Parallel Server-Side Database Aggregations (optimized to prevent connection pool exhaustion)
    const [
      totalCustomers,
      vendorGroups,
      totalEmployees,
      todayBookings,
      bookingStatusGroups,
      paidPayments,
      recentBookings,
      recentVendors,
      recentAuditLogs,
    ] = await Promise.all([
      // Customers count
      prisma.user.count({ where: { role: 'CUSTOMER', deletedAt: null } }),

      // Vendors grouped (covers total, active, and pending KYC in 1 query)
      prisma.vendorProfile.groupBy({
        by: ['isActive', 'kycStatus'],
        _count: { id: true },
      }),

      // Employees count
      prisma.employeeProfile.count(),

      // Bookings counts
      prisma.booking.count({ where: { scheduledDate: todayStr } }),
      prisma.booking.groupBy({
        by: ['status'],
        _count: { id: true },
      }),

      prisma.payment.findMany({
        where: { status: 'PAID' },
        select: { amount: true, createdAt: true },
      }),

      // Recent Bookings
      prisma.booking.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: {
          customer: { include: { user: { select: { name: true, phone: true } } } },
          service: { select: { name: true } },
          vendor: { select: { companyName: true } },
        },
      }),

      // Recent Vendor Applications
      prisma.vendorProfile.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { name: true, email: true, phone: true } },
        },
      }),

      // Recent Audit Actions
      prisma.auditLog.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: {
          superAdmin: { select: { name: true, email: true } },
        },
      }),
    ]);

    // Aggregate vendor metrics
    let totalVendors = 0;
    let activeVendors = 0;
    let pendingKycVendors = 0;
    for (const vg of vendorGroups) {
      totalVendors += vg._count.id;
      if (vg.isActive && vg.kycStatus === 'APPROVED') {
        activeVendors += vg._count.id;
      }
      if (vg.kycStatus === 'PENDING') {
        pendingKycVendors += vg._count.id;
      }
    }

    // Aggregate booking metrics
    let pendingBookings = 0;
    let activeJobs = 0;
    let completedJobs = 0;
    let cancelledJobs = 0;
    const activeStatuses = new Set(['ASSIGNED', 'ON_THE_WAY', 'ARRIVED', 'IN_PROGRESS']);
    for (const bg of bookingStatusGroups) {
      if (bg.status === 'PENDING') pendingBookings += bg._count.id;
      if (activeStatuses.has(bg.status)) activeJobs += bg._count.id;
      if (bg.status === 'COMPLETED') completedJobs += bg._count.id;
      if (bg.status === 'CANCELLED') cancelledJobs += bg._count.id;
    }


    sendSuccess(res, {
      users: {
        totalCustomers,
        totalVendors,
        activeVendors,
        pendingKycVendors,
        totalEmployees,
      },
      bookings: {
        todayBookings,
        pendingBookings,
        activeJobs,
        completedJobs,
        cancelledJobs,
      },
      revenue: {
        totalRevenue: Number(sumMoney(paidPayments.map((p) => p.amount))),
        monthlyRevenue: Number(sumMoney(paidPayments.filter((p) => p.createdAt >= firstDayOfMonth).map((p) => p.amount))),
        todayRevenue: Number(sumMoney(paidPayments.filter((p) => p.createdAt >= today).map((p) => p.amount))),
        currency: 'INR',
      },
      recentBookings,
      recentVendors,
      recentAuditLogs,
    });
  } catch (error) {
    next(error);
  }
};
