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

export const uploadImage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { image, folder } = req.body;

    const secureUrl = await uploadToCloudinary(image, folder);

    sendSuccess(res, {
      url: secureUrl,
    });
  } catch (error: any) {
    sendError(res, 'IMAGE_UPLOAD_FAILED', error.message || 'Failed to upload image to Cloudinary', 500);
  }
};
