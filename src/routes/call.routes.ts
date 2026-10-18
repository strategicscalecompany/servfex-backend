import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { generateCallToken } from '../controllers/call.controller';

const router = Router();

// Protected Agora RTC endpoints: Requires active authenticated user
router.use(authenticate);

// Generate RTC call token for a given booking
router.post('/token', generateCallToken);
router.get('/token/:bookingId', generateCallToken);

export default router;
