import { Router, Request, Response } from 'express';
import { env } from '../config/env';
import { logger } from '../config/logger';

const router = Router();

// In-memory bounded cache for high-frequency geocoding queries
interface GeoCacheEntry {
  data: any;
  expiresAt: number;
}
const geoCache = new Map<string, GeoCacheEntry>();
const MAX_GEO_CACHE = 1000;
const GEO_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const getCachedGeo = (key: string): any | null => {
  const entry = geoCache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.data;
  }
  if (entry) geoCache.delete(key);
  return null;
};

const setCachedGeo = (key: string, data: any, ttlMs = GEO_CACHE_TTL_MS): void => {
  if (geoCache.size >= MAX_GEO_CACHE) {
    const firstKey = geoCache.keys().next().value;
    if (firstKey) geoCache.delete(firstKey);
  }
  geoCache.set(key, { data, expiresAt: Date.now() + ttlMs });
};

/**
 * GET /api/v1/geo/geocode
 * Search locations using Google Maps Geocoding API (with fallback format)
 */
router.get('/geocode', async (req: Request, res: Response): Promise<void> => {
  const query = req.query.query as string || req.query.address as string;
  if (!query || !query.trim()) {
    res.status(400).json({ success: false, error: { code: 'INVALID_QUERY', message: 'Address query is required' } });
    return;
  }

  const cleanQuery = query.trim().toLowerCase();
  const cacheKey = `geo:${cleanQuery}`;
  const cached = getCachedGeo(cacheKey);
  if (cached) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).json({ success: true, data: cached });
    return;
  }

  const apiKey = env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    res.status(503).json({ success: false, error: { code: 'KEY_NOT_CONFIGURED', message: 'Google Maps API key is not configured' } });
    return;
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query.trim())}&region=in&key=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status === 'OK' && data.results) {
      const results = data.results.map((item: any) => ({
        formatted_address: item.formatted_address,
        lat: item.geometry.location.lat,
        lng: item.geometry.location.lng,
        place_id: item.place_id,
        address_components: item.address_components,
      }));

      setCachedGeo(cacheKey, results);
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.status(200).json({ success: true, data: results });
      return;
    }

    res.status(200).json({ success: true, data: [], status: data.status, message: data.error_message });
  } catch (err: any) {
    logger.error({ err }, 'Google Maps Geocode proxy error');
    res.status(500).json({ success: false, error: { code: 'GEOCODE_ERROR', message: err.message || 'Geocoding failed' } });
  }
});

/**
 * GET /api/v1/geo/reverse
 * Reverse geocode lat,lng using Google Maps Geocoding API
 */
router.get('/reverse', async (req: Request, res: Response): Promise<void> => {
  const lat = req.query.lat as string;
  const lng = req.query.lng as string;

  if (!lat || !lng) {
    res.status(400).json({ success: false, error: { code: 'INVALID_COORDINATES', message: 'Both lat and lng query params are required' } });
    return;
  }

  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  if (isNaN(latNum) || isNaN(lngNum)) {
    res.status(400).json({ success: false, error: { code: 'INVALID_COORDINATES', message: 'Coordinates must be valid numbers' } });
    return;
  }

  // Cache by ~11m precision
  const cacheKey = `rev:${latNum.toFixed(4)}:${lngNum.toFixed(4)}`;
  const cached = getCachedGeo(cacheKey);
  if (cached) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).json({ success: true, data: cached });
    return;
  }

  const apiKey = env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    res.status(503).json({ success: false, error: { code: 'KEY_NOT_CONFIGURED', message: 'Google Maps API key is not configured' } });
    return;
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latNum},${lngNum}&key=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status === 'OK' && data.results && data.results.length > 0) {
      const first = data.results[0];
      const resultData = {
        formatted_address: first.formatted_address,
        lat: latNum,
        lng: lngNum,
        place_id: first.place_id,
        address_components: first.address_components,
      };

      setCachedGeo(cacheKey, resultData);
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.status(200).json({
        success: true,
        data: resultData,
      });
      return;
    }

    res.status(200).json({ success: true, data: null, status: data.status, message: data.error_message });
  } catch (err: any) {
    logger.error({ err }, 'Google Maps Reverse Geocode proxy error');
    res.status(500).json({ success: false, error: { code: 'REVERSE_GEOCODE_ERROR', message: err.message || 'Reverse geocoding failed' } });
  }
});

/**
 * POST /api/v1/geo/resolve-maps-url
 * Resolves any Google Maps URL (short links, place links, coordinate links) to exact lat, lng, and formatted address
 */
router.post('/resolve-maps-url', async (req: Request, res: Response): Promise<void> => {
  const rawInput = req.body.url;
  if (!rawInput || typeof rawInput !== 'string' || !rawInput.trim()) {
    res.status(400).json({ success: false, error: { code: 'INVALID_URL', message: 'Google Maps location URL or coordinates are required' } });
    return;
  }

  const cleanInput = rawInput.trim();

  try {
    let lat: number | null = null;
    let lng: number | null = null;
    let placeName: string | null = null;
    let resolvedUrl = cleanInput;

    // Direct check: User pasted raw coordinates like "17.499593, 78.604902" or "17.499593,78.604902"
    const directCoordsMatch = cleanInput.match(/^(-?\d{1,2}\.\d+)[,\s]+(?:\+)?(-?\d{1,3}\.\d+)$/);
    if (directCoordsMatch) {
      lat = parseFloat(directCoordsMatch[1]);
      lng = parseFloat(directCoordsMatch[2]);
    }

    if (lat === null || lng === null) {
      const urlMatch = cleanInput.match(/https?:\/\/[^\s"'<>]+/i);
      const targetUrl = urlMatch ? urlMatch[0] : cleanInput;
      resolvedUrl = targetUrl;
      let htmlBody = '';

      // Follow redirect if short link (e.g. maps.app.goo.gl or goo.gl/maps)
      if (targetUrl.includes('goo.gl') || targetUrl.includes('maps.app.goo.gl')) {
        try {
          // Check manual redirect first to get clean Location header
          const manualResp = await fetch(targetUrl, {
            method: 'GET',
            redirect: 'manual',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
          });
          const locationHeader = manualResp.headers.get('location');
          if (locationHeader) {
            resolvedUrl = locationHeader;
          }

          // Follow redirect all the way
          const headResp = await fetch(targetUrl, {
            method: 'GET',
            redirect: 'follow',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
          });
          if (headResp.url) {
            resolvedUrl = headResp.url;
          }
          htmlBody = await headResp.text();
        } catch (redirectErr) {
          logger.warn({ redirectErr }, 'Failed to follow short link redirect');
        }
      }

      // Check all patterns across resolved URL, raw target URL, and URL-decoded strings
      const urlsToTest = [
        resolvedUrl,
        decodeURIComponent(resolvedUrl),
        decodeURIComponent(resolvedUrl.replace(/\+/g, ' ')),
        targetUrl,
        decodeURIComponent(targetUrl),
      ];

      for (const u of urlsToTest) {
        if (lat !== null && lng !== null) break;

        // Pattern 1: /search/lat,+lng or /search/lat,lng (Dropping pins / open coordinates in Google Maps)
        const searchMatch = u.match(/\/search\/(-?\d{1,2}\.\d+)[,\s]+(?:\+)?(-?\d{1,3}\.\d+)/i);
        if (searchMatch) {
          lat = parseFloat(searchMatch[1]);
          lng = parseFloat(searchMatch[2]);
          break;
        }

        // Pattern 2: /place/lat,+lng or /place/lat,lng
        const placeCoordMatch = u.match(/\/place\/(-?\d{1,2}\.\d+)[,\s]+(?:\+)?(-?\d{1,3}\.\d+)/i);
        if (placeCoordMatch) {
          lat = parseFloat(placeCoordMatch[1]);
          lng = parseFloat(placeCoordMatch[2]);
          break;
        }

        // Pattern 3: @lat,lng
        const atMatch = u.match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/);
        if (atMatch) {
          lat = parseFloat(atMatch[1]);
          lng = parseFloat(atMatch[2]);
          break;
        }

        // Pattern 4: !3dlat!4dlng (high precision Google Place pin coordinates)
        const dataMatch = u.match(/!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/);
        if (dataMatch) {
          lat = parseFloat(dataMatch[1]);
          lng = parseFloat(dataMatch[2]);
          break;
        }

        // Pattern 5: query/q/ll/daddr/saddr/center/point=lat,lng
        const qMatch = u.match(/[?&](?:q|ll|query|daddr|saddr|center|point)=(-?\d{1,2}\.\d+)[,\s]+(?:\+)?(-?\d{1,3}\.\d+)/i);
        if (qMatch) {
          lat = parseFloat(qMatch[1]);
          lng = parseFloat(qMatch[2]);
          break;
        }
      }

      // Extract named place if present
      const placeMatch = resolvedUrl.match(/\/place\/([^/@?]+)/);
      if (placeMatch) {
        const decoded = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
        if (!decoded.match(/^-?\d{1,2}\.\d+/)) {
          placeName = decoded;
        }
      }

      // Pattern 6: Fallback to HTML body meta image or staticmap center
      if ((lat === null || lng === null) && htmlBody) {
        const staticMapMatch = htmlBody.match(/staticmap\?[^"']*center=(-?\d{1,2}\.\d+)(?:%2C|,)(-?\d{1,3}\.\d+)/i);
        if (staticMapMatch) {
          lat = parseFloat(staticMapMatch[1]);
          lng = parseFloat(staticMapMatch[2]);
        } else {
          const bodySearchMatch = htmlBody.match(/\/maps\/search\/(-?\d{1,2}\.\d+)(?:%2C|,|\+)+(-?\d{1,3}\.\d+)/i);
          if (bodySearchMatch) {
            lat = parseFloat(bodySearchMatch[1]);
            lng = parseFloat(bodySearchMatch[2]);
          }
        }
      }

      // If coordinates still not found and placeName is known, geocode the placeName
      if ((lat === null || lng === null) && placeName) {
        const apiKey = env.GOOGLE_MAPS_API_KEY;
        if (apiKey) {
          try {
            const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(placeName)}&region=in&key=${apiKey}`;
            const geoResp = await fetch(geoUrl);
            const geoData = await geoResp.json();
            if (geoData.status === 'OK' && geoData.results?.[0]) {
              lat = geoData.results[0].geometry.location.lat;
              lng = geoData.results[0].geometry.location.lng;
            }
          } catch (geoErr) {
            logger.warn({ geoErr }, 'Geocode place name failed');
          }
        }
      }
    }

    if (lat === null || lng === null) {
      res.status(422).json({
        success: false,
        error: {
          code: 'COORDINATES_NOT_FOUND',
          message: 'Could not extract geographic coordinates from this Google Maps link. Please verify the URL or enter address directly.',
        },
      });
      return;
    }

    // Reverse geocode to get formatted address and neighborhood / area
    let formattedAddress = placeName || '';
    const apiKey = env.GOOGLE_MAPS_API_KEY;
    if (apiKey) {
      try {
        const revUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`;
        const revResp = await fetch(revUrl);
        const revData = await revResp.json();
        if (revData.status === 'OK' && revData.results?.[0]) {
          formattedAddress = revData.results[0].formatted_address;
          if (!placeName) {
            // Find a friendly sublocality or neighborhood name from components
            const sublocality = revData.results[0].address_components?.find((c: any) =>
              c.types.includes('sublocality_level_1') || c.types.includes('sublocality') || c.types.includes('neighborhood')
            );
            if (sublocality) {
              placeName = sublocality.long_name;
            } else {
              placeName = formattedAddress.split(',')[0];
            }
          }
        }
      } catch (revErr) {
        logger.warn({ revErr }, 'Reverse geocode failed');
      }
    } else {
      try {
        const nomRevUrl = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`;
        const nomRevResp = await fetch(nomRevUrl, { headers: { 'User-Agent': 'ServFex-Platform/1.0' } });
        const nomRevData = await nomRevResp.json();
        if (nomRevData?.display_name) {
          formattedAddress = nomRevData.display_name;
        }
      } catch (nomErr) {
        logger.warn({ nomErr }, 'Nominatim reverse geocode failed');
      }
    }

    res.status(200).json({
      success: true,
      data: {
        lat,
        lng,
        formattedAddress: formattedAddress || `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
        placeName: placeName || 'Warehouse Depot',
        resolvedUrl,
      },
    });
  } catch (err: any) {
    logger.error({ err }, 'Failed to resolve Google Maps URL');
    res.status(500).json({
      success: false,
      error: { code: 'RESOLVE_ERROR', message: err.message || 'Failed to resolve Google Maps URL' },
    });
  }
});

export default router;
