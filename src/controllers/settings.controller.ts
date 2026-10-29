import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { sendSuccess } from '../utils/response';
import { logAuditEvent } from '../utils/audit';
import { invalidateCatalogCache } from './catalog.controller';

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

export const homeLayoutSchema = z.object({
  body: z.object({
    slides: z
      .array(
        z.object({
          id: z.string(),
          tag: z.string(),
          headline: z.string(),
          subtext: z.string(),
          accentColor: z.string(),
          bgColor: z.string(),
          isActive: z.boolean(),
          targetCategoryId: z.string().nullable().optional(),
          targetServiceId: z.string().nullable().optional(),
          imageUrl: z.string().nullable().optional(),
        })
      )
      .optional(),
    sections: z
      .array(
        z.object({
          id: z.string(),
          name: z.string().optional(),
          componentName: z.string().optional(),
          description: z.string().optional(),
          enabled: z.boolean(),
        })
      )
      .optional(),
    searchHints: z.array(z.string()).optional(),
    deliveringLocation: z.string().optional(),
    popularTitle: z.string().optional(),
    popularSubtitle: z.string().optional(),
    popularServiceIds: z.array(z.string()).optional(),
    serviceSections: z
      .array(
        z.object({
          id: z.string(),
          title: z.string(),
          subtitle: z.string().optional(),
          serviceIds: z.array(z.string()).optional(),
          enabled: z.boolean().optional(),
        })
      )
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

export const DEFAULT_HOME_LAYOUT = {
  slides: [
    {
      id: 'SLIDE-1',
      tag: 'Limited Offer',
      headline: '25% off on\nyour first booking',
      subtext: 'Book Now →',
      accentColor: '#FFD166',
      bgColor: '#1A1A2E',
      isActive: true,
      targetCategoryId: null,
      targetServiceId: null,
      imageUrl: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?q=80&w=800&auto=format&fit=crop',
    },
    {
      id: 'SLIDE-2',
      tag: 'Home Cleaning',
      headline: 'Sparkling clean\nfrom ₹299',
      subtext: 'Explore →',
      accentColor: '#06D6A0',
      bgColor: '#0F3460',
      isActive: true,
      targetCategoryId: null,
      targetServiceId: null,
      imageUrl: 'https://images.unsplash.com/photo-1581578731548-c64695cc6952?q=80&w=800&auto=format&fit=crop',
    },
    {
      id: 'SLIDE-3',
      tag: 'AC Service',
      headline: 'Expert AC\nrepair & service',
      subtext: 'Book Now →',
      accentColor: '#90E0EF',
      bgColor: '#1B1B2F',
      isActive: true,
      targetCategoryId: null,
      targetServiceId: null,
      imageUrl: 'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?q=80&w=800&auto=format&fit=crop',
    },
  ],
  sections: [
    { id: 'SEC-HERO', name: 'Hero Header & GPS Bar', componentName: 'HeroHeader.kt', description: 'Dark gradient hero (#0F0F1A → #1C1C2E) with doorstep GPS status and refresh button', enabled: true },
    { id: 'SEC-UC-BANNER', name: 'Urban Company Location Banner', componentName: 'UC Prompt Surface', description: 'Amber bordered banner (#232018) for setting area or granting doorstep GPS', enabled: true },
    { id: 'SEC-SEARCH-BAR', name: 'Slim Search Bar with Cycling Hints', componentName: 'ServFexSearchBar.kt', description: '44dp slim white bar with animated text cycling 8 service keywords', enabled: true },
    { id: 'SEC-PROMO-PAGER', name: 'Dynamic Promo Carousel', componentName: 'PromoBannerPager.kt', description: '140dp rounded-2xl cards with tag pills, bold headlines, and dot indicators', enabled: true },
    { id: 'SEC-CATEGORIES', name: 'Categories LazyRow', componentName: 'ServFexCategoryCard.kt', description: 'Horizontal scrollable 88dp cards with 44dp icon boxes and active highlight', enabled: true },
    { id: 'SEC-POPULAR', name: 'Popular Services Section', componentName: 'ServFexServiceCard.kt', description: 'Header with "View All", 60dp icon boxes, ★ rating, duration, and Book pill', enabled: true },
    { id: 'SEC-WHY-CHOOSE', name: 'Why Choose ServFex (5 Guarantees)', componentName: 'WhyChooseItem.kt', description: 'White container with 5 verified trust badges from strings.xml', enabled: true },
    { id: 'SEC-BOTTOM-NAV', name: 'Customer App Bottom Navigation', componentName: 'ServFexBottomNav.kt', description: '64dp bottom bar with 4 tabs: Home, Services, Bookings, Profile', enabled: true },
  ],
  searchHints: [
    'Sofa Cleaning',
    'AC Repair',
    'Plumbing',
    'Bathroom Cleaning',
    'Car Detailing',
    'Pest Control',
    'Electrical Work',
    'Home Shifting',
  ],
  deliveringLocation: 'Jubilee Hills, Hyderabad',
  popularTitle: 'Popular Services',
  popularSubtitle: 'Most booked in your area this week',
  popularServiceIds: [] as string[],
  serviceSections: [
    {
      id: 'HS-POPULAR',
      title: 'Popular Services',
      subtitle: 'Most booked in your area this week',
      serviceIds: [] as string[],
      enabled: true,
    },
  ],
};

const sanitizeServiceSections = (raw: unknown): Array<{
  id: string;
  title: string;
  subtitle: string;
  serviceIds: string[];
  enabled: boolean;
}> => {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object' && typeof (item as any).id === 'string')
    .map((item: any) => ({
      id: String(item.id),
      title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : 'Services',
      subtitle: typeof item.subtitle === 'string' ? item.subtitle : '',
      serviceIds: Array.isArray(item.serviceIds)
        ? item.serviceIds.filter((id: unknown) => typeof id === 'string' && id.length > 0)
        : [],
      enabled: item.enabled !== false,
    }));
};

export const normalizeHomeLayoutValue = (value: any) => {
  const merged = { ...DEFAULT_HOME_LAYOUT, ...(value || {}) };
  const explicitSections = Array.isArray(value?.serviceSections);
  let serviceSections = sanitizeServiceSections(value?.serviceSections);

  if (!explicitSections) {
    const fallbackIds = Array.isArray(merged.popularServiceIds)
      ? merged.popularServiceIds.filter((id: unknown) => typeof id === 'string' && id.length > 0)
      : [];
    serviceSections = [
      {
        id: 'HS-POPULAR',
        title: merged.popularTitle || 'Popular Services',
        subtitle: merged.popularSubtitle || 'Most booked in your area this week',
        serviceIds: fallbackIds,
        enabled: true,
      },
    ];
  }

  const firstEnabled = serviceSections.find((section) => section.enabled) || serviceSections[0];
  return {
    ...merged,
    serviceSections,
    popularTitle: firstEnabled?.title || 'Popular Services',
    popularSubtitle: firstEnabled?.subtitle || '',
    popularServiceIds: firstEnabled?.serviceIds || [],
  };
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

export const getHomeLayout = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const config = await prisma.appConfiguration.findUnique({
      where: { key: 'HOME_LAYOUT' },
    });
    sendSuccess(res, normalizeHomeLayoutValue(config?.value));
  } catch (error) {
    next(error);
  }
};

export const updateHomeLayout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { reason, ...data } = req.body;

    const existing = await prisma.appConfiguration.findUnique({
      where: { key: 'HOME_LAYOUT' },
    });

    const merged = normalizeHomeLayoutValue({ ...(existing?.value as any || DEFAULT_HOME_LAYOUT), ...data });

    const updated = await prisma.$transaction(async (tx) => {
      const s = await tx.appConfiguration.upsert({
        where: { key: 'HOME_LAYOUT' },
        create: {
          key: 'HOME_LAYOUT',
          value: merged,
          description: 'Customer App Home Screen dynamic layout, slides, and section controls',
        },
        update: {
          value: merged,
        },
      });

      await logAuditEvent({
        superAdminId: req.user!.userId,
        action: 'HOME_LAYOUT_CONFIG_UPDATED',
        entityType: 'AppConfiguration',
        entityId: 'HOME_LAYOUT',
        before: existing?.value as any,
        after: merged,
        reason,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        tx,
      });

      return s;
    });

    // Invalidate public catalog cache so customer mobile app immediately sees new changes
    invalidateCatalogCache();

    sendSuccess(res, updated.value);
  } catch (error) {
    next(error);
  }
};

