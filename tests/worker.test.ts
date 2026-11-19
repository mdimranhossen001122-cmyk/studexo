import { describe, expect, it, vi, beforeEach } from 'vitest';
import { parseWorkerEnv } from '../src/server/config/env';

describe('Phase 8B.4E.1.3: Dedicated Worker Entry Point Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates parseWorkerEnv rejects missing WORKER_DATABASE_URL', () => {
    vi.stubEnv('WORKER_DATABASE_URL', '');
    try {
      expect(() => parseWorkerEnv({})).toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('validates parseWorkerEnv accepts valid WORKER_DATABASE_URL', () => {
    vi.stubEnv('WORKER_DATABASE_URL', 'postgres://postgres:password@localhost:5432/studexo');
    vi.stubEnv('NODE_ENV', 'test');
    try {
      const parsed = parseWorkerEnv();
      expect(parsed.database.WORKER_DATABASE_URL).toBe('postgres://postgres:password@localhost:5432/studexo');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
