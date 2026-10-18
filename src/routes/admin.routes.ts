import { Router } from 'express';
import { prisma } from '../config/prisma';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { validate } from '../middleware/validate';

// Controllers
import { getDashboardStats } from '../controllers/dashboard.controller';
import { globalSearch, globalSearchSchema } from '../controllers/search.controller';
import {
  getCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  softDeleteCustomer,
  listCustomersQuerySchema,
  createCustomerSchema,
  updateCustomerSchema,
} from '../controllers/customer.controller';
import {
  getVendors,
  getVendorById,
  createVendor,
  approveKyc,
  rejectKyc,
  suspendVendor,
  reactivateVendor,
  updateVendor,
  addVendorDocument,
  deleteVendorDocument,
  deleteVendor,
  assignVendorService,
  removeVendorService,
  listVendorsQuerySchema,
  createVendorSchema,
  updateVendorSchema,
  kycDecisionSchema,
  addDocumentSchema,
} from '../controllers/vendor.controller';
import {
  getEmployees,
  getEmployeeById,
  createEmployee,
  assignVendor,
  toggleEmployeeStatus,
  deleteEmployee,
  createManager,
  getManagers,
  listEmployeesQuerySchema,
  createEmployeeSchema,
  assignVendorSchema,
  createManagerSchema,
} from '../controllers/employee.controller';
import {
  getCategories,
  createCategory,
  updateCategory,
  reorderCategories,
  softDeleteCategory,
  createCategorySchema,
  updateCategorySchema,
  reorderCategoriesSchema,
} from '../controllers/category.controller';
import {
  getServices,
  getServiceById,
  createService,
  updateService,
  setVendorPricing,
  softDeleteService,
  listServicesQuerySchema,
  createServiceSchema,
  updateServiceSchema,
  vendorPricingSchema,
} from '../controllers/service.controller';
import {
  getBookings,
  getBookingById,
  assignVendor as assignBookingVendor,
  getEligibleVendors,
  autoAssignVendor,
  assignEmployee as assignBookingEmployee,
  changeBookingStatus,
  rescheduleBooking,
  overrideBookingPrice,
  cancelBooking,
  listBookingsQuerySchema,
  assignVendorSchema as assignBookingVendorSchema,
  assignEmployeeSchema as assignBookingEmployeeSchema,
  changeStatusSchema,
  rescheduleBookingSchema,
  overridePriceSchema,
  cancelBookingSchema,
} from '../controllers/booking.controller';
import {
  getPayments,
  getPaymentById,
  processRefund,
  getFinancialReconciliation,
  listPaymentsQuerySchema,
  refundSchema,
} from '../controllers/payment.controller';
import {
  getReviews,
  hideReview,
  restoreReview,
  deleteReview,
  getEmployeeFeedback,
  listReviewsQuerySchema,
  hideReviewSchema,
} from '../controllers/review.controller';
import {
  getPlatformSettings,
  updatePlatformSettings,
  getBookingSettings,
  updateBookingSettings,
  getPricingSettings,
  updatePricingSettings,
  getAppConfiguration,
  updateAppConfiguration,
  platformSettingsSchema,
  bookingSettingsSchema,
  pricingSettingsSchema,
  appConfigSchema,
} from '../controllers/settings.controller';
import {
  broadcastNotification,
  getNotificationHistory,
  broadcastNotificationSchema,
} from '../controllers/notification.controller';
import {
  getAuditLogs,
  getAuditLogById,
  listAuditLogsQuerySchema,
} from '../controllers/audit.controller';
import {
  uploadImage,
  uploadImageSchema,
} from '../controllers/upload.controller';
import {
  getSubCategories,
  createSubCategory,
  updateSubCategory,
  reorderSubCategories,
  deleteSubCategory,
  createSubCategorySchema,
  updateSubCategorySchema,
  reorderSubCategoriesSchema,
} from '../controllers/sub-category.controller';
import {
  getPackages,
  getPackageById,
  createPackage,
  updatePackage,
  reorderPackages,
  deletePackage,
  createPackageSchema,
  updatePackageSchema,
  reorderPackagesSchema,
} from '../controllers/package.controller';

const router = Router();

// Apply SUPER_ADMIN authorization to ALL admin routes!
router.use(authenticate, requireSuperAdmin);

// ==========================================
// CONTROL CENTER - DASHBOARD, SEARCH & MEDIA UPLOAD
// ==========================================
router.get('/dashboard', getDashboardStats);
router.get('/search', validate(globalSearchSchema), globalSearch);
router.post('/upload', validate(uploadImageSchema), uploadImage);

// ==========================================
// MANAGEMENT - CUSTOMERS
// ==========================================
router.get('/customers', validate(listCustomersQuerySchema), getCustomers);
router.post('/customers', validate(createCustomerSchema), createCustomer);
router.get('/customers/:id', getCustomerById);
router.patch('/customers/:id', validate(updateCustomerSchema), updateCustomer);
router.delete('/customers/:id', softDeleteCustomer);

// ==========================================
// MANAGEMENT - VENDORS
// ==========================================
router.get('/vendors', validate(listVendorsQuerySchema), getVendors);
router.post('/vendors', validate(createVendorSchema), createVendor);
router.get('/vendors/:id', getVendorById);
router.patch('/vendors/:id', validate(updateVendorSchema), updateVendor);
router.patch('/vendors/:id/approve', validate(kycDecisionSchema), approveKyc);
router.patch('/vendors/:id/reject', validate(kycDecisionSchema), rejectKyc);
router.patch('/vendors/:id/suspend', suspendVendor);
router.patch('/vendors/:id/reactivate', reactivateVendor);
router.post('/vendors/:id/documents', validate(addDocumentSchema), addVendorDocument);
router.delete('/vendors/:id/documents/:documentId', deleteVendorDocument);
router.post('/vendors/:id/services', assignVendorService);
router.delete('/vendors/:id/services/:serviceId', removeVendorService);
router.delete('/vendors/:id', deleteVendor);

// ==========================================
// MANAGEMENT - EMPLOYEES
// ==========================================
router.get('/employees', validate(listEmployeesQuerySchema), getEmployees);
router.post('/employees', validate(createEmployeeSchema), createEmployee);
router.get('/employees/:id', getEmployeeById);
router.patch('/employees/:id/assign-vendor', validate(assignVendorSchema), assignVendor);
router.patch('/employees/:id/status', toggleEmployeeStatus);
router.delete('/employees/:id', deleteEmployee);

// ==========================================
// MANAGEMENT - MANAGERS & TERRITORY
// ==========================================
router.get('/managers', getManagers);
router.post('/managers', validate(createManagerSchema), createManager);

// ==========================================
// MANAGEMENT - CATEGORIES
// ==========================================
router.get('/categories', getCategories);
router.post('/categories', validate(createCategorySchema), createCategory);
router.patch('/categories/reorder', validate(reorderCategoriesSchema), reorderCategories);
router.patch('/categories/:id', validate(updateCategorySchema), updateCategory);
router.delete('/categories/:id', softDeleteCategory);

// ==========================================
// MANAGEMENT - SUB-CATEGORIES
// ==========================================
router.get('/categories/:categoryId/sub-categories', getSubCategories);
router.post('/categories/:categoryId/sub-categories', validate(createSubCategorySchema), createSubCategory);
router.patch('/sub-categories/reorder', validate(reorderSubCategoriesSchema), reorderSubCategories);
router.patch('/sub-categories/:id', validate(updateSubCategorySchema), updateSubCategory);
router.delete('/sub-categories/:id', deleteSubCategory);

// ==========================================
// MANAGEMENT - SERVICES & PACKAGES
// ==========================================
router.get('/services', validate(listServicesQuerySchema), getServices);
router.post('/services', validate(createServiceSchema), createService);
router.get('/services/:id', getServiceById);
router.patch('/services/:id', validate(updateServiceSchema), updateService);
router.post('/services/:id/vendor-pricing', validate(vendorPricingSchema), setVendorPricing);
router.delete('/services/:id', softDeleteService);

// ==========================================
// MANAGEMENT - PACKAGES
// ==========================================
router.get('/services/:serviceId/packages', getPackages);
router.post('/services/:serviceId/packages', validate(createPackageSchema), createPackage);
router.patch('/packages/reorder', validate(reorderPackagesSchema), reorderPackages);
router.get('/packages/:id', getPackageById);
router.patch('/packages/:id', validate(updatePackageSchema), updatePackage);
router.delete('/packages/:id', deletePackage);

// ==========================================
// MANAGEMENT - BOOKINGS & WORKFLOW
// ==========================================
router.get('/bookings', validate(listBookingsQuerySchema), getBookings);
router.get('/bookings/:id', getBookingById);
router.get('/bookings/:id/eligible-vendors', getEligibleVendors);
router.post('/bookings/:id/assign-vendor', validate(assignBookingVendorSchema), assignBookingVendor);
router.post('/bookings/:id/auto-assign', autoAssignVendor);
router.post('/bookings/:id/assign-employee', validate(assignBookingEmployeeSchema), assignBookingEmployee);
router.post('/bookings/:id/change-status', validate(changeStatusSchema), changeBookingStatus);
router.post('/bookings/:id/reschedule', validate(rescheduleBookingSchema), rescheduleBooking);
router.post('/bookings/:id/override-price', validate(overridePriceSchema), overrideBookingPrice);
router.post('/bookings/:id/cancel', validate(cancelBookingSchema), cancelBooking);

// ==========================================
// MANAGEMENT - PAYMENTS & FINANCIALS
// ==========================================
router.get('/payments', validate(listPaymentsQuerySchema), getPayments);
router.get('/payments/reconciliation', getFinancialReconciliation);
router.get('/payments/:id', getPaymentById);
router.post('/payments/:id/refund', validate(refundSchema), processRefund);

// ==========================================
// MANAGEMENT - REVIEWS & FEEDBACK
// ==========================================
router.get('/reviews', validate(listReviewsQuerySchema), getReviews);
router.get('/reviews/feedback', getEmployeeFeedback);
router.post('/reviews/:id/hide', validate(hideReviewSchema), hideReview);
router.post('/reviews/:id/restore', restoreReview);
router.delete('/reviews/:id', deleteReview);

// ==========================================
// CONTROL CENTER - SETTINGS
// ==========================================
router.get('/settings/platform', getPlatformSettings);
router.put('/settings/platform', validate(platformSettingsSchema), updatePlatformSettings);
router.patch('/settings/platform', validate(platformSettingsSchema), updatePlatformSettings);

router.get('/settings/booking', getBookingSettings);
router.put('/settings/booking', validate(bookingSettingsSchema), updateBookingSettings);
router.patch('/settings/booking', validate(bookingSettingsSchema), updateBookingSettings);

router.get('/settings/pricing', getPricingSettings);
router.put('/settings/pricing', validate(pricingSettingsSchema), updatePricingSettings);
router.patch('/settings/pricing', validate(pricingSettingsSchema), updatePricingSettings);

router.get('/settings/app-config', getAppConfiguration);
router.put('/settings/app-config', validate(appConfigSchema), updateAppConfiguration);
router.get('/settings/app', getAppConfiguration);
router.put('/settings/app', validate(appConfigSchema), updateAppConfiguration);
router.patch('/settings/app', validate(appConfigSchema), updateAppConfiguration);

// ==========================================
// CONTROL CENTER - SYSTEM & HEALTH
// ==========================================
router.get('/system/health', async (req, res, next) => {
  try {
    const start = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    const dbLatencyMs = Date.now() - start;

    res.json({
      success: true,
      data: {
        status: 'HEALTHY',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        nodeVersion: process.version,
        database: {
          status: 'CONNECTED',
          latencyMs: dbLatencyMs,
        },
        memory: process.memoryUsage(),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// CONTROL CENTER - NOTIFICATIONS & AUDIT
// ==========================================
router.post('/notifications/broadcast', validate(broadcastNotificationSchema), broadcastNotification);
router.get('/notifications/history', getNotificationHistory);

router.get('/audit-logs', validate(listAuditLogsQuerySchema), getAuditLogs);
router.get('/audit-logs/:id', getAuditLogById);

export default router;
