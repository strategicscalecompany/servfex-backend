import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { env } from '../config/env';

export const MAX_DOCUMENT_BYTES = 500 * 1024 * 1024;
const LARGE_UPLOAD_THRESHOLD_BYTES = 20 * 1024 * 1024;
const CLOUDINARY_UPLOAD_TIMEOUT_MS = 600000;

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

export const estimatePayloadBytes = (value: string): number => {
  if (!value) return 0;
  if (value.startsWith('data:')) {
    const comma = value.indexOf(',');
    const b64 = comma >= 0 ? value.slice(comma + 1) : value;
    return Math.floor((b64.length * 3) / 4);
  }
  return Buffer.byteLength(value, 'utf8');
};

const extensionFromDataUri = (dataUri: string): string => {
  const header = dataUri.slice(0, dataUri.indexOf(',') >= 0 ? dataUri.indexOf(',') : 80).toLowerCase();
  if (header.includes('pdf')) return '.pdf';
  if (header.includes('png')) return '.png';
  if (header.includes('webp')) return '.webp';
  if (header.includes('gif')) return '.gif';
  if (header.includes('jpeg') || header.includes('jpg')) return '.jpg';
  return '.bin';
};

const uploadDataUriInChunks = async (
  dataUri: string,
  folder: string,
  resourceType: 'image' | 'raw' | 'auto'
): Promise<string> => {
  const comma = dataUri.indexOf(',');
  const b64 = comma >= 0 ? dataUri.slice(comma + 1) : dataUri;
  const tmpPath = path.join(
    os.tmpdir(),
    `servfex-upload-${Date.now()}-${Math.random().toString(36).slice(2)}${extensionFromDataUri(dataUri)}`
  );

  await fs.writeFile(tmpPath, Buffer.from(b64, 'base64'));
  try {
    const result = (await cloudinary.uploader.upload_large(tmpPath, {
      folder,
      resource_type: resourceType,
      chunk_size: 20 * 1024 * 1024,
      timeout: CLOUDINARY_UPLOAD_TIMEOUT_MS,
    })) as UploadApiResponse;
    return result.secure_url;
  } finally {
    await fs.unlink(tmpPath).catch(() => undefined);
  }
};

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
    const resourceType: 'image' | 'raw' | 'auto' = isPdf ? 'raw' : isImage ? 'image' : 'auto';
    const payloadBytes = estimatePayloadBytes(fileOrBase64);

    if (fileOrBase64.startsWith('data:') && payloadBytes > LARGE_UPLOAD_THRESHOLD_BYTES) {
      return await uploadDataUriInChunks(fileOrBase64, folder, isImage && !isPdf ? 'auto' : resourceType);
    }

    const result = await cloudinary.uploader.upload(fileOrBase64, {
      folder,
      resource_type: resourceType,
      timeout: CLOUDINARY_UPLOAD_TIMEOUT_MS,
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

export function createCloudinaryUploadSignature(folder: string): {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
} | null {
  if (!isCloudinaryConfigured() || !env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    return null;
  }

  const timestamp = Math.round(Date.now() / 1000);
  const signature = cloudinary.utils.api_sign_request(
    { timestamp, folder },
    env.CLOUDINARY_API_SECRET
  );

  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    timestamp,
    signature,
    folder,
  };
}

export { cloudinary };
