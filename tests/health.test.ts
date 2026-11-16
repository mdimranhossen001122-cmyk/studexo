import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { healthResponseSchema, readyResponseSchema } from '../src/shared/schemas/health.schema';
import { createApp } from '../src/server/app';
import { parseEnv } from '../src/server/config/env';
import { closeAllDbs, hasActiveDbClient } from '../src/server/db/index';

describe('Health and readiness API endpoints', () => {
  afterEach(async () => {
    await closeAllDbs();
  });

  it('GET /api/health returns liveness payload matching shared Zod contract without touching the database', async () => {
    const env = parseEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:super-secret@127.0.0.1:6543/postgres',
    });
    const probeSpy = vi.fn();
    const { app } = createApp({ env, checkDatabaseReadiness: probeSpy });

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(probeSpy).not.toHaveBeenCalled();
    expect(hasActiveDbClient()).toBe(false);

    const parsed = healthResponseSchema.parse(res.body);
    expect(parsed.status).toBe('ok');
    expect(parsed.service).toBe('studexo-api');
    expect(parsed.environment).toBe('test');
  });

  it('GET /api/ready returns 503 degraded when database is unconfigured without opening a pool or leaking secrets', async () => {
    const env = parseEnv({
      NODE_ENV: 'test',
      GEMINI_API_KEY: 'super-secret-gemini-key',
    });
    const { app } = createApp({ env });

    const res = await request(app).get('/api/ready');

    expect(res.status).toBe(503);
    expect(hasActiveDbClient()).toBe(false);
    const parsed = readyResponseSchema.parse(res.body);
    expect(parsed.status).toBe('degraded');
    expect(parsed.runtime.configured).toBe(true);
    expect(parsed.integrations.database).toEqual({ configured: false, connected: false });
    expect(parsed.integrations.supabase).toEqual({ configured: false, verified: false });
    expect(parsed.integrations.gemini).toEqual({ configured: true, verified: false });

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('super-secret-gemini-key');
  });

  it('GET /api/ready returns 200 ok only when database readiness probe succeeds, and 503 degraded on failure without leaking credentials', async () => {
    const env = parseEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:super-secret-password@127.0.0.1:6543/postgres',
      GEMINI_API_KEY: 'super-secret-gemini-key',
    });

    const { app: healthyApp } = createApp({
      env,
      checkDatabaseReadiness: async () => ({ configured: true, connected: true }),
    });

    const okRes = await request(healthyApp).get('/api/ready');
    expect(okRes.status).toBe(200);
    const okParsed = readyResponseSchema.parse(okRes.body);
    expect(okParsed.status).toBe('ok');
    expect(okParsed.integrations.database).toEqual({ configured: true, connected: true });

    const { app: failingApp } = createApp({
      env,
      checkDatabaseReadiness: async () => {
        throw new Error(
          'connect ECONNREFUSED postgresql://user:super-secret-password@127.0.0.1:6543/postgres',
        );
      },
    });

    const errRes = await request(failingApp).get('/api/ready');
    expect(errRes.status).toBe(503);
    const errParsed = readyResponseSchema.parse(errRes.body);
    expect(errParsed.status).toBe('degraded');
    expect(errParsed.integrations.database).toEqual({ configured: true, connected: false });

    const serialized = JSON.stringify(errRes.body);
    expect(serialized).not.toContain('super-secret-password');
    expect(serialized).not.toContain('ECONNREFUSED');
    expect(serialized).not.toContain('super-secret-gemini-key');
  });

  it('returns 503 quickly against an unopenable local database port without leaking connection errors', async () => {
    const env = parseEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:super-secret-db-pass@127.0.0.1:59998/studexo',
      DB_CONNECT_TIMEOUT_SECONDS: '2',
    });
    const { app } = createApp({ env });

    const res = await request(app).get('/api/ready');
    expect(res.status).toBe(503);
    const parsed = readyResponseSchema.parse(res.body);
    expect(parsed.status).toBe('degraded');
    expect(parsed.integrations.database).toEqual({ configured: true, connected: false });
    expect(JSON.stringify(res.body)).not.toContain('super-secret-db-pass');
  });
});
