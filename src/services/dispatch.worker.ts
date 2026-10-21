import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { registerDispatchHandler, scheduleDispatch, clearAllDispatchTimers } from './dispatch.scheduler';
import { processBookingDispatch } from './dispatch.service';
import { isTestingWorkflowEnabled } from '../config/testing-workflow';

let sweepTimer: NodeJS.Timeout | null = null;
let isSweeping = false;

/**
 * Sweep the database for bookings whose dispatch timeout has elapsed.
 * Only processes bookings in PENDING or ASSIGNED status whose dispatchDueAt <= now.
 * Concurrency is handled by row-level locking (FOR UPDATE SKIP LOCKED) in processBookingDispatch.
 */
export async function sweepDueBookings(clock: () => Date = () => new Date()): Promise<number> {
  if (isSweeping) return 0;
  isSweeping = true;
  try {
    const now = clock();
    const dueBookings = await prisma.booking.findMany({
      where: {
        status: { in: ['PENDING', 'ASSIGNED'] },
        dispatchDueAt: { lte: now },
      },
      select: { id: true },
      take: 50,
      orderBy: { dispatchDueAt: 'asc' },
    });

    let processed = 0;
    for (const b of dueBookings) {
      try {
        await processBookingDispatch(b.id, clock);
        processed++;
      } catch (err) {
        logger.error({ err, bookingId: b.id }, 'Sweeper failed to process booking dispatch');
      }
    }
    return processed;
  } catch (err) {
    logger.error({ err }, 'Error running dispatch sweeper');
    return 0;
  } finally {
    isSweeping = false;
  }
}

/**
 * Arms in-memory timers for any pending bookings on boot so they fire precisely on time.
 */
export async function armPendingBookingsOnBoot(clock: () => Date = () => new Date()): Promise<void> {
  try {
    const now = clock();
    const upcoming = await prisma.booking.findMany({
      where: {
        status: { in: ['PENDING', 'ASSIGNED'] },
        dispatchDueAt: { gt: now },
      },
      select: { id: true, dispatchDueAt: true },
      take: 200,
    });

    for (const b of upcoming) {
      if (b.dispatchDueAt) {
        scheduleDispatch(b.id, b.dispatchDueAt, now);
      }
    }
    logger.info({ count: upcoming.length }, 'Armed in-memory dispatch timers on boot');
  } catch (err) {
    logger.warn({ err }, 'Failed to arm in-memory dispatch timers on boot (sweeper will cover them)');
  }
}

/**
 * Starts the dispatch worker:
 * 1. Registers the dispatch handler with the scheduler.
 * 2. Arms existing future bookings.
 * 3. Immediately runs a sweep for overdue bookings.
 * 4. Schedules periodic sweep interval.
 */
export async function startDispatchWorker(): Promise<void> {
  if (isTestingWorkflowEnabled()) {
    logger.info(
      'Dispatch worker isolated by EXPERT_TESTING_WORKFLOW_ENABLED (original worker code is unchanged)'
    );
    return;
  }
  if (!env.DISPATCH_WORKER_ENABLED) {
    logger.info('Dispatch worker disabled by environment configuration');
    return;
  }

  registerDispatchHandler(processBookingDispatch);
  await armPendingBookingsOnBoot();
  await sweepDueBookings();

  sweepTimer = setInterval(() => {
    sweepDueBookings().catch((err) => logger.error({ err }, 'Periodic dispatch sweep failed'));
  }, env.DISPATCH_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  logger.info({ intervalMs: env.DISPATCH_SWEEP_INTERVAL_MS }, 'Dispatch worker started');
}

/**
 * Cleanly stops the dispatch worker.
 */
export function stopDispatchWorker(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  clearAllDispatchTimers();
  logger.info('Dispatch worker stopped');
}
