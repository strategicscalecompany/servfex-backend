import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendError, sendSuccess } from '../utils/response';
import { hashPassword } from '../utils/password';
import { logAuditEvent } from '../utils/audit';
import { sendExpertWelcomeEmail, sendManagerWelcomeEmail } from '../services/email.service';
import { getFirebaseAuth } from '../config/firebase';
import { asDecimal, sumMoney, toMoney } from '../utils/money';

export const listEmployeesQuerySchema = z.object({
  query: z.object({
    page: z.string().optional().default('1').transform((v) => Math.max(1, parseInt(v, 10))),
    limit: z.string().optional().default('20').transform((v) => Math.min(100, Math.max(1, parseInt(v, 10)))),
    vendorId: z.string().optional(),
    isAvailable: z.string().optional().transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
    search: z.string().optional(),
    sortBy: z.enum(['createdAt', 'rating', 'completedJobs']).optional().default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
  }),
});

export const createEmployeeSchema = z.object({
  body: z.object({
    name: z.string().min(2),
    email: z.string().email(),
    phone: z.string().min(10),
    password: z.string().min(6),
    vendorId: z.string().uuid(),
    specialization: z.string().min(2),
    expertKind: z.enum(['SALES_MANAGER', 'SERVICE_PROFESSIONAL']).optional(),
  }),
});

export const assignVendorSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    vendorId: z.string().uuid(),
    reason: z.string().optional(),
  }),
});

export const getEmployees = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, limit, vendorId, isAvailable, search, sortBy, sortOrder } = req.query as any;
    const skip = (page - 1) * limit;

    const where: any = {
      user: {
        role: 'EMPLOYEE',
        deletedAt: null,
      },
    };

    if (vendorId) {
      where.vendorId = vendorId;
    }

    if (isAvailable !== undefined) {
      where.isAvailable = isAvailable;
    }

    if (search) {
      where.OR = [
        { specialization: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
        { user: { name: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [total, employees] = await Promise.all([
      prisma.employeeProfile.count({ where }),
      prisma.employeeProfile.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              status: true,
              profilePhotoUrl: true,
            },
          },
          vendor: {
            select: {
              id: true,
              companyName: true,
            },
          },
          _count: {
            select: { bookings: true },
          },
        },
      }),
    ]);

    sendSuccess(res, employees, 200, {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    next(error);
  }
};

export const getEmployeeById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;

    const employee = await prisma.employeeProfile.findFirst({
      where: { id, user: { deletedAt: null } },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            status: true,
            profilePhotoUrl: true,
            createdAt: true,
          },
        },
        vendor: {
          select: { id: true, companyName: true },
        },
        bookings: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: {
            service: { select: { name: true } },
            customer: { include: { user: { select: { name: true } } } },
          },
        },
        reviews: {
          take: 5,
          orderBy: { createdAt: 'desc' },
        },
        feedback: {
          take: 5,
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!employee) {
      sendError(res, 'EMPLOYEE_NOT_FOUND', 'Employee not found', 404);
      return;
    }

    sendSuccess(res, employee);
  } catch (error) {
    next(error);
  }
};

export const createEmployee = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, email, phone, password, vendorId, specialization, expertKind } = req.body;

    const vendor = await prisma.vendorProfile.findUnique({
      where: { id: vendorId },
    });

    if (!vendor) {
      sendError(res, 'VENDOR_NOT_FOUND', 'Specified vendor does not exist', 404);
      return;
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ email: email.toLowerCase() }, { phone }],
        deletedAt: null,
      },
    });

    if (existingUser) {
      sendError(res, 'USER_EXISTS', 'A user with this email or phone already exists', 409);
      return;
    }

    const passwordHash = await hashPassword(password);

    const newEmployee = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name,
          email: email.toLowerCase(),
          phone,
          passwordHash,
          role: 'EMPLOYEE',
          status: 'ACTIVE',
          isVerified: true,
          employeeProfile: {
            create: {
              vendorId,
              specialization,
              expertKind: expertKind === 'SALES_MANAGER' ? 'SALES_MANAGER' : 'SERVICE_PROFESSIONAL',
              phone,
              isAvailable: true,
            },
          },
        },
        include: { employeeProfile: true },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'EMPLOYEE_CREATED',
        entityType: 'EmployeeProfile',
        entityId: user.employeeProfile!.id,
        after: { name, email, vendorId, specialization },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return user.employeeProfile;
    });

    // Send ServFex Expert Welcome Email with Provider details & credentials
    sendExpertWelcomeEmail({
      toEmail: email.toLowerCase().trim(),
      name,
      providerName: vendor.companyName,
      providerCompany: vendor.companyName,
      location: vendor.location,
      specialization,
      phone,
      password,
    }).catch((emailErr) => {
      console.warn('[Expert] Notice sending expert welcome email:', emailErr?.message || emailErr);
    });

    sendSuccess(res, newEmployee, 201);
  } catch (error) {
    next(error);
  }
};

export const assignVendor = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { vendorId, reason } = req.body;

    const employee = await prisma.employeeProfile.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!employee) {
      sendError(res, 'EMPLOYEE_NOT_FOUND', 'Employee not found', 404);
      return;
    }

    const vendor = await prisma.vendorProfile.findUnique({
      where: { id: vendorId },
    });

    if (!vendor) {
      sendError(res, 'VENDOR_NOT_FOUND', 'Target vendor not found', 404);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const emp = await tx.employeeProfile.update({
        where: { id },
        data: { vendorId },
        include: { vendor: { select: { companyName: true } } },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'EMPLOYEE_ASSIGNED_TO_VENDOR',
        entityType: 'EmployeeProfile',
        entityId: id,
        before: { vendorId: employee.vendorId },
        after: { vendorId },
        reason: reason || 'Assigned by Super Admin',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return emp;
    });

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
};

export const toggleEmployeeStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { isAvailable, status, reason } = req.body;

    const employee = await prisma.employeeProfile.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!employee) {
      sendError(res, 'EMPLOYEE_NOT_FOUND', 'Employee not found', 404);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const emp = await tx.employeeProfile.update({
        where: { id },
        data: {
          ...(isAvailable !== undefined ? { isAvailable } : {}),
        },
      });

      if (status) {
        await tx.user.update({
          where: { id: employee.userId },
          data: { status },
        });
      }

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'EMPLOYEE_STATUS_TOGGLED',
        entityType: 'EmployeeProfile',
        entityId: id,
        before: { isAvailable: employee.isAvailable, status: employee.user?.status || 'ACTIVE' },
        after: { isAvailable: emp.isAvailable, status: status || employee.user?.status || 'ACTIVE' },
        reason: reason || 'Status updated by Super Admin',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return emp;
    });

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
};

export const deleteEmployee = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;
    const employee = await prisma.employeeProfile.findFirst({
      where: {
        OR: [{ id }, { userId: id }],
      },
      include: {
        user: true,
        bookings: {
          where: {
            status: { in: ['ASSIGNED', 'IN_PROGRESS', 'ACCEPTED'] as any },
          },
        },
      },
    });

    if (!employee) {
      sendError(res, 'EMPLOYEE_NOT_FOUND', 'Employee not found', 404);
      return;
    }

    if (employee.bookings.length > 0) {
      sendError(
        res,
        'BAD_REQUEST',
        `Cannot delete expert while they have ${employee.bookings.length} active order(s). Please complete or reassign active orders first.`,
        400
      );
      return;
    }

    if (employee.user.firebaseUid) {
      try {
        await getFirebaseAuth().deleteUser(employee.user.firebaseUid);
      } catch (fbErr: any) {
        console.warn('[Admin Delete Expert] Notice deleting firebase user:', fbErr?.message || fbErr);
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.booking.updateMany({
        where: { employeeId: employee.id },
        data: { employeeId: null },
      });

      await tx.employeeProfile.delete({
        where: { id: employee.id },
      });

      await tx.user.delete({
        where: { id: employee.userId },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'EMPLOYEE_DELETED',
        entityType: 'EmployeeProfile',
        entityId: employee.id,
        before: { id: employee.id, userId: employee.userId, name: employee.user.name },
        reason: 'Employee deleted by Super Admin',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });
    });

    sendSuccess(res, { message: 'Employee deleted successfully' });
  } catch (error) {
    next(error);
  }
};

// ==========================================
// MANAGERIAL APPOINTMENTS & OVERSIGHT
// ==========================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Resolve assigned hub vendor IDs from explicit ids, primary vendorId, and zone CSV (names or UUIDs). */
async function resolveManagerHubAssignment(input: {
  hubIds?: string[] | null;
  vendorId?: string | null;
  zone?: string | null;
}): Promise<{ hubIds: string[]; primaryVendorId: string | null; zoneLabel: string }> {
  const vendors = await prisma.vendorProfile.findMany({
    select: { id: true, companyName: true, warehouseName: true },
  });
  const vendorById = new Map(vendors.map((v) => [v.id, v]));
  const vendorIdByHubName = new Map<string, string>();
  for (const v of vendors) {
    if (v.warehouseName) vendorIdByHubName.set(v.warehouseName.trim().toLowerCase(), v.id);
    if (v.companyName) vendorIdByHubName.set(v.companyName.trim().toLowerCase(), v.id);
  }

  const ids = new Set<string>();
  for (const id of input.hubIds || []) {
    if (vendorById.has(id)) ids.add(id);
  }
  if (input.vendorId && vendorById.has(input.vendorId)) ids.add(input.vendorId);

  for (const part of String(input.zone || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    if (UUID_RE.test(part) && vendorById.has(part)) {
      ids.add(part);
      continue;
    }
    const byName = vendorIdByHubName.get(part.toLowerCase());
    if (byName) ids.add(byName);
  }

  const hubIds = [...ids];
  const primaryVendorId = hubIds[0] || null;
  const zoneLabel =
    hubIds.length > 0
      ? hubIds
          .map((id) => {
            const v = vendorById.get(id);
            return v?.warehouseName || v?.companyName || id;
          })
          .join(', ')
      : String(input.zone || 'Central Territory Zone').trim() || 'Central Territory Zone';

  return { hubIds, primaryVendorId, zoneLabel };
}

export const createManagerSchema = z.object({
  body: z.object({
    name: z.string().min(2, 'Full name is required'),
    email: z.string().email('Valid work email is required'),
    phone: z.string().min(10, 'Valid phone number is required'),
    password: z.string().min(6).optional(),
    zone: z.string().optional().default('Central Territory Zone'),
    city: z.string().optional().default('Hyderabad'),
    shiftHours: z.string().optional().default('09:00 AM - 06:00 PM'),
    kind: z.enum(['OPERATIONS', 'BUSINESS_DEVELOPMENT']).optional().default('OPERATIONS'),
    vendorId: z.string().uuid().optional().nullable(),
    hubIds: z.array(z.string().uuid()).optional(),
  }),
});

export const updateManagerHubsSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    hubIds: z.array(z.string().uuid()).min(1, 'Assign at least one partner hub'),
    city: z.string().optional(),
  }),
});

export const createManager = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, email, phone, password, zone, city, shiftHours, kind, vendorId, hubIds } = req.body;
    const cleanEmail = email.toLowerCase().trim();
    const assignedPassword = password || `Manager@${Math.floor(1000 + Math.random() * 9000)}`;
    const managerKind = kind === 'BUSINESS_DEVELOPMENT' ? 'BUSINESS_DEVELOPMENT' : 'OPERATIONS';

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ email: cleanEmail }, { phone }],
        deletedAt: null,
      },
    });

    if (existingUser) {
      sendError(res, 'USER_EXISTS', 'A manager or administrator with this email or phone already exists', 409);
      return;
    }

    const assignment = await resolveManagerHubAssignment({ hubIds, vendorId, zone });
    if (managerKind === 'OPERATIONS' && assignment.hubIds.length === 0) {
      sendError(res, 'VALIDATION_ERROR', 'Assign at least one partner hub to this House of Masters manager', 400);
      return;
    }

    const passwordHash = await hashPassword(assignedPassword);

    let firebaseUid: string | null = null;
    try {
      const fbUser = await getFirebaseAuth().createUser({
        email: cleanEmail,
        password: assignedPassword,
        displayName: name,
      });
      firebaseUid = fbUser.uid;
    } catch (fbErr: any) {
      if (fbErr.code === 'auth/email-already-exists') {
        const existingFb = await getFirebaseAuth().getUserByEmail(cleanEmail);
        firebaseUid = existingFb.uid;
        await getFirebaseAuth().updateUser(firebaseUid, { password: assignedPassword });
      }
    }

    const resolvedZone = assignment.zoneLabel;
    const resolvedVendorId = assignment.primaryVendorId;

    const newManager = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name,
          email: cleanEmail,
          phone,
          passwordHash,
          firebaseUid,
          role: 'OPERATIONS_MANAGER',
          status: 'ACTIVE',
          isVerified: true,
          managerProfile: {
            create: {
              kind: managerKind,
              zone: resolvedZone,
              city,
              shiftHours,
              vendorId: resolvedVendorId,
            },
          },
        },
        include: { managerProfile: { include: { vendor: true } } },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'MANAGER_APPOINTED',
        entityType: 'User',
        entityId: user.id,
        after: {
          name,
          email: cleanEmail,
          phone,
          zone: resolvedZone,
          city,
          shiftHours,
          kind: managerKind,
          vendorId: resolvedVendorId,
          hubIds: assignment.hubIds,
        },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return user;
    });

    // Send ServFex Manager Welcome Email with territory oversight details & credentials
    sendManagerWelcomeEmail({
      toEmail: cleanEmail,
      name,
      zone: resolvedZone,
      city,
      phone,
      shiftHours,
      password: assignedPassword,
    }).catch((emailErr) => {
      console.warn('[Manager] Notice sending manager welcome email:', emailErr?.message || emailErr);
    });

    sendSuccess(res, newManager, 201);
  } catch (error) {
    next(error);
  }
};

export const updateManagerHubs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = String(req.params.id);
    const { hubIds, city } = req.body as { hubIds: string[]; city?: string };

    const manager = await prisma.user.findFirst({
      where: { id, role: 'OPERATIONS_MANAGER', deletedAt: null },
      include: { managerProfile: true },
    });
    if (!manager || !manager.managerProfile) {
      sendError(res, 'NOT_FOUND', 'House of Masters manager not found', 404);
      return;
    }
    const managerProfile = manager.managerProfile;

    const assignment = await resolveManagerHubAssignment({ hubIds, zone: '' });
    if (assignment.hubIds.length === 0) {
      sendError(res, 'VALIDATION_ERROR', 'Assign at least one valid partner hub', 400);
      return;
    }

    const before = {
      zone: managerProfile.zone,
      vendorId: managerProfile.vendorId,
      city: managerProfile.city,
    };

    const updated = await prisma.$transaction(async (tx) => {
      const profile = await tx.managerProfile.update({
        where: { id: managerProfile.id },
        data: {
          zone: assignment.zoneLabel,
          vendorId: assignment.primaryVendorId,
          ...(city ? { city } : {}),
        },
        include: { vendor: true },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'MANAGER_HUBS_UPDATED',
        entityType: 'ManagerProfile',
        entityId: profile.id,
        before,
        after: {
          zone: profile.zone,
          vendorId: profile.vendorId,
          city: profile.city,
          hubIds: assignment.hubIds,
        },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return profile;
    });

    sendSuccess(res, {
      id: manager.id,
      managerProfile: updated,
      assignedHubIds: assignment.hubIds,
      assignedHubs: assignment.zoneLabel.split(',').map((s) => s.trim()).filter(Boolean),
    });
  } catch (error) {
    next(error);
  }
};

export const getManagers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    const managers = await prisma.user.findMany({
      where: {
        role: 'OPERATIONS_MANAGER',
        deletedAt: null,
        ...(kind === 'OPERATIONS' || kind === 'BUSINESS_DEVELOPMENT'
          ? { managerProfile: { kind } }
          : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        profilePhotoUrl: true,
        createdAt: true,
        managerProfile: {
          include: {
            vendor: {
              select: {
                id: true,
                companyName: true,
                warehouseName: true,
                warehousePhone: true,
                location: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const vendors = await prisma.vendorProfile.findMany({
      select: {
        id: true,
        companyName: true,
        warehouseName: true,
        _count: { select: { employees: true } },
      },
    });

    const vendorById = new Map(vendors.map((v) => [v.id, v]));
    const vendorIdByHubName = new Map<string, string>();
    for (const v of vendors) {
      if (v.warehouseName) vendorIdByHubName.set(v.warehouseName.trim().toLowerCase(), v.id);
      if (v.companyName) vendorIdByHubName.set(v.companyName.trim().toLowerCase(), v.id);
    }

    const resolveHubVendorIds = (mgr: (typeof managers)[number]): string[] => {
      const ids = new Set<string>();
      if (mgr.managerProfile?.vendorId) ids.add(mgr.managerProfile.vendorId);
      if (mgr.managerProfile?.vendor?.id) ids.add(mgr.managerProfile.vendor.id);
      const zone = mgr.managerProfile?.zone || '';
      for (const part of zone.split(',').map((p) => p.trim()).filter(Boolean)) {
        if (UUID_RE.test(part) && vendorById.has(part)) {
          ids.add(part);
          continue;
        }
        const match = vendorIdByHubName.get(part.toLowerCase());
        if (match) ids.add(match);
      }
      return [...ids];
    };

    const allHubIds = Array.from(
      new Set(managers.flatMap((mgr) => resolveHubVendorIds(mgr)))
    );

    const since = new Date();
    since.setDate(since.getDate() - 30);

    const [bookings, escalations] = await Promise.all([
      allHubIds.length
        ? prisma.booking.findMany({
            where: {
              vendorId: { in: allHubIds },
              createdAt: { gte: since },
            },
            select: {
              vendorId: true,
              status: true,
              totalAmount: true,
              paymentStatus: true,
            },
          })
        : Promise.resolve([]),
      allHubIds.length
        ? prisma.escalationTicket.findMany({
            where: {
              createdAt: { gte: since },
              booking: { vendorId: { in: allHubIds } },
            },
            select: {
              status: true,
              booking: { select: { vendorId: true } },
            },
          })
        : Promise.resolve([]),
    ]);

    const enriched = managers.map((mgr) => {
      const hubIds = resolveHubVendorIds(mgr);
      const hubSet = new Set(hubIds);

      let techniciansCount = 0;
      for (const id of hubIds) {
        techniciansCount += vendorById.get(id)?._count.employees || 0;
      }

      const hubBookings = bookings.filter((b) => b.vendorId && hubSet.has(b.vendorId));
      const thirtyDaysJobs = hubBookings.length;
      const completedOrPaid = hubBookings.filter(
        (b) => b.status === 'COMPLETED' || b.paymentStatus === 'PAID'
      );
      const earnings = sumMoney(completedOrPaid.map((b) => b.totalAmount));

      const hubEscalations = escalations.filter(
        (e) => e.booking?.vendorId && hubSet.has(e.booking.vendorId)
      );
      const complaintsCount = hubEscalations.length;
      const unresolvedComplaints = hubEscalations.filter((e) =>
        ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'].includes(e.status)
      ).length;
      const resolved = Math.max(0, complaintsCount - unresolvedComplaints);
      const slaRate =
        complaintsCount === 0
          ? 100
          : Number(asDecimal(resolved).div(complaintsCount).times(100).toFixed(1));

      const assignedHubs = hubIds.map((id) => {
        const v = vendorById.get(id);
        return v?.warehouseName || v?.companyName || id;
      });

      return {
        ...mgr,
        assignedHubs,
        assignedHubIds: hubIds,
        metrics: {
          thirtyDaysEarnings: toMoney(earnings),
          thirtyDaysJobs,
          techniciansCount,
          complaintsCount,
          unresolvedComplaints,
          slaRate,
        },
      };
    });

    sendSuccess(res, { managers: enriched });
  } catch (error) {
    next(error);
  }
};

