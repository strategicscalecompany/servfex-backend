import { Router } from 'express';
import {
  getCatalogCategories,
  getCatalogServices,
  getCatalogServiceById,
  getCatalogServiceReviews,
} from '../controllers/catalog.controller';

const router = Router();

// Public catalog endpoints (No authentication required)
router.get('/categories', getCatalogCategories);
router.get('/services', getCatalogServices);
router.get('/services/:id', getCatalogServiceById);
router.get('/services/:id/reviews', getCatalogServiceReviews);

export default router;
