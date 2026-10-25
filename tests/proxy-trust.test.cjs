const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const rateLimit = require('express-rate-limit');

// Helper to create an isolated test app mimicking server.ts rate-limiting and proxy trust
function createProxyTestApp() {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());

  // API rate limiter mirroring src/server.ts
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === 'OPTIONS',
    message: {
      success: false,
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many requests from this IP, please try again after 15 minutes.',
      },
    },
  });

  // Auth rate limiter mirroring src/server.ts
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: {
        code: 'TOO_MANY_LOGIN_ATTEMPTS',
        message: 'Too many authentication attempts. Please try again after 15 minutes.',
      },
    },
  });

  // Health endpoint mirroring src/server.ts
  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'servfex-api',
      version: 'v1',
      authBuild: 'original-job-flow-v7',
      database: 'mongodb',
    });
  });

  // Mount limiters mirroring src/server.ts
  app.use('/api/', apiLimiter);
  app.use('/api/v1/auth/login', authLimiter);

  // Echo endpoint to inspect resolved IP and headers
  app.get('/api/test-ip', (req, res) => {
    res.json({
      resolvedIp: req.ip,
      ips: req.ips,
      headers: req.headers,
    });
  });

  // Test login endpoint
  app.post('/api/v1/auth/login', (req, res) => {
    res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      },
      resolvedIp: req.ip,
    });
  });

  return app;
}

// Helper to perform HTTP requests against an active test server
function makeRequest(server, options, body = null) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const reqOptions = {
      hostname: '127.0.0.1',
      port,
      path: options.path || '/',
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          // not JSON
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: json || data,
        });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

test('Proxy Trust Hardening & Rate Limiting Test Suite', async (t) => {
  let app;
  let server;

  t.beforeEach(() => {
    app = createProxyTestApp();
  });

  t.afterEach(() => {
    if (server && server.listening) {
      server.close();
    }
  });

  await t.test('1. Static source inspection: trust proxy is set to loopback in source', () => {
    const serverSource = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'server.ts'),
      'utf8'
    );
    assert.match(
      serverSource,
      /app\.set\(\s*['"]trust proxy['"]\s*,\s*['"]loopback['"]\s*\)/,
      'src/server.ts must explicitly configure app.set("trust proxy", "loopback")'
    );
  });

  await t.test('2. Static source inspection: env.ts provides configurable HOST defaulting to 0.0.0.0', () => {
    const envSource = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'config', 'env.ts'),
      'utf8'
    );
    assert.match(
      envSource,
      /HOST:\s*z\.string\(\)\.default\(['"]0\.0\.0\.0['"]\)/,
      'src/config/env.ts must define HOST with default "0.0.0.0"'
    );
  });

  await t.test('3. Real TCP Loopback: Direct connection without X-Forwarded-For', async () => {
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });

    const res = await makeRequest(server, { path: '/api/test-ip' });
    assert.strictEqual(res.statusCode, 200);
    // Over loopback without XFF, resolved IP must be the loopback socket address
    assert.ok(
      res.body.resolvedIp === '127.0.0.1' || res.body.resolvedIp === '::ffff:127.0.0.1',
      `Expected loopback IP, got: ${res.body.resolvedIp}`
    );
  });

  await t.test('4. Real TCP Loopback: Forwarded by trusted proxy with single client IP in XFF', async () => {
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });

    const clientIp = '203.0.113.195';
    const res = await makeRequest(server, {
      path: '/api/test-ip',
      headers: {
        'x-forwarded-for': clientIp,
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(
      res.body.resolvedIp,
      clientIp,
      `Resolved IP must match client IP forwarded by trusted proxy: ${clientIp}`
    );
  });

  await t.test('5. Real TCP Loopback: Spoofed client header is overridden by proxy-appended IP', async () => {
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });

    const spoofedIp = '8.8.8.8';
    const realClientIp = '203.0.113.42';
    // When a client sends XFF: 8.8.8.8, Nginx appends $remote_addr -> "8.8.8.8, 203.0.113.42"
    const forwardedHeader = `${spoofedIp}, ${realClientIp}`;

    const res = await makeRequest(server, {
      path: '/api/test-ip',
      headers: {
        'x-forwarded-for': forwardedHeader,
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(
      res.body.resolvedIp,
      realClientIp,
      `Express must resolve to the IP appended by Nginx (${realClientIp}), ignoring spoofed ${spoofedIp}`
    );
  });

  await t.test('6. Real TCP Loopback: Multi-hop client spoof chain safely extracts trusted peer', async () => {
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });

    const realClientIp = '198.51.100.88';
    const chain = `1.1.1.1, 2.2.2.2, 3.3.3.3, ${realClientIp}`;

    const res = await makeRequest(server, {
      path: '/api/test-ip',
      headers: {
        'x-forwarded-for': chain,
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.resolvedIp, realClientIp);
  });

  await t.test('7. Mocked Socket Peer: Non-loopback connection cannot spoof X-Forwarded-For', () => {
    // Note: Cross-network external TCP cannot be bound locally without external interfaces.
    // We test Express proxy-addr trust evaluation by faithfully setting the socket remoteAddress property.
    const nonLoopbackIps = [
      '203.0.113.50',   // Public internet IP
      '198.51.100.14',  // Documentation network IP
      '10.0.0.25',      // RFC 1918 Private class A
      '172.31.4.155',   // AWS EC2 VPC private IP
      '192.168.1.100',  // RFC 1918 Private class C
    ];

    for (const peerIp of nonLoopbackIps) {
      const spoofedTarget = '8.8.8.8';
      const fakeReq = {
        app,
        connection: { remoteAddress: peerIp },
        headers: { 'x-forwarded-for': spoofedTarget },
      };
      Object.setPrototypeOf(fakeReq, express.request);

      // When the socket peer is not a loopback address, 'trust proxy: loopback'
      // must NOT trust the peer, and must return the peer's actual IP, ignoring XFF.
      assert.strictEqual(
        fakeReq.ip,
        peerIp,
        `Direct connection from ${peerIp} must not gain trust; expected ${peerIp}, got ${fakeReq.ip}`
      );
    }
  });

  await t.test('8. Rate Limiter: API limiter tracks client IP without collision across IPs', async () => {
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });

    const clientA = '203.0.113.10';
    const clientB = '203.0.113.20';

    // Client A sends 3 requests
    for (let i = 0; i < 3; i++) {
      await makeRequest(server, {
        path: '/api/test-ip',
        headers: { 'x-forwarded-for': clientA },
      });
    }

    const resA = await makeRequest(server, {
      path: '/api/test-ip',
      headers: { 'x-forwarded-for': clientA },
    });
    // Limit is 300; Client A has made 4 requests -> remaining 296
    assert.strictEqual(resA.headers['ratelimit-remaining'], '296');

    // Client B sends 1 request -> remaining should be 299 (isolated quota)
    const resB = await makeRequest(server, {
      path: '/api/test-ip',
      headers: { 'x-forwarded-for': clientB },
    });
    assert.strictEqual(
      resB.headers['ratelimit-remaining'],
      '299',
      'Client B quota must remain independent and not collide with Client A'
    );
  });

  await t.test('9. Rate Limiter: Auth limiter enforces max 20 login attempts per client IP', async () => {
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });

    const attackerIp = '203.0.113.66';
    const victimIp = '203.0.113.77';

    // Rapidly consume quota for attackerIp (20 attempts)
    for (let i = 0; i < 20; i++) {
      const res = await makeRequest(
        server,
        {
          path: '/api/v1/auth/login',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': attackerIp,
          },
        },
        { email: 'user@test.com', password: 'bad' }
      );
      assert.strictEqual(res.statusCode, 401);
    }

    // 21st attempt from attackerIp must return 429 TOO_MANY_LOGIN_ATTEMPTS
    const throttled = await makeRequest(
      server,
      {
        path: '/api/v1/auth/login',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': attackerIp,
        },
      },
      { email: 'user@test.com', password: 'bad' }
    );
    assert.strictEqual(throttled.statusCode, 429);
    assert.strictEqual(throttled.body.error.code, 'TOO_MANY_LOGIN_ATTEMPTS');

    // Legitimate user on different IP must NOT be blocked
    const innocent = await makeRequest(
      server,
      {
        path: '/api/v1/auth/login',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': victimIp,
        },
      },
      { email: 'innocent@test.com', password: 'bad' }
    );
    assert.strictEqual(innocent.statusCode, 401);
    assert.strictEqual(innocent.headers['ratelimit-remaining'], '19');
  });

  await t.test('10. Health check endpoint remains functional and uninhibited by proxy trust', async () => {
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });

    const res = await makeRequest(server, { path: '/health' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.status, 'ok');
    assert.strictEqual(res.body.service, 'servfex-api');
    assert.strictEqual(res.body.database, 'mongodb');
  });
});
