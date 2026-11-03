import { env } from '../config/env';
import { logger } from '../config/logger';
import { haversineKm, isValidCoordinate } from './dispatch.rules';

interface DirectionsCacheEntry {
  data: DirectionsResult;
  expiresAt: number;
}

const cache = new Map<string, DirectionsCacheEntry>();
const MAX_CACHE = 400;
const CACHE_TTL_MS = 45_000;
const FETCH_TIMEOUT_MS = 8000;

export interface DirectionsResult {
  remainingDistanceKm: number;
  etaMinutes: number;
  /** Encoded Google/OSRM polyline that follows roads (null = straight-line fallback). */
  encodedPolyline: string | null;
  distanceMeters?: number;
  durationSeconds?: number;
  source: 'GOOGLE_DIRECTIONS' | 'OSRM' | 'HAVERSINE';
}

function cacheKey(originLat: number, originLng: number, destLat: number, destLng: number): string {
  return `${originLat.toFixed(4)},${originLng.toFixed(4)}:${destLat.toFixed(4)},${destLng.toFixed(4)}`;
}

function setCache(key: string, data: DirectionsResult): void {
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function haversineFallback(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number
): DirectionsResult {
  const remainingDistanceKm = haversineKm(originLat, originLng, destLat, destLng);
  const speed = env.AVG_TRAVEL_SPEED_KMH > 0 ? env.AVG_TRAVEL_SPEED_KMH : 25;
  const meters = Math.round(remainingDistanceKm * 1000);
  const etaMinutes = Math.max(1, Math.round((remainingDistanceKm / speed) * 60));
  return {
    remainingDistanceKm,
    etaMinutes,
    encodedPolyline: null,
    distanceMeters: meters,
    durationSeconds: etaMinutes * 60,
    source: 'HAVERSINE',
  };
}

export async function getDrivingDirections(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number
): Promise<DirectionsResult> {
  if (
    !isValidCoordinate(originLat, originLng) ||
    !isValidCoordinate(destLat, destLng)
  ) {
    return { remainingDistanceKm: 0, etaMinutes: 0, encodedPolyline: null, source: 'HAVERSINE' };
  }

  const key = cacheKey(originLat, originLng, destLat, destLng);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const fallback = haversineFallback(originLat, originLng, destLat, destLng);
  const apiKey = env.GOOGLE_MAPS_API_KEY;

  if (apiKey) {
    try {
      const url =
        `https://maps.googleapis.com/maps/api/directions/json` +
        `?origin=${originLat},${originLng}` +
        `&destination=${destLat},${destLng}` +
        `&mode=driving&region=in&key=${apiKey}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const data = await response.json();
      const leg = data?.routes?.[0]?.legs?.[0];
      const polyline = data?.routes?.[0]?.overview_polyline?.points || null;
      if (data?.status === 'OK' && leg && polyline) {
        const meters = Number(leg.distance?.value) || 0;
        const seconds = Number(leg.duration?.value) || 0;
        const result: DirectionsResult = {
          remainingDistanceKm: Math.round((meters / 1000) * 10) / 10,
          etaMinutes: Math.max(1, Math.round(seconds / 60)),
          encodedPolyline: polyline,
          distanceMeters: meters,
          durationSeconds: seconds,
          source: 'GOOGLE_DIRECTIONS',
        };
        setCache(key, result);
        return result;
      }
      logger.warn(
        { status: data?.status, errorMessage: data?.error_message },
        'Google Directions returned no usable road polyline'
      );
    } catch (err) {
      logger.warn({ err }, 'Google Directions lookup failed');
    }
  }

  // OSRM road geometry fallback (follows streets even when Google key is missing/denied).
  try {
    const osrmUrl =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${originLng},${originLat};${destLng},${destLat}` +
      `?overview=full&geometries=polyline`;
    const response = await fetch(osrmUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const data = await response.json();
    const route = data?.routes?.[0];
    const polyline = typeof route?.geometry === 'string' ? route.geometry : null;
    if (data?.code === 'Ok' && route && polyline) {
      const meters = Number(route.distance) || 0;
      const seconds = Number(route.duration) || 0;
      const result: DirectionsResult = {
        remainingDistanceKm: Math.round((meters / 1000) * 10) / 10,
        etaMinutes: Math.max(1, Math.round(seconds / 60)),
        encodedPolyline: polyline,
        distanceMeters: meters,
        durationSeconds: seconds,
        source: 'OSRM',
      };
      setCache(key, result);
      return result;
    }
  } catch (err) {
    logger.warn({ err }, 'OSRM Directions lookup failed; using haversine fallback');
  }

  setCache(key, fallback);
  return fallback;
}
