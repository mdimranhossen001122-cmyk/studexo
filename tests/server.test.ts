import { PassThrough } from 'node:stream';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { parseEnv } from '../src/server/config/env';
import { createLogger } from '../src/server/lib/logger';
import { AppError } from '../src/server/middleware/errorHandler';

function createSpyLogger(level: string = 'info') {
  const lines: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => {
    lines.push(chunk.toString('utf8'));
  });
  const logger = createLogger(level, stream);
  return {
    logger,
    getParsedLogs: () =>
      lines
        .join('')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('Express server security, CSP, CORS, rate limit, and request ID baseline', () => {
  it('returns structured 404 JSON with requestId for unknown /api routes', async () => {
    const env = parseEnv({ NODE_ENV: 'test' });
    const { app } = createApp({ env });

    const res = await request(app).get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body.error).toMatchObject({
      code: 'NOT_FOUND',
      requestId: res.headers['x-request-id'],
    });
  });

  it('echoes valid X-Request-Id and replaces invalid X-Request-Id with a UUID', async () => {
    const env = parseEnv({ NODE_ENV: 'test' });
    const { app } = createApp({ env });

    const validRes = await request(app)
      .get('/api/health')
      .set('X-Request-Id', 'client-req_12345');
    expect(validRes.status).toBe(200);
    expect(validRes.headers['x-request-id']).toBe('client-req_12345');

    const invalidRes = await request(app)
      .get('/api/health')
      .set('X-Request-Id', 'bad id!@#');
    expect(invalidRes.status).toBe(200);
    expect(invalidRes.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('enforces explicit CORS allowlist and OPTIONS preflight handling', async () => {
    const env = parseEnv({
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
      APP_URL: 'https://studexo.example.com',
    });
    const { app } = createApp({ env });

    const allowed = await request(app)
      .get('/api/health')
      .set('Origin', 'https://studexo.example.com');
    expect(allowed.status).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://studexo.example.com');

    const preflightAllowed = await request(app)
      .options('/api/health')
      .set('Origin', 'https://studexo.example.com')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Authorization,Content-Type');
    expect(preflightAllowed.status).toBe(204);
    expect(preflightAllowed.headers['access-control-allow-origin']).toBe(
      'https://studexo.example.com',
    );
    expect(preflightAllowed.headers['access-control-allow-methods']).toContain('POST');
    expect(preflightAllowed.headers['access-control-allow-headers']).toContain('Authorization');

    const denied = await request(app)
      .get('/api/health')
      .set('Origin', 'https://evil.example.net');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('CORS_ORIGIN_DENIED');

    const preflightDenied = await request(app)
      .options('/api/health')
      .set('Origin', 'https://evil.example.net')
      .set('Access-Control-Request-Method', 'POST');
    expect(preflightDenied.status).toBe(403);
    expect(preflightDenied.body.error.code).toBe('CORS_ORIGIN_DENIED');
  });

  it('propagates consistent X-Request-Id across CORS 403, oversized 413, malformed JSON 400, and completion logs without duplicates', async () => {
    const spy = createSpyLogger('info');
    const env = parseEnv({
      NODE_ENV: 'production',
      APP_URL: 'https://studexo.example.com',
    });
    const { app } = createApp({ env, logger: spy.logger });

    const corsRes = await request(app)
      .get('/api/health')
      .set('Origin', 'https://evil.example.net')
      .set('X-Request-Id', 'req-cors-deny-1');
    expect(corsRes.status).toBe(403);
    expect(corsRes.headers['x-request-id']).toBe('req-cors-deny-1');
    expect(corsRes.body.error.requestId).toBe('req-cors-deny-1');

    const json413 = await request(app)
      .post('/api/health')
      .set('X-Request-Id', 'req-json-413-1')
      .set('Content-Type', 'application/json')
      .send({ data: 'a'.repeat(120 * 1024) });
    expect(json413.status).toBe(413);
    expect(json413.headers['x-request-id']).toBe('req-json-413-1');
    expect(json413.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(json413.body.error.requestId).toBe('req-json-413-1');

    const form413 = await request(app)
      .post('/api/health')
      .set('X-Request-Id', 'req-form-413-1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`data=${'b'.repeat(120 * 1024)}`);
    expect(form413.status).toBe(413);
    expect(form413.headers['x-request-id']).toBe('req-form-413-1');
    expect(form413.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(form413.body.error.requestId).toBe('req-form-413-1');

    const malformedJson = await request(app)
      .post('/api/health')
      .set('X-Request-Id', 'req-bad-json-1')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(malformedJson.status).toBe(400);
    expect(malformedJson.headers['x-request-id']).toBe('req-bad-json-1');
    expect(malformedJson.body.error.code).toBe('INVALID_JSON');
    expect(malformedJson.body.error.requestId).toBe('req-bad-json-1');

    const logs = spy.getParsedLogs();
    for (const [id, status] of [
      ['req-cors-deny-1', 403],
      ['req-json-413-1', 413],
      ['req-form-413-1', 413],
      ['req-bad-json-1', 400],
    ] as const) {
      const completionLogs = logs.filter(
        (entry) => entry.requestId === id && entry.msg === 'HTTP request completed with client error',
      );
      expect(completionLogs).toHaveLength(1);
      expect((completionLogs[0]?.res as Record<string, unknown>)?.statusCode).toBe(status);
    }
  });

  it('enforces rate limiting (429) while excluding /api/health liveness probes', async () => {
    const env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    const { app } = createApp({
      env,
      rateLimitMax: 2,
      checkDatabaseReadiness: async () => ({ configured: true, connected: true }),
    });

    const r1 = await request(app).get('/api/ready');
    const r2 = await request(app).get('/api/ready');
    const r3 = await request(app).get('/api/ready');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(r3.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(r3.body.error.requestId).toBe(r3.headers['x-request-id']);

    // /api/health remains exempt from rate limiting
    const healthAfter = await request(app).get('/api/health');
    expect(healthAfter.status).toBe(200);
  });

  it('configures restrictive standalone production CSP, explicit trusted frame-ancestors, and dev preview compatibility', async () => {
    // 1. Standalone production (HTTPS APP_URL, no frame ancestors configured)
    const prodEnv = parseEnv({
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
      APP_URL: 'https://studexo.example.com',
    });
    const { app: prodApp } = createApp({ env: prodEnv });
    const prodRes = await request(prodApp).get('/api/health');

    expect(prodRes.headers['x-powered-by']).toBeUndefined();
    expect(prodRes.headers['x-content-type-options']).toBe('nosniff');
    expect(prodRes.headers['x-frame-options']).toBe('DENY');
    const prodCsp = prodRes.headers['content-security-policy'];
    expect(prodCsp).toContain("default-src 'self'");
    expect(prodCsp).toContain("object-src 'none'");
    expect(prodCsp).toContain("base-uri 'self'");
    expect(prodCsp).toContain("frame-ancestors 'none'");
    expect(prodCsp).toContain('upgrade-insecure-requests');

    // 2. Local HTTP production smoke test (no HTTPS APP_URL -> no forced upgrade-insecure-requests)
    const localProdEnv = parseEnv({
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
      APP_URL: 'http://127.0.0.1:3099',
    });
    const { app: localProdApp } = createApp({ env: localProdEnv });
    const localProdRes = await request(localProdApp).get('/api/health');
    expect(localProdRes.headers['content-security-policy']).not.toContain(
      'upgrade-insecure-requests',
    );
    expect(localProdRes.headers['content-security-policy']).toContain("frame-ancestors 'none'");

    // 3. Explicit trusted embedded production
    const embeddedProdEnv = parseEnv({
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
      APP_URL: 'https://studexo.example.com',
      CSP_FRAME_ANCESTORS: 'https://aistudio.google.com',
    });
    const { app: embeddedProdApp } = createApp({ env: embeddedProdEnv });
    const embeddedRes = await request(embeddedProdApp).get('/api/health');
    expect(embeddedRes.headers['content-security-policy']).toContain(
      'frame-ancestors https://aistudio.google.com',
    );
    expect(embeddedRes.headers['x-frame-options']).toBeUndefined();

    // 4. Development preview compatibility
    const devEnv = parseEnv({ NODE_ENV: 'development', LOG_LEVEL: 'silent' });
    const { app: devApp } = createApp({ env: devEnv });
    const devRes = await request(devApp).get('/api/health');
    expect(devRes.headers['x-powered-by']).toBeUndefined();
    expect(devRes.headers['x-content-type-options']).toBe('nosniff');
    expect(devRes.headers['content-security-policy']).toBeUndefined();
    expect(devRes.headers['x-frame-options']).toBeUndefined();
  });

  it('masks internal 500 error details in production mode', async () => {
    const env = parseEnv({
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
      APP_URL: 'https://studexo.example.com',
    });
    const { app, clientRouter } = createApp({ env });
    clientRouter.get('/boom', () => {
      throw new AppError(500, 'DB_FAILURE', 'Sensitive internal database trace');
    });

    const res = await request(app).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('DB_FAILURE');
    expect(res.body.error.message).toBe('Internal server error');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    expect(JSON.stringify(res.body)).not.toContain('Sensitive internal database trace');
  });

  it('does not blindly set trust proxy to boolean true', () => {
    const env = parseEnv({ NODE_ENV: 'test', TRUST_PROXY_HOPS: '1' });
    const { app } = createApp({ env });

    expect(app.get('trust proxy')).toBe(1);
  });
});
