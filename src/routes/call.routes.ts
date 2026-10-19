import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import {
  generateCallToken,
  answerCall,
  endCall,
} from '../controllers/call.controller';

const router = Router();

// Protected Agora RTC endpoints: Requires active authenticated user
router.use(authenticate);

// Generate RTC call token & initiate session
router.post('/token', generateCallToken);
router.get('/token/:bookingId', generateCallToken);

// Answer call signaling
router.post('/answer', answerCall);
router.post('/:callId/answer', answerCall);

// End / Decline call signaling
router.post('/end', endCall);
router.post('/:callId/end', endCall);
router.post('/decline', endCall);
router.post('/:callId/decline', endCall);

export default router;
