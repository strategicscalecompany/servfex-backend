import type { BookingStatus } from '@prisma/client';

/**
 * Pure (side-effect free, DB-free) decision rules for warehouse routing, expert selection,
 * call authorization and location visibility. Everything here is deterministic so it can be
 * unit-tested without a database or a clock.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Statuses in which an expert is considered to be "busy" with a job. */
export const ACTIVE_JOB_STATUSES: BookingStatus[] = ['ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'ARRIVED', 'IN_PROGRESS'];

/** Workload rule: an expert may hold at most this many open jobs (offers included). */
export const MAX_ACTIVE_JOBS_PER_EXPERT = 1;

/** After this many failed auto-assign attempts the booking is escalated to super admins. */
export const ESCALATE_AFTER_ATTEMPTS = 6;

/** After this many failed auto-assign attempts the worker stops retrying and leaves the booking to the admin desk. */
export const MAX_AUTO_ASSIGN_ATTEMPTS = 20;

/** Statuses in which the assigned expert may see the customer's exact pinned location. */
export const EXACT_LOCATION_STATUSES: BookingStatus[] = [
  'ACCEPTED',
  'ON_THE_WAY',
  'ARRIVED',
  'IN_PROGRESS',
  'AWAITING_CUSTOMER_CONFIRMATION',
  'AWAITING_PAYMENT',
  'DISPUTED',
];

/** Statuses in which the customer and the assigned expert may open a private call. */
export const CALLABLE_STATUSES: BookingStatus[] = ['ACCEPTED', 'ON_THE_WAY', 'ARRIVED', 'IN_PROGRESS'];

/** A ringing call that is not answered within this window is marked MISSED. */
export const CALL_RING_TIMEOUT_SECONDS = 60;

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

export function isValidCoordinate(lat: unknown, lng: unknown): boolean {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  // (0,0) is the "null island" default emitted by unset GPS fixes; never a real service address here.
  if (lat === 0 && lng === 0) return false;
  return true;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

/** Rounds to 2 decimals (~1.1 km) so a non-assigned party only learns the neighbourhood. */
export function approximateCoordinate(value: number | null | undefined): number | null {
  if (value == null) return null;
  return Math.round(value * 100) / 100;
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

// ---------------------------------------------------------------------------
// Warehouse resolution
// ---------------------------------------------------------------------------

export interface WarehouseCandidate {
  id: string;
  latitude: number | null;
  longitude: number | null;
  serviceRadiusKm: number;
  location: string;
  /** Vendor catalog offers the service (or has an empty catalog = general partner, matching existing behaviour). */
  offersService: boolean;
  availableExperts: number;
}

export interface WarehouseResolution {
  vendorId: string;
  distanceKm: number | null;
  matchedBy: 'RADIUS' | 'CITY_TEXT';
}

type QualifiedWarehouse = WarehouseResolution & { availableExperts: number };

/**
 * Deterministically picks the warehouse (vendor hub) responsible for a service location.
 *
 *  1. Only vendors that offer the service are considered.
 *  2. A vendor with coordinates qualifies when the service point lies inside its `serviceRadiusKm`.
 *  3. A vendor WITHOUT coordinates may qualify through a city/location text match (legacy data only).
 *  4. A customer-preferred vendor is honoured only when it qualifies (the client never dictates routing).
 *  5. Overlapping areas: nearest hub wins; ties -> most available experts -> lowest id.
 *     Radius matches always outrank text matches.
 *
 * Returns null when nobody serves the location: the caller must NOT fall back to an unrelated vendor.
 */
export function resolveWarehouse(
  candidates: WarehouseCandidate[],
  point: { lat: number; lng: number } | null,
  city: string | null,
  preferredVendorId?: string | null
): WarehouseResolution | null {
  const normalizedCity = (city || '').toLowerCase().trim();

  const qualified: QualifiedWarehouse[] = [];
  for (const c of candidates) {
    if (!c.offersService) continue;

    const hasCoords = c.latitude != null && c.longitude != null;

    if (hasCoords && point) {
      const distanceKm = haversineKm(point.lat, point.lng, c.latitude as number, c.longitude as number);
      if (distanceKm <= c.serviceRadiusKm) {
        qualified.push({ vendorId: c.id, distanceKm, matchedBy: 'RADIUS', availableExperts: c.availableExperts });
      }
      continue;
    }

    if (!hasCoords) {
      const loc = (c.location || '').toLowerCase().trim();
      if (normalizedCity && loc && (loc.includes(normalizedCity) || normalizedCity.includes(loc))) {
        qualified.push({ vendorId: c.id, distanceKm: null, matchedBy: 'CITY_TEXT', availableExperts: c.availableExperts });
      }
    }
  }

  if (qualified.length === 0) return null;

  if (preferredVendorId) {
    const preferred = qualified.find((q) => q.vendorId === preferredVendorId);
    if (preferred) return stripExperts(preferred);
  }

  qualified.sort((a, b) => {
    if (a.matchedBy !== b.matchedBy) return a.matchedBy === 'RADIUS' ? -1 : 1;
    if (a.distanceKm != null && b.distanceKm != null && a.distanceKm !== b.distanceKm) {
      return a.distanceKm - b.distanceKm;
    }
    if (a.availableExperts !== b.availableExperts) return b.availableExperts - a.availableExperts;
    return a.vendorId < b.vendorId ? -1 : a.vendorId > b.vendorId ? 1 : 0;
  });

  return stripExperts(qualified[0]);
}

function stripExperts(q: QualifiedWarehouse): WarehouseResolution {
  return { vendorId: q.vendorId, distanceKm: q.distanceKm, matchedBy: q.matchedBy };
}

// ---------------------------------------------------------------------------
// Expert selection
// ---------------------------------------------------------------------------

export interface ExpertCandidate {
  id: string;
  userId: string;
  isAvailable: boolean;
  userActive: boolean;
  lastAssignedAt: Date | null;
  completedJobs: number;
  activeJobs: number;
  /** Already rejected / let this booking's offer expire. */
  excludedForBooking: boolean;
}

export function isExpertEligible(e: ExpertCandidate, maxActiveJobs = MAX_ACTIVE_JOBS_PER_EXPERT): boolean {
  return e.isAvailable && e.userActive && !e.excludedForBooking && e.activeJobs < maxActiveJobs;
}

/**
 * Fair, deterministic ordering of eligible experts:
 * least recently assigned first (never-assigned first) -> fewest lifetime jobs -> lowest id.
 */
export function rankEligibleExperts(
  candidates: ExpertCandidate[],
  maxActiveJobs = MAX_ACTIVE_JOBS_PER_EXPERT
): ExpertCandidate[] {
  return candidates
    .filter((c) => isExpertEligible(c, maxActiveJobs))
    .sort((a, b) => {
      const at = a.lastAssignedAt ? a.lastAssignedAt.getTime() : Number.NEGATIVE_INFINITY;
      const bt = b.lastAssignedAt ? b.lastAssignedAt.getTime() : Number.NEGATIVE_INFINITY;
      if (at !== bt) return at < bt ? -1 : 1;
      if (a.completedJobs !== b.completedJobs) return a.completedJobs - b.completedJobs;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

// ---------------------------------------------------------------------------
// Expert travel-status transitions
// ---------------------------------------------------------------------------

const EXPERT_TRAVEL_TRANSITIONS: Partial<Record<BookingStatus, BookingStatus>> = {
  ACCEPTED: 'ON_THE_WAY',
  ON_THE_WAY: 'ARRIVED',
};

export function isValidExpertTravelTransition(from: BookingStatus, to: BookingStatus): boolean {
  return EXPERT_TRAVEL_TRANSITIONS[from] === to;
}

// ---------------------------------------------------------------------------
// Location visibility
// ---------------------------------------------------------------------------

export type LocationViewerRole = 'CUSTOMER_OWNER' | 'VENDOR_OWNER' | 'ASSIGNED_EXPERT' | 'OTHER_EXPERT' | 'SUPER_ADMIN';

/**
 * Exact pinned coordinates are only visible to: the owning customer, the owning vendor (provider),
 * super admins and - once the booking is accepted - the assigned expert. Anyone else (e.g. other
 * experts of the same warehouse looking at the pool, or the assigned expert before acceptance) only
 * sees the neighbourhood.
 */
export function canSeeExactLocation(viewer: LocationViewerRole, status: BookingStatus): boolean {
  switch (viewer) {
    case 'CUSTOMER_OWNER':
    case 'VENDOR_OWNER':
    case 'SUPER_ADMIN':
      return true;
    case 'ASSIGNED_EXPERT':
      return EXACT_LOCATION_STATUSES.includes(status);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Call authorization
// ---------------------------------------------------------------------------

export type CallParticipantRole = 'CUSTOMER' | 'EXPERT';

export interface CallAccessInput {
  status: BookingStatus;
  customerUserId: string | null | undefined;
  expertUserId: string | null | undefined;
  userId: string;
}

export type CallAccessDecision =
  | { allowed: true; participantRole: CallParticipantRole; peerUserId: string }
  | { allowed: false; code: 'FORBIDDEN' | 'CALL_NOT_AVAILABLE'; message: string; httpStatus: number };

/**
 * Only the booking-owning customer and the CURRENTLY assigned expert may call each other, and only
 * while the booking is in an eligible state. Providers, other experts and super admins are refused.
 */
export function evaluateCallAccess(input: CallAccessInput): CallAccessDecision {
  const { status, customerUserId, expertUserId, userId } = input;

  const isCustomer = !!customerUserId && customerUserId === userId;
  const isExpert = !!expertUserId && expertUserId === userId;

  if (!isCustomer && !isExpert) {
    return {
      allowed: false,
      code: 'FORBIDDEN',
      message: 'Only the booking customer and the assigned expert can call each other for this booking',
      httpStatus: 403,
    };
  }

  if (!expertUserId || !customerUserId) {
    return {
      allowed: false,
      code: 'CALL_NOT_AVAILABLE',
      message: 'No expert has accepted this booking yet',
      httpStatus: 409,
    };
  }

  if (!CALLABLE_STATUSES.includes(status)) {
    return {
      allowed: false,
      code: 'CALL_NOT_AVAILABLE',
      message: `Calling is not available while the booking is ${status}`,
      httpStatus: 409,
    };
  }

  return isCustomer
    ? { allowed: true, participantRole: 'CUSTOMER', peerUserId: expertUserId }
    : { allowed: true, participantRole: 'EXPERT', peerUserId: customerUserId };
}

/** Fixed per-role Agora UIDs: a channel has exactly two participants, so no hashing / collisions. */
export function agoraUidForRole(role: CallParticipantRole): number {
  return role === 'CUSTOMER' ? 1001 : 2002;
}

/** Booking-scoped channel name: <= 64 chars, ASCII alphanumerics + underscore only. */
export function channelNameForBooking(bookingId: string): string {
  const clean = bookingId.replace(/[^a-zA-Z0-9]/g, '');
  return `sfx_${clean}`.substring(0, 64);
}
