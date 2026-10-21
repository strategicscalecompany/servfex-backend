import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { generateCallToken } from '../controllers/call.controller';
import {
  registerVendor,
  getVendorProfile,
  updateVendorProfile,
  getVendorDocuments,
  uploadVendorDocument,
  getVendorServices,
  addVendorService,
  updateVendorService,
  deleteVendorService,
  getVendorOrders,
  getVendorOrderById,
  updateOrderStatus,
  verifyOrderQr,
  verifyOrderOtp,
  createHubBooking,
  completeOrder,
  recordCashCollection,
  assignEmployeeToOrder,
  createVendorInquiry,
  getVendorEmployees,
  createVendorEmployee,
  updateVendorEmployee,
  deleteVendorEmployee,
  getVendorReviews,
  submitVendorFeedback,
  getVendorFeedback,
  registerVendorSchema,
  updateVendorProfileSchema,
  uploadDocumentSchema,
  vendorServiceSchema,
  updateVendorServiceSchema,
  updateOrderStatusSchema,
  verifyOrderQrSchema,
  createHubBookingSchema,
  recordCashSchema,
  assignEmployeeOrderSchema,
  createEmployeeSchema,
  updateEmployeeSchema,
  vendorInquirySchema,
  feedbackSchema,
} from '../controllers/vendor-portal.controller';

const router = Router();

// -------------------------------------------------------------
// Unprotected Onboarding Endpoint
// -------------------------------------------------------------
router.post('/auth/register', validate(registerVendorSchema), registerVendor);

// -------------------------------------------------------------
// Protected Vendor Endpoints (Roles: VENDOR, EMPLOYEE)
// -------------------------------------------------------------
router.use(authenticate);
router.use(requireRole('VENDOR', 'EMPLOYEE', 'OPERATIONS_MANAGER'));

// Profile
router.get('/profile', getVendorProfile);
router.patch('/profile', validate(updateVendorProfileSchema), updateVendorProfile);

// KYC Documents
router.get('/documents', getVendorDocuments);
router.post('/documents', validate(uploadDocumentSchema), uploadVendorDocument);

// Service Offerings
router.get('/services', getVendorServices);
router.post('/services', validate(vendorServiceSchema), addVendorService);
router.patch('/services/:id', validate(updateVendorServiceSchema), updateVendorService);
router.delete('/services/:id', deleteVendorService);

// Order Dispatch & Management
router.get('/orders', getVendorOrders);
router.post('/orders', validate(vendorInquirySchema), createVendorInquiry);
router.post('/hub-bookings', validate(createHubBookingSchema), createHubBooking);
router.get('/orders/:id', getVendorOrderById);
router.patch('/orders/:id/status', validate(updateOrderStatusSchema), updateOrderStatus);
router.post('/orders/:id/status', validate(updateOrderStatusSchema), updateOrderStatus);
router.post('/orders/:id/verify-otp', validate(verifyOrderQrSchema), verifyOrderOtp);
router.post('/orders/:id/verify-qr', validate(verifyOrderQrSchema), verifyOrderQr);
router.post('/orders/:id/complete', completeOrder);
router.post('/orders/:id/call-token', generateCallToken);
router.post('/orders/:id/record-cash', validate(recordCashSchema), recordCashCollection);
router.post('/orders/:id/assign', validate(assignEmployeeOrderSchema), assignEmployeeToOrder);

// Employee / Technician Management
router.get('/employees', getVendorEmployees);
router.post('/employees', validate(createEmployeeSchema), createVendorEmployee);
router.patch('/employees/:id', validate(updateEmployeeSchema), updateVendorEmployee);
router.delete('/employees/:id', deleteVendorEmployee);

// Reviews & Feedback
router.get('/reviews', getVendorReviews);
router.post('/feedback', validate(feedbackSchema), submitVendorFeedback);
router.get('/feedback', getVendorFeedback);

export default router;
