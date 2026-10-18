import { Router } from 'express';
import { authenticate, authenticateFirebaseOnly, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { generateCallToken } from '../controllers/call.controller';
import {
  registerCustomer,
  getCustomerProfile,
  updateCustomerProfile,
  getCustomerAddresses,
  addCustomerAddress,
  updateCustomerAddress,
  deleteCustomerAddress,
  setDefaultCustomerAddress,
  createBooking,
  getCustomerBookings,
  getCustomerBookingById,
  cancelBooking,
  rescheduleBooking,
  submitCustomerReview,
  getBookingQrToken,
  confirmBookingCompletion,
  reportBookingIssue,
  registerCustomerSchema,
  updateCustomerProfileSchema,
  addressSchema,
  createBookingSchema,
  cancelBookingSchema,
  rescheduleBookingSchema,
  submitReviewSchema,
  reportIssueSchema,
} from '../controllers/customer-portal.controller';

const router = Router();

// -------------------------------------------------------------
// Onboarding & Registration (Firebase token verified, pre-DB account)
// -------------------------------------------------------------
router.post(
  '/auth/register',
  authenticateFirebaseOnly,
  validate(registerCustomerSchema),
  registerCustomer
);

// -------------------------------------------------------------
// Protected Customer Endpoints (Role: CUSTOMER)
// -------------------------------------------------------------
router.use(authenticate);
router.use(requireRole('CUSTOMER'));

// Profile
router.get('/profile', getCustomerProfile);
router.patch('/profile', validate(updateCustomerProfileSchema), updateCustomerProfile);

// Address Management
router.get('/addresses', getCustomerAddresses);
router.post('/addresses', validate(addressSchema), addCustomerAddress);
router.put('/addresses/:id', validate(addressSchema), updateCustomerAddress);
router.delete('/addresses/:id', deleteCustomerAddress);
router.patch('/addresses/:id/default', setDefaultCustomerAddress);

// Booking Lifecycle
router.post('/bookings', validate(createBookingSchema), createBooking);
router.get('/bookings', getCustomerBookings);
router.get('/bookings/:id', getCustomerBookingById);
router.get('/bookings/:id/qr-token', getBookingQrToken);
router.post('/bookings/:id/call-token', generateCallToken);
router.post('/bookings/:id/confirm-completion', confirmBookingCompletion);
router.post('/bookings/:id/report-issue', validate(reportIssueSchema), reportBookingIssue);
router.post('/bookings/:id/cancel', validate(cancelBookingSchema), cancelBooking);
router.post('/bookings/:id/reschedule', validate(rescheduleBookingSchema), rescheduleBooking);

// Reviews
router.post('/bookings/:id/review', validate(submitReviewSchema), submitCustomerReview);

export default router;
