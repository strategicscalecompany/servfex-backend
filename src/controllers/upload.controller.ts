import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { uploadToCloudinary } from '../utils/cloudinary';
import { sendSuccess, sendError } from '../utils/response';

export const uploadImageSchema = z.object({
  body: z.object({
    image: z.string().min(1, 'Image data or URL is required'),
    folder: z.string().optional().default('servfex/catalog'),
  }),
});

const ALLOWED_UPLOAD_FOLDERS = new Set([
  'servfex/catalog',
  'servfex/avatars',
  'servfex/warehouses',
  'servfex/documents',
  'servfex/categories',
  'servfex/services/icons',
  'servfex/services/banners',
  'servfex/services/videos',
  'servfex/packages/banners',
  'servfex/packages/icons',
  'servfex/packages/steps',
  'servfex/packages/cards',
]);

export const uploadImage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { image, folder } = req.body;
    const targetFolder = ALLOWED_UPLOAD_FOLDERS.has(folder) ? folder : 'servfex/catalog';

    const secureUrl = await uploadToCloudinary(image, targetFolder);
    if (!secureUrl || secureUrl.startsWith('data:')) {
      sendError(res, 'IMAGE_UPLOAD_FAILED', 'Could not host this file. Try a smaller PDF or image.', 400);
      return;
    }

    sendSuccess(res, {
      url: secureUrl,
    });
  } catch (error: any) {
    sendError(res, 'IMAGE_UPLOAD_FAILED', error.message || 'Failed to upload image to Cloudinary', 500);
  }
};
