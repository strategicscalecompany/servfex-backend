import { Router } from 'express';
import {
  getCatalogCategories,
  getCatalogHomeLayout,
  getCatalogServices,
  getCatalogServiceById,
  getCatalogServiceReviews,
} from '../controllers/catalog.controller';

const router = Router();

// Public catalog endpoints (No authentication required)
router.get('/home-layout', getCatalogHomeLayout);
router.get('/categories', getCatalogCategories);
router.get('/services', getCatalogServices);
router.get('/services/:id', getCatalogServiceById);
router.get('/services/:id/reviews', getCatalogServiceReviews);

export default router;
