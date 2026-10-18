import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env';

// Configure Cloudinary explicitly
cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

/**
 * Checks whether Cloudinary has credentials configured
 */
export const isCloudinaryConfigured = (): boolean => {
  return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
};

/**
 * Uploads an image (Base64 data URI, remote HTTP URL, or binary file) to Cloudinary.
 * Returns the secure HTTPS URL on Cloudinary CDN.
 * If already hosted on res.cloudinary.com, returns as is.
 */
export const uploadToCloudinary = async (
  fileOrBase64: string,
  folder: string = 'servfex/catalog'
): Promise<string> => {
  if (!fileOrBase64) return '';

  // If already hosted on Cloudinary, return as-is
  if (fileOrBase64.includes('res.cloudinary.com')) {
    return fileOrBase64;
  }

  // If not configured, fallback gracefully
  if (!isCloudinaryConfigured()) {
    console.warn('[Cloudinary] Cloudinary credentials not configured; keeping original image value.');
    return fileOrBase64;
  }

  try {
    const isImage =
      fileOrBase64.startsWith('data:image/') ||
      (!fileOrBase64.startsWith('data:') && !fileOrBase64.toLowerCase().endsWith('.pdf'));
    const result = await cloudinary.uploader.upload(fileOrBase64, {
      folder,
      resource_type: isImage ? 'image' : 'auto',
      ...(isImage ? { transformation: [{ quality: 'auto', fetch_format: 'auto' }] } : {}),
    });

    return result.secure_url;
  } catch (error) {
    console.error('[Cloudinary] Upload failed:', error);
    throw error;
  }
};

export { cloudinary };
