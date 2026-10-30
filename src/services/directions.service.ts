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
const FETCH_TIMEOUT_MS = 4000;

export interface DirectionsResult {
  remainingDistanceKm: number;
  etaMinutes: number;
  encodedPolyline: string | null;
  source: 'GOOGLE_DIRECTIONS' | 'HAVERSINE';
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
  return {
    remainingDistanceKm,
    etaMinutes: Math.max(1, Math.round((remainingDistanceKm / speed) * 60)),
    encodedPolyline: null,
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
  if (!apiKey) {
    setCache(key, fallback);
    return fallback;
  }

  try {
    const url =
      `https://maps.googleapis.com/maps/api/directions/json` +
      `?origin=${originLat},${originLng}` +
      `&destination=${destLat},${destLng}` +
      `&mode=driving&region=in&key=${apiKey}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const data = await response.json();
    const leg = data?.routes?.[0]?.legs?.[0];
    if (data?.status !== 'OK' || !leg) {
      setCache(key, fallback);
      return fallback;
    }

    const meters = Number(leg.distance?.value) || 0;
    const seconds = Number(leg.duration?.value) || 0;
    const result: DirectionsResult = {
      remainingDistanceKm: Math.round((meters / 1000) * 10) / 10,
      etaMinutes: Math.max(1, Math.round(seconds / 60)),
      encodedPolyline: data.routes[0]?.overview_polyline?.points || null,
      source: 'GOOGLE_DIRECTIONS',
    };
    setCache(key, result);
    return result;
  } catch (err) {
    logger.warn({ err }, 'Google Directions lookup failed; using haversine fallback');
    setCache(key, fallback);
    return fallback;
  }
}
