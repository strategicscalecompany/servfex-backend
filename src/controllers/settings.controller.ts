import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendSuccess } from '../utils/response';
import { logAuditEvent } from '../utils/audit';

export const platformSettingsSchema = z.object({
  body: z.object({
    platformName: z.string().min(2).optional(),
    supportEmail: z.string().email().optional(),
    supportPhone: z.string().min(10).optional(),
    currency: z.string().min(3).max(3).optional(),
    timezone: z.string().optional(),
    maintenanceMode: z.boolean().optional(),
    customerRegistrationEnabled: z.boolean().optional(),
    vendorRegistrationEnabled: z.boolean().optional(),
    reason: z.string().optional(),
  }),
});

export const bookingSettingsSchema = z.object({
  body: z.object({
    cancellationWindowHours: z.number().int().min(0).max(72).optional(),
    rescheduleLimitPerBooking: z.number().int().min(0).max(10).optional(),
    slotIntervalMinutes: z.number().int().min(15).max(240).optional(),
    autoAssignEnabled: z.boolean().optional(),
    maxAdvanceBookingDays: z.number().int().min(1).max(90).optional(),
    reason: z.string().optional(),
  }),
});

export const pricingSettingsSchema = z.object({
  body: z.object({
    platformCommissionPercent: z.number().min(0).max(50).optional(),
    baseTaxPercent: z.number().min(0).max(30).optional(),
    minimumBookingFee: z.number().min(0).optional(),
    cancellationFee: z.number().min(0).optional(),
    extraChargesAllowed: z.boolean().optional(),
    reason: z.string().optional(),
  }),
});

export const appConfigSchema = z.object({
  body: z.object({
    customer: z
      .object({
        minimumVersion: z.string(),
        latestVersion: z.string(),
        forceUpdate: z.boolean(),
        maintenanceMode: z.boolean().optional(),
      })
      .optional(),
    vendor: z
      .object({
        minimumVersion: z.string(),
        latestVersion: z.string(),
        forceUpdate: z.boolean(),
        maintenanceMode: z.boolean().optional(),
      })
      .optional(),
    reason: z.string().optional(),
  }),
});

// Default Fallbacks
const DEFAULT_PLATFORM = {
  platformName: 'ServFex',
  supportEmail: 'support@servfex.com',
  supportPhone: '+91 98765 43210',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  maintenanceMode: false,
  customerRegistrationEnabled: true,
  vendorRegistrationEnabled: true,
};

const DEFAULT_BOOKING = {
  cancellationWindowHours: 4,
  rescheduleLimitPerBooking: 2,
  slotIntervalMinutes: 60,
  autoAssignEnabled: false,
  maxAdvanceBookingDays: 30,
};

const DEFAULT_PRICING = {
  platformCommissionPercent: 0.0,
  baseTaxPercent: 0.0,
  minimumBookingFee: 0.0,
  cancellationFee: 0.0,
  extraChargesAllowed: true,
};

const DEFAULT_APP_CONFIG = {
  customer: {
    minimumVersion: '1.0.0',
    latestVersion: '1.2.0',
    forceUpdate: false,
    maintenanceMode: false,
  },
  vendor: {
    minimumVersion: '1.0.0',
    latestVersion: '1.1.0',
    forceUpdate: false,
    maintenanceMode: false,
  },
};

export const getPlatformSettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const setting = await prisma.platformSetting.findUnique({
      where: { key: 'PLATFORM_GENERAL' },
    });
    sendSuccess(res, setting?.value || DEFAULT_PLATFORM);
  } catch (error) {
    next(error);
  }
};

export const updatePlatformSettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { reason, ...data } = req.body;

    const existing = await prisma.platformSetting.findUnique({
      where: { key: 'PLATFORM_GENERAL' },
    });

    const merged = { ...(existing?.value as any || DEFAULT_PLATFORM), ...data };

    const updated = await prisma.$transaction(async (tx) => {
      const s = await tx.platformSetting.upsert({
        where: { key: 'PLATFORM_GENERAL' },
        create: {
          key: 'PLATFORM_GENERAL',
          value: merged,
          description: 'General platform configuration',
        },
        update: {
          value: merged,
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'PLATFORM_SETTINGS_UPDATED',
        entityType: 'PlatformSetting',
        entityId: 'PLATFORM_GENERAL',
        before: existing?.value as any,
        after: merged,
        reason,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return s;
    });

    sendSuccess(res, updated.value);
  } catch (error) {
    next(error);
  }
};

export const getBookingSettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const setting = await prisma.platformSetting.findUnique({
      where: { key: 'BOOKING_RULES' },
    });
    sendSuccess(res, setting?.value || DEFAULT_BOOKING);
  } catch (error) {
    next(error);
  }
};

export const updateBookingSettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { reason, ...data } = req.body;

    const existing = await prisma.platformSetting.findUnique({
      where: { key: 'BOOKING_RULES' },
    });

    const merged = { ...(existing?.value as any || DEFAULT_BOOKING), ...data };

    const updated = await prisma.$transaction(async (tx) => {
      const s = await tx.platformSetting.upsert({
        where: { key: 'BOOKING_RULES' },
        create: {
          key: 'BOOKING_RULES',
          value: merged,
          description: 'Booking operational rules',
        },
        update: {
          value: merged,
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'BOOKING_SETTINGS_UPDATED',
        entityType: 'PlatformSetting',
        entityId: 'BOOKING_RULES',
        before: existing?.value as any,
        after: merged,
        reason,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return s;
    });

    sendSuccess(res, updated.value);
  } catch (error) {
    next(error);
  }
};

export const getPricingSettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const setting = await prisma.platformSetting.findUnique({
      where: { key: 'PRICING_RULES' },
    });
    sendSuccess(res, setting?.value || DEFAULT_PRICING);
  } catch (error) {
    next(error);
  }
};

export const updatePricingSettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { reason, ...data } = req.body;

    const existing = await prisma.platformSetting.findUnique({
      where: { key: 'PRICING_RULES' },
    });

    const merged = { ...(existing?.value as any || DEFAULT_PRICING), ...data };

    const updated = await prisma.$transaction(async (tx) => {
      const s = await tx.platformSetting.upsert({
        where: { key: 'PRICING_RULES' },
        create: {
          key: 'PRICING_RULES',
          value: merged,
          description: 'Pricing and commission rules',
        },
        update: {
          value: merged,
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'PRICING_SETTINGS_UPDATED',
        entityType: 'PlatformSetting',
        entityId: 'PRICING_RULES',
        before: existing?.value as any,
        after: merged,
        reason,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return s;
    });

    sendSuccess(res, updated.value);
  } catch (error) {
    next(error);
  }
};

export const getAppConfiguration = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const setting = await prisma.appConfiguration.findUnique({
      where: { key: 'MOBILE_APPS' },
    });
    sendSuccess(res, setting?.value || DEFAULT_APP_CONFIG);
  } catch (error) {
    next(error);
  }
};

export const updateAppConfiguration = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { reason, ...data } = req.body;

    const existing = await prisma.appConfiguration.findUnique({
      where: { key: 'MOBILE_APPS' },
    });

    const merged = { ...(existing?.value as any || DEFAULT_APP_CONFIG), ...data };

    const updated = await prisma.$transaction(async (tx) => {
      const s = await tx.appConfiguration.upsert({
        where: { key: 'MOBILE_APPS' },
        create: {
          key: 'MOBILE_APPS',
          value: merged,
          description: 'Android Customer & Vendor App versions and flags',
        },
        update: {
          value: merged,
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'APP_CONFIGURATION_UPDATED',
        entityType: 'AppConfiguration',
        entityId: 'MOBILE_APPS',
        before: existing?.value as any,
        after: merged,
        reason,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return s;
    });

    sendSuccess(res, updated.value);
  } catch (error) {
    next(error);
  }
};
