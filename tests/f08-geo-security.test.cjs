const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');

// Load compiled production modules from dist/
const { env } = require(path.join(__dirname, '..', 'dist', 'src', 'config', 'env.js'));
const { prisma } = require(path.join(__dirname, '..', 'dist', 'src', 'config', 'prisma.js'));
const geoRoutes = require(path.join(__dirname, '..', 'dist', 'src', 'routes', 'geo.routes.js')).default;

// Create a standalone express app mounting the geo routes
function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/geo', geoRoutes);
  return app;
}

// Helper to generate test JWT tokens
function createTestToken(payload, options = {}) {
  return jwt.sign(
    {
      userId: payload.userId || 'usr_test_geo_123',
      role: payload.role || 'CUSTOMER',
      email: payload.email || 'geo.test@servfex.test',
    },
    env.JWT_SECRET,
    { expiresIn: '1h', ...options }
  );
}

// Mock Prisma user lookup for authenticated routes
const originalFindUnique = prisma.user.findUnique;
function setupPrismaMock(userObj = null) {
  prisma.user.findUnique = async ({ where }) => {
    if (userObj !== null) return userObj;
    return {
      id: where.id || 'usr_test_geo_123',
      email: 'geo.test@servfex.test',
      role: 'CUSTOMER',
      status: 'ACTIVE',
      firebaseUid: 'fb_geo_123',
      deletedAt: null,
    };
  };
}
function restorePrismaMock() {
  prisma.user.findUnique = originalFindUnique;
}

// Test Suite
test('F-08 Geo API Security Hardening & Adversarial Review', async (t) => {
  const app = createTestApp();
  let server;
  let baseUrl;

  // Start in-memory server
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  t.after(() => {
    server.close();
    restorePrismaMock();
  });

  // =========================================================================
  // 1. Authentication Tests
  // =========================================================================
  await t.test('1.1 Anonymous GET /geocode is rejected with 401 UNAUTHORIZED', async () => {
    const res = await fetch(`${baseUrl}/api/v1/geo/geocode?query=Bengaluru`);
    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.error.code, 'UNAUTHORIZED');
  });

  await t.test('1.2 Anonymous GET /reverse is rejected with 401 UNAUTHORIZED', async () => {
    const res = await fetch(`${baseUrl}/api/v1/geo/reverse?lat=12.9716&lng=77.5946`);
    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.error.code, 'UNAUTHORIZED');
  });

  await t.test('1.3 Anonymous POST /resolve-maps-url is rejected with 401 UNAUTHORIZED', async () => {
    const res = await fetch(`${baseUrl}/api/v1/geo/resolve-maps-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: '17.499593, 78.604902' }),
    });
    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.error.code, 'UNAUTHORIZED');
  });

  await t.test('1.4 Malformed / Invalid Bearer token is rejected with 401', async () => {
    const res = await fetch(`${baseUrl}/api/v1/geo/geocode?query=Bengaluru`, {
      headers: { Authorization: 'Bearer this.is.invalid' },
    });
    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.ok(body.error.code === 'UNAUTHORIZED' || body.error.code === 'INVALID_TOKEN');
  });

  await t.test('1.5 Expired JWT token is rejected with 401 TOKEN_EXPIRED', async () => {
    const expiredToken = createTestToken({}, { expiresIn: '-1s' });
    const res = await fetch(`${baseUrl}/api/v1/geo/geocode?query=Bengaluru`, {
      headers: { Authorization: `Bearer ${expiredToken}` },
    });
    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.error.code, 'TOKEN_EXPIRED');
  });

  await t.test('1.6 Rejected unauthenticated requests do not execute outbound fetch', async () => {
    let fetchCalled = false;
    const origFetch = global.fetch;
    global.fetch = async (...args) => {
      if (typeof args[0] === 'string' && args[0].startsWith(baseUrl)) {
        return origFetch(...args);
      }
      fetchCalled = true;
      return origFetch(...args);
    };

    try {
      const res = await origFetch(`${baseUrl}/api/v1/geo/geocode?query=Delhi`);
      assert.strictEqual(res.status, 401);
      assert.strictEqual(fetchCalled, false, 'External fetch must NOT be invoked on rejected requests');
    } finally {
      global.fetch = origFetch;
    }
  });

  // =========================================================================
  // 2. SSRF Protection Tests (resolve-maps-url)
  // =========================================================================
  await t.test('2.1 Rejects AWS / Cloud Metadata endpoint (http://169.254.169.254)', async () => {
    setupPrismaMock();
    const token = createTestToken({});
    const res = await fetch(`${baseUrl}/api/v1/geo/resolve-maps-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.error.code, 'INVALID_URL');
  });

  await t.test('2.2 Rejects localhost and loopback destinations', async () => {
    setupPrismaMock();
    const token = createTestToken({});
    const targets = [
      'http://localhost:5000/internal',
      'https://localhost/admin',
      'http://127.0.0.1:8080/metrics',
      'http://127.0.0.1/',
    ];

    for (const target of targets) {
      const res = await fetch(`${baseUrl}/api/v1/geo/resolve-maps-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: target }),
      });
      assert.strictEqual(res.status, 400, `Expected 400 for ${target}`);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'INVALID_URL');
    }
  });

  await t.test('2.3 Rejects private RFC 1918 IP addresses', async () => {
    setupPrismaMock();
    const token = createTestToken({});
    const privateIps = [
      'http://10.0.0.1/secret',
      'https://172.16.0.5/api',
      'http://192.168.1.100:3000/status',
    ];

    for (const ipUrl of privateIps) {
      const res = await fetch(`${baseUrl}/api/v1/geo/resolve-maps-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: ipUrl }),
      });
      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'INVALID_URL');
    }
  });

  await t.test('2.4 Rejects misleading domains (e.g. google.com.attacker.example)', async () => {
    setupPrismaMock();
    const token = createTestToken({});
    const deceptiveUrls = [
      'https://google.com.attacker.example/maps',
      'https://maps.google.com.evil.org/search',
      'https://attacker-google.com/maps',
    ];

    for (const dUrl of deceptiveUrls) {
      const res = await fetch(`${baseUrl}/api/v1/geo/resolve-maps-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: dUrl }),
      });
      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'INVALID_URL');
    }
  });

  await t.test('2.5 Rejects embedded credentials, non-standard ports, and non-HTTPS schemes', async () => {
    setupPrismaMock();
    const token = createTestToken({});
    const badUrls = [
      'https://admin:pass123@maps.google.com/maps',
      'https://maps.google.com:8443/maps',
      'ftp://maps.google.com/maps',
      'http://maps.google.com/maps',
    ];

    for (const bUrl of badUrls) {
      const res = await fetch(`${baseUrl}/api/v1/geo/resolve-maps-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: bUrl }),
      });
      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'INVALID_URL');
    }
  });

  await t.test('2.6 Rejects short-link redirect pointing to disallowed host', async () => {
    setupPrismaMock();
    const token = createTestToken({});
    const origFetch = global.fetch;

    global.fetch = async (...args) => {
      const url = args[0];
      if (typeof url === 'string' && url.startsWith(baseUrl)) {
        return origFetch(...args);
      }
      return new Response('', {
        status: 302,
        headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
      });
    };

    try {
      const res = await origFetch(`${baseUrl}/api/v1/geo/resolve-maps-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: 'https://maps.app.goo.gl/malicious_redirect' }),
      });
      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'INVALID_URL');
      assert.match(body.error.message, /Disallowed redirect destination/);
    } finally {
      global.fetch = origFetch;
    }
  });

  await t.test('2.7 Rejects short-link redirect pointing to private IP or loopback', async () => {
    setupPrismaMock();
    const token = createTestToken({});
    const origFetch = global.fetch;

    global.fetch = async (...args) => {
      const url = args[0];
      if (typeof url === 'string' && url.startsWith(baseUrl)) {
        return origFetch(...args);
      }
      return new Response('', {
        status: 302,
        headers: { Location: 'http://127.0.0.1:8080/admin' },
      });
    };

    try {
      const res = await origFetch(`${baseUrl}/api/v1/geo/resolve-maps-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: 'https://maps.app.goo.gl/loopback_redirect' }),
      });
      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'INVALID_URL');
    } finally {
      global.fetch = origFetch;
    }
  });

  await t.test('2.8 Rejects protocol-relative redirect to attacker host (//attacker.example/maps)', async () => {
    setupPrismaMock();
    const token = createTestToken({});
    const origFetch = global.fetch;

    global.fetch = async (...args) => {
      const url = args[0];
      if (typeof url === 'string' && url.startsWith(baseUrl)) {
        return origFetch(...args);
      }
      return new Response('', {
        status: 302,
        headers: { Location: '//attacker.example/maps' },
      });
    };

    try {
      const res = await origFetch(`${baseUrl}/api/v1/geo/resolve-maps-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: 'https://maps.app.goo.gl/protocol_relative' }),
      });
      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'INVALID_URL');
    } finally {
      global.fetch = origFetch;
    }
  });

  await t.test('2.9 Accepts safe relative redirect to valid path on Google Maps', async () => {
    setupPrismaMock();
    const token = createTestToken({});
    const origFetch = global.fetch;

    global.fetch = async (...args) => {
      const url = args[0];
      if (typeof url === 'string' && url.startsWith(baseUrl)) {
        return origFetch(...args);
      }
      if (url === 'https://goo.gl/maps/valid_short') {
        return new Response('', {
          status: 302,
          headers: { Location: '/maps/search/12.9716,77.5946' },
        });
      }
      // Reverse geocode mock
      return new Response(
        JSON.stringify({
          status: 'OK',
          results: [
            {
              formatted_address: 'Bangalore, India',
              place_id: 'ChIJ_bangalore',
              address_components: [],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    try {
      const res = await origFetch(`${baseUrl}/api/v1/geo/resolve-maps-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: 'https://goo.gl/maps/valid_short' }),
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.data.lat, 12.9716);
      assert.strictEqual(body.data.lng, 77.5946);
    } finally {
      global.fetch = origFetch;
    }
  });

  await t.test('2.10 Rejects short-link redirect loop', async () => {
    setupPrismaMock();
    const token = createTestToken({});
    const origFetch = global.fetch;

    global.fetch = async (...args) => {
      const url = args[0];
      if (typeof url === 'string' && url.startsWith(baseUrl)) {
        return origFetch(...args);
      }
      return new Response('', {
        status: 302,
        headers: { Location: 'https://maps.app.goo.gl/loop' },
      });
    };

    try {
      const res = await origFetch(`${baseUrl}/api/v1/geo/resolve-maps-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: 'https://maps.app.goo.gl/loop' }),
      });
      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'INVALID_URL');
      assert.match(body.error.message, /Redirect loop detected/);
    } finally {
      global.fetch = origFetch;
    }
  });

  // =========================================================================
  // 3. Timeout & Resource Bounding Tests
  // =========================================================================
  await t.test('3.1 Outbound fetch timeout returns HTTP 504 UPSTREAM_TIMEOUT', async () => {
    setupPrismaMock();
    const token = createTestToken({});
    const origFetch = global.fetch;

    global.fetch = async (...args) => {
      const url = args[0];
      if (typeof url === 'string' && url.startsWith(baseUrl)) {
        return origFetch(...args);
      }
      const timeoutErr = new Error('The operation was aborted due to timeout');
      timeoutErr.name = 'TimeoutError';
      throw timeoutErr;
    };

    try {
      const res = await origFetch(`${baseUrl}/api/v1/geo/geocode?query=Mumbai`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.status, 504);
      const body = await res.json();
      assert.strictEqual(body.success, false);
      assert.strictEqual(body.error.code, 'UPSTREAM_TIMEOUT');
      assert.strictEqual(body.error.message, 'Geocoding service timed out');
    } finally {
      global.fetch = origFetch;
    }
  });

  await t.test('3.2 Cumulative redirect duration exceeding deadline triggers 504 timeout', async () => {
    setupPrismaMock();
    const token = createTestToken({});
    const origFetch = global.fetch;

    // Simulate multi-hop redirect where overall abort controller aborts
    global.fetch = async (...args) => {
      const url = args[0];
      if (typeof url === 'string' && url.startsWith(baseUrl)) {
        return origFetch(...args);
      }
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    };

    try {
      const res = await origFetch(`${baseUrl}/api/v1/geo/resolve-maps-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: 'https://maps.app.goo.gl/slow_hop' }),
      });
      assert.strictEqual(res.status, 504);
      const body = await res.json();
      assert.strictEqual(body.success, false);
      assert.strictEqual(body.error.code, 'UPSTREAM_TIMEOUT');
    } finally {
      global.fetch = origFetch;
    }
  });

  await t.test('3.3 Oversized / streaming response body is safely bounded without memory bloat', async () => {
    setupPrismaMock();
    const token = createTestToken({});
    const origFetch = global.fetch;

    // Simulate an oversized 1MB HTML body containing place coordinates
    const largePadding = 'X'.repeat(500 * 1024);
    const mockHtml = `<html><head><meta property="og:image" content="https://maps.google.com/maps/api/staticmap?center=13.0827%2C80.2707&zoom=14">${largePadding}</head></html>`;

    global.fetch = async (...args) => {
      const url = args[0];
      if (typeof url === 'string' && url.startsWith(baseUrl)) {
        return origFetch(...args);
      }
      if (url === 'https://maps.app.goo.gl/large_page') {
        return new Response(mockHtml, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      return new Response(
        JSON.stringify({
          status: 'OK',
          results: [{ formatted_address: 'Chennai, Tamil Nadu, India', place_id: 'ChIJ_chennai', address_components: [] }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    try {
      const res = await origFetch(`${baseUrl}/api/v1/geo/resolve-maps-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: 'https://maps.app.goo.gl/large_page' }),
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.data.lat, 13.0827);
      assert.strictEqual(body.data.lng, 80.2707);
    } finally {
      global.fetch = origFetch;
    }
  });

  // =========================================================================
  // 4. Authenticated Valid Use-Cases & Coordinate Parsing
  // =========================================================================
  await t.test('4.1 Direct coordinates resolve successfully without external URL fetch', async () => {
    setupPrismaMock();
    const token = createTestToken({});
    const origFetch = global.fetch;

    global.fetch = async (...args) => {
      const url = args[0];
      if (typeof url === 'string' && url.startsWith(baseUrl)) {
        return origFetch(...args);
      }
      return new Response(
        JSON.stringify({
          status: 'OK',
          results: [
            {
              formatted_address: 'Stella Nagaram, Dammaiguda, Hyderabad, India',
              place_id: 'ChIJ_mock_place_1',
              address_components: [{ long_name: 'Dammaiguda', types: ['sublocality_level_1'] }],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    try {
      const res = await origFetch(`${baseUrl}/api/v1/geo/resolve-maps-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: '17.499593, 78.604902' }),
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.data.lat, 17.499593);
      assert.strictEqual(body.data.lng, 78.604902);
      assert.ok(body.data.formattedAddress);
    } finally {
      global.fetch = origFetch;
    }
  });

  await t.test('4.2 Authenticated GET /geocode succeeds with valid upstream mock', async () => {
    setupPrismaMock();
    const token = createTestToken({});
    const origFetch = global.fetch;

    global.fetch = async (...args) => {
      const url = args[0];
      if (typeof url === 'string' && url.startsWith(baseUrl)) {
        return origFetch(...args);
      }
      return new Response(
        JSON.stringify({
          status: 'OK',
          results: [
            {
              formatted_address: 'Pune, Maharashtra, India',
              geometry: { location: { lat: 18.5204, lng: 73.8567 } },
              place_id: 'ChIJ_mock_pune',
              address_components: [],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    try {
      const res = await origFetch(`${baseUrl}/api/v1/geo/geocode?query=Pune`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.data[0].formatted_address, 'Pune, Maharashtra, India');
      assert.strictEqual(body.data[0].lat, 18.5204);
    } finally {
      global.fetch = origFetch;
    }
  });

  await t.test('4.3 Authenticated GET /reverse succeeds with valid upstream mock', async () => {
    setupPrismaMock();
    const token = createTestToken({});
    const origFetch = global.fetch;

    global.fetch = async (...args) => {
      const url = args[0];
      if (typeof url === 'string' && url.startsWith(baseUrl)) {
        return origFetch(...args);
      }
      return new Response(
        JSON.stringify({
          status: 'OK',
          results: [
            {
              formatted_address: 'MG Road, Bengaluru, Karnataka, India',
              place_id: 'ChIJ_mg_road',
              address_components: [{ long_name: 'Bengaluru', types: ['locality'] }],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    try {
      const res = await origFetch(`${baseUrl}/api/v1/geo/reverse?lat=12.9716&lng=77.5946`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.data.lat, 12.9716);
      assert.strictEqual(body.data.lng, 77.5946);
      assert.strictEqual(body.data.formatted_address, 'MG Road, Bengaluru, Karnataka, India');
    } finally {
      global.fetch = origFetch;
    }
  });
});
