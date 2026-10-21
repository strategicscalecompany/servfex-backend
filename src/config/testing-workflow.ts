import { env } from './env';

/**
 * Temporary Expert testing workflow.
 *
 * When enabled (default during the current testing stage):
 *  - Sales Manager bookings stay PENDING for the Provider to assign
 *  - Sales Managers cannot accept/complete service jobs
 *  - Service Professionals swipe-accept then swipe-complete with 4 photographs
 *  - On-the-way / arrived / start-OTP is paused (SKIP_TRAVEL_AND_START_OTP)
 *
 * Restore fully original auto-dispatch for Sales Manager bookings by setting
 * EXPERT_TESTING_WORKFLOW_ENABLED=false. No original dispatch code is deleted.
 */
export const MIN_COMPLETION_PHOTOS = 4;

/**
 * Temporary: skip on-the-way / arrived / start-OTP. Service Professionals
 * swipe-accept, then swipe-complete with 4 photographs.
 * Set to false to restore travel + OTP without deleting that code.
 */
export const SKIP_TRAVEL_AND_START_OTP = true;

export const COMPLETABLE_JOB_STATUSES = [
  'ACCEPTED',
  'ON_THE_WAY',
  'ARRIVED',
  'IN_PROGRESS',
] as const;

export function isTestingWorkflowEnabled(): boolean {
  return env.EXPERT_TESTING_WORKFLOW_ENABLED === true;
}

export function getTestingWorkflowSnapshot() {
  return {
    enabled: isTestingWorkflowEnabled(),
    minCompletionPhotos: MIN_COMPLETION_PHOTOS,
    isolatedConnections: isTestingWorkflowEnabled()
      ? [
          'dispatch.worker.startDispatchWorker',
          'dispatch.service.processBookingDispatch',
          'dispatch.service.rejectAssignment immediate re-dispatch',
        ]
      : [],
  };
}

const HOSTED_IMAGE_PATTERN = /^https?:\/\//i;
const DATA_OR_FILE_PATTERN = /^(data:|file:|content:|blob:)/i;

export function isHostedImageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (DATA_OR_FILE_PATTERN.test(trimmed)) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(trimmed)) return false;
  return HOSTED_IMAGE_PATTERN.test(trimmed);
}

export function uniqueHostedImageUrls(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!isHostedImageUrl(value)) continue;
    const url = value.trim();
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

export function countValidCompletionPhotos(values: unknown): number {
  return uniqueHostedImageUrls(values).length;
}

export function hasRequiredCompletionPhotos(values: unknown, min = MIN_COMPLETION_PHOTOS): boolean {
  return countValidCompletionPhotos(values) >= min;
}
