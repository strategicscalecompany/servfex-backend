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

const isAlreadyHosted = (value: string): boolean =>
  value.includes('res.cloudinary.com') || value.includes('cloudinary.com/');

const isPdfPayload = (value: string): boolean =>
  value.startsWith('data:application/pdf') ||
  value.toLowerCase().includes('.pdf') ||
  value.startsWith('data:application/octet-stream');

/**
 * Uploads an image, PDF, or other file (Base64 data URI, remote HTTP URL) to Cloudinary.
 * Returns the secure HTTPS URL on Cloudinary CDN.
 * If already hosted on res.cloudinary.com, returns as is.
 */
export const uploadToCloudinary = async (
  fileOrBase64: string,
  folder: string = 'servfex/catalog'
): Promise<string> => {
  if (!fileOrBase64) return '';

  if (isAlreadyHosted(fileOrBase64)) {
    return fileOrBase64;
  }

  if (!isCloudinaryConfigured()) {
    console.warn('[Cloudinary] Cloudinary credentials not configured; keeping original image value.');
    return fileOrBase64;
  }

  try {
    const isPdf = isPdfPayload(fileOrBase64);
    const isImage = fileOrBase64.startsWith('data:image/') || (!fileOrBase64.startsWith('data:') && !isPdf);
    const result = await cloudinary.uploader.upload(fileOrBase64, {
      folder,
      resource_type: isPdf ? 'raw' : isImage ? 'image' : 'auto',
      timeout: 120000,
      ...(isImage && !isPdf ? { transformation: [{ quality: 'auto', fetch_format: 'auto' }] } : {}),
    });

    return result.secure_url;
  } catch (error) {
    console.error('[Cloudinary] Upload failed:', error);
    throw error;
  }
};

/**
 * Hosts a data URI or remote URL on Cloudinary and returns a CDN URL.
 * Never returns a data: URI — callers can safely persist the result.
 * Remote http(s) URLs are kept as-is if Cloudinary upload fails.
 */
export const resolveHostedUrl = async (
  value: string | null | undefined,
  folder: string
): Promise<string | null> => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (isAlreadyHosted(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith('data:') || trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const uploaded = await uploadToCloudinary(trimmed, folder);
      if (uploaded && !uploaded.startsWith('data:')) {
        return uploaded;
      }
    } catch (err) {
      console.warn(`[Cloudinary] resolveHostedUrl failed for folder ${folder}:`, err);
    }

    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }
    return null;
  }

  return null;
};

export { cloudinary };
