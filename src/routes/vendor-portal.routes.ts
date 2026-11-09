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
  getDeskContext,
  searchDeskServices,
  completeOrder,
  uploadOrderBeforePhotos,
  uploadOrderCompletionPhotos,
  getVendorWorkflowConfig,
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
  uploadBeforePhotosSchema,
  uploadCompletionPhotosSchema,
  recordCashSchema,
  assignEmployeeOrderSchema,
  createEmployeeSchema,
  updateEmployeeSchema,
  vendorInquirySchema,
  feedbackSchema,
  sendCustomerOffer,
  sendCustomerOfferSchema,
} from '../controllers/vendor-portal.controller';
import {
  availabilitySchema,
  chatMessageSchema,
  confirmUpiPayment,
  confirmUpiSchema,
  getMyHubAttendance,
  getMyProfessionalProfile,
  getOrderMessages,
  getOrderTracking,
  getPaymentQr,
  listEscalations,
  locationPingSchema,
  pingOrderLocation,
  postHubCheckIn,
  postHubCheckOut,
  postHubLocation,
  postOrderMessage,
  resolveEscalationSchema,
  resolveEscalationTicket,
  updateMyAvailability,
  updateMyUpi,
  upiSchema,
} from '../controllers/execution.controller';
import {
  createSalesVisit,
  createSalesVisitSchema,
  deleteSalesVisit,
  getSalesVisitById,
  listSalesVisits,
  updateSalesVisit,
  updateSalesVisitSchema,
} from '../controllers/sales-visit.controller';

const router = Router();

// -------------------------------------------------------------
// Unprotected Onboarding Endpoint
// -------------------------------------------------------------
router.post('/auth/register', validate(registerVendorSchema), registerVendor);

// -------------------------------------------------------------
// Protected Vendor Endpoints (Roles: VENDOR, EMPLOYEE)
// -------------------------------------------------------------
router.use(authenticate);
router.use(requireRole('VENDOR', 'EMPLOYEE', 'OPERATIONS_MANAGER', 'BUSINESS_DEVELOPMENT'));

// Profile
router.get('/profile', getVendorProfile);
router.patch('/profile', validate(updateVendorProfileSchema), updateVendorProfile);
router.get('/workflow-config', getVendorWorkflowConfig);
router.get('/desk/context', getDeskContext);
router.get('/desk/services', searchDeskServices);

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
router.post('/orders/:id/before-photos', validate(uploadBeforePhotosSchema), uploadOrderBeforePhotos);
router.post('/orders/:id/completion-photos', validate(uploadCompletionPhotosSchema), uploadOrderCompletionPhotos);
router.post('/orders/:id/call-token', generateCallToken);
router.post('/orders/:id/record-cash', validate(recordCashSchema), recordCashCollection);
router.post('/orders/:id/assign', validate(assignEmployeeOrderSchema), assignEmployeeToOrder);
router.post('/orders/:id/location', validate(locationPingSchema), pingOrderLocation);
router.get('/orders/:id/tracking', getOrderTracking);
router.get('/orders/:id/messages', getOrderMessages);
router.post('/orders/:id/messages', validate(chatMessageSchema), postOrderMessage);
router.get('/orders/:id/payment-qr', getPaymentQr);
router.post('/orders/:id/confirm-upi', validate(confirmUpiSchema), confirmUpiPayment);
router.get('/me/professional', getMyProfessionalProfile);
router.get('/me/hub-attendance', getMyHubAttendance);
router.post('/me/hub-check-in', validate(locationPingSchema), postHubCheckIn);
router.post('/me/hub-check-out', validate(locationPingSchema), postHubCheckOut);
router.post('/me/hub-location', validate(locationPingSchema), postHubLocation);
router.patch('/me/availability', validate(availabilitySchema), updateMyAvailability);
router.patch('/me/upi', validate(upiSchema), updateMyUpi);
router.get('/escalations', listEscalations);
router.post('/escalations/:id/resolve', validate(resolveEscalationSchema), resolveEscalationTicket);

// Employee / Technician Management
router.get('/employees', getVendorEmployees);
router.post('/employees', validate(createEmployeeSchema), createVendorEmployee);
router.patch('/employees/:id', validate(updateEmployeeSchema), updateVendorEmployee);
router.delete('/employees/:id', deleteVendorEmployee);

// Sales Manager visits (temporary testing workflow)
router.get('/visits', listSalesVisits);
router.post('/visits', validate(createSalesVisitSchema), createSalesVisit);
router.get('/visits/:id', getSalesVisitById);
router.patch('/visits/:id', validate(updateSalesVisitSchema), updateSalesVisit);
router.delete('/visits/:id', deleteSalesVisit);

// Reviews & Feedback
router.get('/reviews', getVendorReviews);
router.post('/feedback', validate(feedbackSchema), submitVendorFeedback);
router.get('/feedback', getVendorFeedback);

// Customer offers (partner marketing push)
router.post('/offers', validate(sendCustomerOfferSchema), sendCustomerOffer);

// Tags, hub package crew size, day-of crew recovery
import { requireHubContext } from '../middleware/hubContext';
import {
  vendorListTags,
  vendorCreateHomTag,
  vendorSetEmployeeTags,
  vendorListHubPackages,
  vendorSetHubPackageCrew,
  createHomTagSchema,
  setEmployeeTagsSchema,
  setHubPackageCrewSchema,
} from '../controllers/tag.controller';
import {
  listBookingSubstituteOptions,
  markBookingCrewAbsent,
  crewAbsentSchema,
} from '../controllers/scheduling.controller';

router.get('/tags', requireHubContext, vendorListTags);
router.post('/tags', requireHubContext, validate(createHomTagSchema), vendorCreateHomTag);
router.put('/employees/:id/tags', requireHubContext, validate(setEmployeeTagsSchema), vendorSetEmployeeTags);
router.get('/hub-packages', requireHubContext, vendorListHubPackages);
router.put('/hub-packages/crew', requireHubContext, validate(setHubPackageCrewSchema), vendorSetHubPackageCrew);
router.get('/orders/:id/substitute-options', requireHubContext, listBookingSubstituteOptions);
router.post('/orders/:id/crew-absent', requireHubContext, validate(crewAbsentSchema), markBookingCrewAbsent);

export default router;
