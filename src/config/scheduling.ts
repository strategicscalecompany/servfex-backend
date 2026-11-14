/** Planned bookable day and attendance defaults for timed booking. */

export const DAY_START_HOUR = 9; // 09:00
export const DAY_END_HOUR = 19; // 19:00
export const SHIFT_HOURS = 10;
export const CHECK_IN_GRACE_MINUTES = 30; // check-in allowed until 09:30
/** Express-slot start rounding only; normal offers step by duration + SLOT_GAP_MINUTES. */
export const SLOT_STEP_MINUTES = 15;
/** Gap between consecutive duration-based slot offers (and travel buffer after a job). */
export const SLOT_GAP_MINUTES = 15;
export const TRAVEL_BUFFER_MINUTES = 15;
export const SLOT_HOLD_TTL_SECONDS = 180; // 3 minutes
export const EXPRESS_LOOKAHEAD_HOURS = 2;
export const MAX_REQUIRED_PROFESSIONALS = 4;

export function parseDurationMinutes(
  durationMinutes?: number | null,
  durationText?: string | null
): number {
  if (durationMinutes != null && Number.isFinite(durationMinutes) && durationMinutes > 0) {
    return Math.round(durationMinutes);
  }
  const text = (durationText || '').toLowerCase();
  const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*h/);
  const minMatch = text.match(/(\d+)\s*m/);
  let mins = 0;
  if (hourMatch) mins += Math.round(parseFloat(hourMatch[1]) * 60);
  if (minMatch) mins += parseInt(minMatch[1], 10);
  return mins > 0 ? mins : 60;
}

/**
 * Resolve bookable duration for a package/service.
 * Prefer package duration text, then minutes, then service durationText.
 * Avoids the Prisma default `durationMinutes: 60` masking a real "3 hrs" / "5h" label.
 */
export function resolveBookingDurationMinutes(opts: {
  packageDurationMinutes?: number | null;
  packageDurationText?: string | null;
  serviceDurationText?: string | null;
}): number {
  const pkgText = (opts.packageDurationText || '').trim();
  const svcText = (opts.serviceDurationText || '').trim();
  const fromPkgText = parseDurationMinutes(null, pkgText || null);
  const fromSvcText = parseDurationMinutes(null, svcText || null);
  const fromMins =
    opts.packageDurationMinutes != null &&
    Number.isFinite(opts.packageDurationMinutes) &&
    opts.packageDurationMinutes > 0
      ? Math.round(opts.packageDurationMinutes)
      : 0;

  const isDefaultSixtyText = (t: string) => /^60\s*mins?$/i.test(t);

  if (pkgText && !isDefaultSixtyText(pkgText) && fromPkgText > 0) return fromPkgText;
  if (fromMins > 0) {
    if (fromMins === 60 && fromSvcText > 60) return fromSvcText;
    if (fromMins === 60 && fromPkgText > 60) return fromPkgText;
    return fromMins;
  }
  if (fromPkgText > 0) return fromPkgText;
  if (fromSvcText > 0) return fromSvcText;
  return 60;
}

/** Build Date for YYYY-MM-DD at local wall-clock hour:minute in Asia/Kolkata-ish server local. */
export function atLocalTime(dateYmd: string, hour: number, minute = 0): Date {
  const [y, m, d] = dateYmd.split('-').map(Number);
  return new Date(y, m - 1, d, hour, minute, 0, 0);
}

export function formatTimeSlotLabel(start: Date, end: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${fmt(start)} - ${fmt(end)}`;
}

export function intervalsOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
  bufferMinutes = 0
): boolean {
  const bufMs = bufferMinutes * 60 * 1000;
  return aStart.getTime() < bEnd.getTime() + bufMs && bStart.getTime() < aEnd.getTime() + bufMs;
}
