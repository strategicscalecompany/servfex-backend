import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  registerFcmToken,
  registerFcmTokenSchema,
  unregisterFcmToken,
  unregisterFcmTokenSchema,
} from '../controllers/notification.controller';

const router = Router();

router.use(authenticate);

router.get('/', getUserNotifications);
router.patch('/read-all', markAllNotificationsAsRead);
router.patch('/:id/read', markNotificationAsRead);
router.post('/fcm-token', validate(registerFcmTokenSchema), registerFcmToken);
router.post('/fcm-token/unregister', validate(unregisterFcmTokenSchema), unregisterFcmToken);

export default router;
