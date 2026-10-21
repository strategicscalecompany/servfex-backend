import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  createCloudinaryUploadSignature,
  estimatePayloadBytes,
  MAX_DOCUMENT_BYTES,
  uploadToCloudinary,
} from '../utils/cloudinary';
import { sendSuccess, sendError } from '../utils/response';

export const uploadImageSchema = z.object({
  body: z.object({
    image: z.string().min(1, 'Image data or URL is required'),
    folder: z.string().optional().default('servfex/catalog'),
  }),
});

export const signUploadSchema = z.object({
  body: z.object({
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

export const signCloudinaryUpload = async (req: Request, res: Response): Promise<void> => {
  const folder = ALLOWED_UPLOAD_FOLDERS.has(req.body.folder) ? req.body.folder : 'servfex/catalog';
  const signed = createCloudinaryUploadSignature(folder);
  if (!signed) {
    sendError(res, 'UPLOAD_NOT_CONFIGURED', 'Media hosting is not configured on the server.', 503);
    return;
  }

  sendSuccess(res, signed);
};

export const uploadImage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { image, folder } = req.body;
    const targetFolder = ALLOWED_UPLOAD_FOLDERS.has(folder) ? folder : 'servfex/catalog';

    if (estimatePayloadBytes(image) > MAX_DOCUMENT_BYTES) {
      sendError(res, 'PAYLOAD_TOO_LARGE', 'Each document must be 500MB or smaller, and all documents together cannot exceed 500MB.', 413);
      return;
    }

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
