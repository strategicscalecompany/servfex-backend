import { Router, Request, Response } from 'express';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { authenticate } from '../middleware/auth';

const router = Router();

// Protect all Geo endpoints from unauthenticated access (Finding F-08)
router.use(authenticate);

// Configurable bounded timeout for all outgoing geo queries (Google Maps & OSM)
const GEO_FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECT_HOPS = 3;
const MAX_BODY_BYTES = 65536; // 64 KB max body reading for meta tag inspection

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

interface ValidatedMapsUrl {
  valid: boolean;
  error?: string;
  url?: URL;
  unwrappedUrl?: URL;
}

/**
 * Validates that a host belongs to an authorized Google Maps domain.
 * Supports:
 *  - Short links: maps.app.goo.gl, goo.gl
 *  - Core Google Maps hosts: maps.google.com, www.google.com, google.com
 *  - Country code TLDs: www.google.se, maps.google.se, www.google.co.in, www.google.at, etc.
 *  - Consent hosts (EU GDPR redirects from EU servers): consent.google.com, consent.google.se, etc.
 */
function isApprovedGoogleHost(host: string): boolean {
  if (/^(?:maps\.app\.)?goo\.gl$/i.test(host)) {
    return true;
  }
  return /^(?:(?:www|maps|consent)\.)?google\.(?:com|[a-z]{2,3}(?:\.[a-z]{2})?)$/i.test(host);
}

/**
 * Validates that an incoming URL strictly targets legitimate Google Maps domains.
 * Rejects private IPs, loopback, non-HTTPS protocols, embedded credentials, and arbitrary ports.
 */
function validateGoogleMapsUrl(rawUrl: string): ValidatedMapsUrl {
  try {
    const parsed = new URL(rawUrl);

    // 1. Require strictly HTTPS
    if (parsed.protocol !== 'https:') {
      return { valid: false, error: 'Only HTTPS Google Maps URLs are permitted' };
    }

    // 2. Reject credentials in URL (user:pass@...)
    if (parsed.username || parsed.password) {
      return { valid: false, error: 'Embedded credentials are not permitted in URLs' };
    }

    // 3. Reject non-standard ports
    if (parsed.port && parsed.port !== '443') {
      return { valid: false, error: 'Non-standard ports are not permitted' };
    }

    // Normalize hostname: lowercase and strip trailing dots
    const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');

    // 4. Reject IP addresses (IPv4, decimal/hex/octal representations, IPv6), localhost, and link-local destinations
    if (
      host === 'localhost' ||
      /^(\d{1,3}\.){3}\d{1,3}$/.test(host) ||
      host.startsWith('[') ||
      host.endsWith(']') ||
      host.includes(':') ||
      /^\d+$/.test(host) ||
      /^0x[0-9a-f]+$/i.test(host)
    ) {
      return { valid: false, error: 'IP addresses and localhost are not permitted' };
    }

    // 5. Hostname must match the approved Google domains pattern
    if (!isApprovedGoogleHost(host)) {
      return { valid: false, error: 'Domain is not an approved Google Maps host' };
    }

    // 6. Handle Google EU consent redirects (consent.google.*)
    if (host.startsWith('consent.google.')) {
      const continueParam = parsed.searchParams.get('continue') || parsed.searchParams.get('next');
      if (!continueParam) {
        return { valid: false, error: 'Consent redirect missing continue parameter' };
      }
      const continueValidation = validateGoogleMapsUrl(continueParam);
      if (!continueValidation.valid) {
        return { valid: false, error: `Disallowed consent destination: ${continueValidation.error}` };
      }
      return { valid: true, url: parsed, unwrappedUrl: continueValidation.url };
    }

    // 7. For goo.gl, path should point to /maps (unless maps.app.goo.gl)
    if (host === 'goo.gl' && !parsed.pathname.startsWith('/maps')) {
      return { valid: false, error: 'goo.gl link must point to /maps' };
    }

    // 8. For broad Google domains, pathname must begin with /maps, /search, /place, or /url (unless maps.google.*)
    if (!host.startsWith('maps.google.') && host !== 'maps.app.goo.gl' && host !== 'goo.gl') {
      const p = parsed.pathname.toLowerCase();
      if (
        !p.startsWith('/maps') &&
        !p.startsWith('/search') &&
        !p.startsWith('/place') &&
        !p.startsWith('/url')
      ) {
        return { valid: false, error: 'Google URL path must point to maps, search, or place' };
      }
    }

    return { valid: true, url: parsed };
  } catch {
    return { valid: false, error: 'Malformed URL' };
  }
}

/**
 * Safely reads at most maxBytes from a response body stream.
 * Cancels the reader immediately if maxBytes is reached to prevent memory exhaustion or hanging streams.
 */
async function readBoundedText(res: any, maxBytes: number = MAX_BODY_BYTES): Promise<string> {
  if (!res.body) return '';
  if (typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (totalBytes < maxBytes) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        const take = Math.min(value.byteLength, maxBytes - totalBytes);
        chunks.push(value.subarray(0, take));
        totalBytes += take;
        if (totalBytes >= maxBytes) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await res.text();
  return text.slice(0, maxBytes);
}

/**
 * GET /api/v1/geo/geocode
 * Search locations using Google Maps Geocoding API (with fallback format)
 */
router.get('/geocode', async (req: Request, res: Response): Promise<void> => {
  const query = (req.query.query as string) || (req.query.address as string);
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
    const response = await fetch(url, {
      signal: AbortSignal.timeout(GEO_FETCH_TIMEOUT_MS),
    });
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
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      res.status(504).json({ success: false, error: { code: 'UPSTREAM_TIMEOUT', message: 'Geocoding service timed out' } });
      return;
    }
    logger.error({ err }, 'Google Maps Geocode proxy error');
    res.status(500).json({ success: false, error: { code: 'GEOCODE_ERROR', message: 'Geocoding failed' } });
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
    const response = await fetch(url, {
      signal: AbortSignal.timeout(GEO_FETCH_TIMEOUT_MS),
    });
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
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      res.status(504).json({ success: false, error: { code: 'UPSTREAM_TIMEOUT', message: 'Geocoding service timed out' } });
      return;
    }
    logger.error({ err }, 'Google Maps Reverse Geocode proxy error');
    res.status(500).json({ success: false, error: { code: 'REVERSE_GEOCODE_ERROR', message: 'Reverse geocoding failed' } });
  }
});

/**
 * POST /api/v1/geo/resolve-maps-url
 * Resolves any Google Maps URL (short links, place links, coordinate links) to exact lat, lng, and formatted address
 */
router.post('/resolve-maps-url', async (req: Request, res: Response): Promise<void> => {
  const rawInput = req.body?.url;
  if (!rawInput || typeof rawInput !== 'string' || !rawInput.trim()) {
    res.status(400).json({ success: false, error: { code: 'INVALID_URL', message: 'Google Maps location URL or coordinates are required' } });
    return;
  }

  const cleanInput = rawInput.trim();

  // Create an overall request deadline controller to strictly bound total execution across redirects and geocoding
  const overallController = new AbortController();
  const overallTimer = setTimeout(() => overallController.abort(), GEO_FETCH_TIMEOUT_MS);

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
      if (!urlMatch) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_URL', message: 'A valid Google Maps HTTPS URL or coordinate pair is required' },
        });
        return;
      }

      const initialUrl = urlMatch[0];
      const initialValidation = validateGoogleMapsUrl(initialUrl);
      if (!initialValidation.valid) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_URL', message: initialValidation.error || 'Disallowed destination URL' },
        });
        return;
      }

      resolvedUrl = initialUrl;
      let htmlBody = '';
      let currentHopUrl = initialUrl;
      const visitedHops = new Set<string>();
      let hops = 0;

      // Follow redirect manually only for approved short link domains (maps.app.goo.gl or goo.gl)
      const isShortLink =
        initialValidation.url?.hostname.toLowerCase().replace(/\.+$/, '') === 'maps.app.goo.gl' ||
        initialValidation.url?.hostname.toLowerCase().replace(/\.+$/, '') === 'goo.gl';

      if (isShortLink) {
        while (hops < MAX_REDIRECT_HOPS) {
          visitedHops.add(currentHopUrl);
          hops++;

          try {
            const hopResp = await fetch(currentHopUrl, {
              method: 'GET',
              redirect: 'manual',
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cookie': 'SOCS=CAESHAgBEhJnd3NfMjAyMzA4MTAtMF9SQzIaAmVuIAEaBgiAo_CmBg; CONSENT=YES+',
              },
              signal: overallController.signal,
            });

            if (hopResp.status >= 300 && hopResp.status < 400) {
              const loc = hopResp.headers.get('location');
              if (!loc) break;

              let nextUrlStr: string;
              try {
                nextUrlStr = new URL(loc, currentHopUrl).toString();
              } catch {
                res.status(400).json({ success: false, error: { code: 'INVALID_URL', message: 'Redirect location header is malformed' } });
                return;
              }

              const nextValidation = validateGoogleMapsUrl(nextUrlStr);
              if (!nextValidation.valid) {
                res.status(400).json({
                  success: false,
                  error: { code: 'INVALID_URL', message: `Disallowed redirect destination: ${nextValidation.error}` },
                });
                return;
              }

              // If redirected to EU consent, automatically unwrap the continue target URL
              if (nextValidation.unwrappedUrl) {
                nextUrlStr = nextValidation.unwrappedUrl.toString();
              }

              if (visitedHops.has(nextUrlStr)) {
                res.status(400).json({ success: false, error: { code: 'INVALID_URL', message: 'Redirect loop detected' } });
                return;
              }

              currentHopUrl = nextUrlStr;
              resolvedUrl = nextUrlStr;

              // If the resolved URL already contains coordinates, terminate hops early
              const hasCoords =
                /\/search\/(-?\d{1,2}\.\d+)[,\s+]+(-?\d{1,3}\.\d+)/i.test(nextUrlStr) ||
                /\/place\/(-?\d{1,2}\.\d+)[,\s+]+(-?\d{1,3}\.\d+)/i.test(nextUrlStr) ||
                /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.test(nextUrlStr) ||
                /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/.test(nextUrlStr) ||
                /[?&](?:q|ll|query|daddr|saddr|center|point)=(-?\d{1,2}\.\d+)[,\s+]+(-?\d{1,3}\.\d+)/i.test(nextUrlStr);

              if (hasCoords) {
                break;
              }
            } else if (hopResp.status === 200) {
              // Bounded body read (max 64KB) to prevent memory exhaustion DoS
              htmlBody = await readBoundedText(hopResp, MAX_BODY_BYTES);
              break;
            } else {
              break;
            }
          } catch (redirectErr: any) {
            if (redirectErr?.name === 'TimeoutError' || redirectErr?.name === 'AbortError' || overallController.signal.aborted) {
              res.status(504).json({ success: false, error: { code: 'UPSTREAM_TIMEOUT', message: 'Short link resolution timed out' } });
              return;
            }
            logger.warn({ redirectErr }, 'Failed to follow short link redirect');
            break;
          }
        }
      }

      // Check all patterns across resolved URL, raw target URL, and URL-decoded strings
      const urlsToTest = [
        resolvedUrl,
        decodeURIComponent(resolvedUrl),
        decodeURIComponent(resolvedUrl.replace(/\+/g, ' ')),
        initialUrl,
        decodeURIComponent(initialUrl),
      ];

      for (const raw of [resolvedUrl, initialUrl]) {
        try {
          const uObj = new URL(raw);
          const cont = uObj.searchParams.get('continue') || uObj.searchParams.get('next');
          if (cont) {
            urlsToTest.push(cont, decodeURIComponent(cont), decodeURIComponent(cont.replace(/\+/g, ' ')));
          }
        } catch {
          // ignore URL parsing error
        }
      }

      for (const u of urlsToTest) {
        if (lat !== null && lng !== null) break;

        // Pattern 1: /search/lat,+lng or /search/lat,lng (Dropping pins / open coordinates in Google Maps)
        const searchMatch = u.match(/\/search\/(-?\d{1,2}\.\d+)[,\s+]+(-?\d{1,3}\.\d+)/i);
        if (searchMatch) {
          lat = parseFloat(searchMatch[1]);
          lng = parseFloat(searchMatch[2]);
          break;
        }

        // Pattern 2: /place/lat,+lng or /place/lat,lng
        const placeCoordMatch = u.match(/\/place\/(-?\d{1,2}\.\d+)[,\s+]+(-?\d{1,3}\.\d+)/i);
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

      // If coordinates still not found and placeName is known, geocode the placeName with timeout
      if ((lat === null || lng === null) && placeName) {
        const apiKey = env.GOOGLE_MAPS_API_KEY;
        if (apiKey) {
          try {
            const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(placeName)}&region=in&key=${apiKey}`;
            const geoResp = await fetch(geoUrl, {
              signal: overallController.signal,
            });
            const geoData = await geoResp.json();
            if (geoData.status === 'OK' && geoData.results?.[0]) {
              lat = geoData.results[0].geometry.location.lat;
              lng = geoData.results[0].geometry.location.lng;
            }
          } catch (geoErr: any) {
            if (geoErr?.name === 'TimeoutError' || geoErr?.name === 'AbortError' || overallController.signal.aborted) {
              res.status(504).json({ success: false, error: { code: 'UPSTREAM_TIMEOUT', message: 'Geocoding service timed out' } });
              return;
            }
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
        const revResp = await fetch(revUrl, {
          signal: overallController.signal,
        });
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
      } catch (revErr: any) {
        if (revErr?.name === 'TimeoutError' || revErr?.name === 'AbortError' || overallController.signal.aborted) {
          res.status(504).json({ success: false, error: { code: 'UPSTREAM_TIMEOUT', message: 'Geocoding service timed out' } });
          return;
        }
        logger.warn({ revErr }, 'Reverse geocode failed');
      }
    } else {
      try {
        const nomRevUrl = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`;
        const nomRevResp = await fetch(nomRevUrl, {
          headers: { 'User-Agent': 'ServFex-Platform/1.0' },
          signal: overallController.signal,
        });
        const nomRevData = await nomRevResp.json();
        if (nomRevData?.display_name) {
          formattedAddress = nomRevData.display_name;
        }
      } catch (nomErr: any) {
        if (nomErr?.name === 'TimeoutError' || nomErr?.name === 'AbortError' || overallController.signal.aborted) {
          res.status(504).json({ success: false, error: { code: 'UPSTREAM_TIMEOUT', message: 'Geocoding service timed out' } });
          return;
        }
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
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || overallController.signal.aborted) {
      res.status(504).json({ success: false, error: { code: 'UPSTREAM_TIMEOUT', message: 'Geocoding service timed out' } });
      return;
    }
    logger.error({ err }, 'Failed to resolve Google Maps URL');
    res.status(500).json({
      success: false,
      error: { code: 'RESOLVE_ERROR', message: 'Failed to resolve Google Maps URL' },
    });
  } finally {
    clearTimeout(overallTimer);
  }
});

export default router;
