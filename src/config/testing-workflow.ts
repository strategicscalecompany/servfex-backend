import { env } from './env';

/**
 * Temporary Expert testing workflow.
 *
 * When enabled (default during the current testing stage):
 *  - Auto-dispatch / offer-expiry is isolated (code remains, connections are skipped)
 *  - Employees are classified as SERVICE_PROFESSIONAL or SALES_MANAGER
 *  - Sales Manager bookings stay PENDING for the Provider to assign
 *  - Service Professional completion requires 4 hosted photographs
 *
 * Restore the original workflow by setting EXPERT_TESTING_WORKFLOW_ENABLED=false.
 * No original dispatch, assignment, or completion code is deleted.
 */
export const MIN_COMPLETION_PHOTOS = 4;

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
