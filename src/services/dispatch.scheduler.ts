import { logger } from '../config/logger';

/**
 * Precise in-process timers that complement the database sweeper.
 *
 * The timer is only an OPTIMISATION for latency (fires at exactly the due time). Correctness never depends on it:
 * the due time is persisted on the booking (`dispatchDueAt`) and the sweeper in dispatch.worker.ts re-discovers
 * anything that was missed (process restart, crashed timer, another instance). The handler is idempotent, so a
 * timer and the sweeper firing for the same booking is harmless.
 */
type Handler = (bookingId: string) => Promise<unknown>;

let handler: Handler | null = null;
const timers = new Map<string, NodeJS.Timeout>();

/** Node timers overflow past ~24.8 days; our delays are seconds, but clamp defensively. */
const MAX_DELAY_MS = 2_000_000_000;

export function registerDispatchHandler(fn: Handler): void {
  handler = fn;
}

export function scheduleDispatch(bookingId: string, dueAt: Date, now: Date = new Date()): void {
  cancelDispatchTimer(bookingId);
  if (!handler) return; // worker disabled (tests / secondary instances): the sweeper still covers it

  const delay = Math.min(Math.max(dueAt.getTime() - now.getTime(), 0) + 50, MAX_DELAY_MS);
  const timer = setTimeout(() => {
    timers.delete(bookingId);
    handler?.(bookingId).catch((err) => logger.error({ err, bookingId }, 'Dispatch timer handler failed'));
  }, delay);
  // Never keep the process alive just for a pending dispatch timer.
  timer.unref();
  timers.set(bookingId, timer);
}

export function cancelDispatchTimer(bookingId: string): void {
  const existing = timers.get(bookingId);
  if (existing) {
    clearTimeout(existing);
    timers.delete(bookingId);
  }
}

export function pendingTimerCount(): number {
  return timers.size;
}

export function clearAllDispatchTimers(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
