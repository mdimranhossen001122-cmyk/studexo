import { describe, expect, it, vi, beforeEach } from 'vitest';
import { parseWorkerEnv } from '../src/server/config/env';

describe('Phase 8B.4E.1.3: Dedicated Worker Entry Point Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates parseWorkerEnv rejects missing WORKER_DATABASE_URL', () => {
    vi.stubEnv('WORKER_DATABASE_URL', '');
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
    try {
      expect(() => parseWorkerEnv({})).toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('validates parseWorkerEnv rejects missing or blank SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY', () => {
    expect(() =>
      parseWorkerEnv({
        NODE_ENV: 'test',
        WORKER_DATABASE_URL: 'postgres://postgres:password@localhost:5432/studexo',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      }),
    ).toThrow();

    expect(() =>
      parseWorkerEnv({
        NODE_ENV: 'test',
        WORKER_DATABASE_URL: 'postgres://postgres:password@localhost:5432/studexo',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: '   ',
      }),
    ).toThrow();
  });

  it('enforces HTTPS SUPABASE_URL in production and rejects embedded URL credentials', () => {
    expect(() =>
      parseWorkerEnv({
        NODE_ENV: 'production',
        WORKER_DATABASE_URL: 'postgres://studexo_purge_worker:password@db.example.com:6543/studexo',
        SUPABASE_URL: 'http://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      }),
    ).toThrow(/https:/i);

    expect(() =>
      parseWorkerEnv({
        NODE_ENV: 'test',
        WORKER_DATABASE_URL: 'postgres://postgres:password@localhost:5432/studexo',
        SUPABASE_URL: 'https://user:pass@example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      }),
    ).toThrow();
  });

  it('validates parseWorkerEnv accepts valid worker database and Supabase credentials', () => {
    vi.stubEnv('WORKER_DATABASE_URL', 'postgres://postgres:password@localhost:5432/studexo');
    vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
    vi.stubEnv('NODE_ENV', 'test');
    try {
      const parsed = parseWorkerEnv();
      expect(parsed.database.WORKER_DATABASE_URL).toBe(
        'postgres://postgres:password@localhost:5432/studexo',
      );
      expect(parsed.supabase).toEqual({
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
