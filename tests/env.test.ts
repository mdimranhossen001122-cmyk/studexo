import { describe, expect, it } from 'vitest';
import { getIntegrationReadiness, parseEnv } from '../src/server/config/env';

describe('Environment configuration (parseEnv)', () => {
  it('parses minimal defaults without requiring Supabase, DB, or Gemini credentials', () => {
    const env = parseEnv({});

    expect(env.runtime.NODE_ENV).toBe('development');
    expect(env.runtime.PORT).toBe(3000);
    expect(env.runtime.TRUST_PROXY_HOPS).toBe(1);
    expect(env.runtime.allowedOrigins).toContain('http://localhost:3000');
    expect(env.runtime.cspFrameAncestors).toEqual([]);
    expect(env.database.DATABASE_URL).toBeUndefined();
    expect('DIRECT_DATABASE_URL' in env.database).toBe(false);
    expect('SUPABASE_SERVICE_ROLE_KEY' in env.supabase).toBe(false);
    expect(env.gemini.GEMINI_API_KEY).toBeUndefined();

    const readiness = getIntegrationReadiness(env);
    expect(readiness).toEqual({
      runtimeConfigured: true,
      databaseConfigured: false,
      supabaseConfigured: false,
      geminiConfigured: false,
    });
  });

  it('treats empty strings as unset optional values', () => {
    const env = parseEnv({
      NODE_ENV: 'production',
      PORT: '8080',
      APP_URL: 'https://studexo.example.com',
      CSP_FRAME_ANCESTORS: '   ',
      DATABASE_URL: '   ',
      GEMINI_API_KEY: '',
      SUPABASE_URL: '',
    });

    expect(env.runtime.NODE_ENV).toBe('production');
    expect(env.runtime.PORT).toBe(8080);
    expect(env.runtime.allowedOrigins).toEqual(['https://studexo.example.com']);
    expect(env.runtime.cspFrameAncestors).toEqual([]);
    expect(env.database.DATABASE_URL).toBeUndefined();
    expect(env.gemini.GEMINI_API_KEY).toBeUndefined();
  });

  it('marks integrations as configured when valid optional API credentials are supplied without service-role key', () => {
    const env = parseEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:pass@localhost:6543/postgres',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_ANON_KEY: 'anon-placeholder',
      GEMINI_API_KEY: 'gemini-placeholder',
    });

    expect(getIntegrationReadiness(env)).toEqual({
      runtimeConfigured: true,
      databaseConfigured: true,
      supabaseConfigured: true,
      geminiConfigured: true,
    });
  });

  it('strips SUPABASE_SERVICE_ROLE_KEY from AppEnv and keeps API readiness decoupled from it while retaining it in parseWorkerEnv', async () => {
    const { parseApiEnv, parseWorkerEnv } = await import('../src/server/config/env');

    const apiEnvWithInjectedSecret = parseApiEnv({
      NODE_ENV: 'production',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-should-never-enter-app-env',
    });
    expect('SUPABASE_SERVICE_ROLE_KEY' in apiEnvWithInjectedSecret.supabase).toBe(false);
    expect(
      (apiEnvWithInjectedSecret.supabase as Record<string, unknown>).SUPABASE_SERVICE_ROLE_KEY,
    ).toBeUndefined();
    expect(getIntegrationReadiness(apiEnvWithInjectedSecret).supabaseConfigured).toBe(false);

    const apiEnvWithViteFallback = parseEnv({
      NODE_ENV: 'test',
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'vite-anon-placeholder',
    });
    expect(getIntegrationReadiness(apiEnvWithViteFallback).supabaseConfigured).toBe(true);

    const apiEnvMissingAnon = parseEnv({
      NODE_ENV: 'test',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-does-not-satisfy-api-auth',
    });
    expect(getIntegrationReadiness(apiEnvMissingAnon).supabaseConfigured).toBe(false);

    const workerEnv = parseWorkerEnv({
      NODE_ENV: 'production',
      WORKER_DATABASE_URL: 'postgresql://studexo_purge_worker:pw@db.example.com:6543/postgres',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'worker-service-role-key',
    });
    expect(workerEnv.supabase).toEqual({
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'worker-service-role-key',
    });

    // Worker startup fails closed when SUPABASE_SERVICE_ROLE_KEY or SUPABASE_URL is missing/blank
    expect(() =>
      parseWorkerEnv({
        NODE_ENV: 'production',
        WORKER_DATABASE_URL: 'postgresql://studexo_purge_worker:pw@db.example.com:6543/postgres',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: '   ',
      }),
    ).toThrow();
    expect(() =>
      parseWorkerEnv({
        NODE_ENV: 'production',
        WORKER_DATABASE_URL: 'postgresql://studexo_purge_worker:pw@db.example.com:6543/postgres',
        SUPABASE_SERVICE_ROLE_KEY: 'worker-service-role-key',
      }),
    ).toThrow();
    expect(() =>
      parseWorkerEnv({
        NODE_ENV: 'production',
        WORKER_DATABASE_URL: 'postgresql://studexo_purge_worker:pw@db.example.com:6543/postgres',
        SUPABASE_URL: 'http://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'worker-service-role-key',
      }),
    ).toThrow(/https:/i);
  });

  it('accepts explicit HTTPS origins in CSP_FRAME_ANCESTORS and rejects wildcards or HTTP', () => {
    const valid = parseEnv({
      NODE_ENV: 'production',
      CSP_FRAME_ANCESTORS: 'https://aistudio.google.com, https://admin.studexo.example',
    });
    expect(valid.runtime.cspFrameAncestors).toEqual([
      'https://aistudio.google.com',
      'https://admin.studexo.example',
    ]);

    expect(() =>
      parseEnv({ CSP_FRAME_ANCESTORS: 'https://*.google.com' }),
    ).toThrow(/Wildcard/);
    expect(() =>
      parseEnv({ CSP_FRAME_ANCESTORS: 'http://insecure.example.com' }),
    ).toThrow(/HTTPS/);
    expect(() =>
      parseEnv({ CSP_FRAME_ANCESTORS: 'https://example.com/with-path' }),
    ).toThrow(/pure origins/);
    expect(() => parseEnv({ CSP_FRAME_ANCESTORS: 'not-a-url' })).toThrow();
  });

  it('rejects invalid PORT, malformed DATABASE_URL, out-of-range DB pool limits, and invalid ALLOWED_ORIGINS while ignoring DIRECT_DATABASE_URL in parseEnv', () => {
    expect(() => parseEnv({ PORT: '99999' })).toThrow();
    expect(() => parseEnv({ DATABASE_URL: 'http://not-postgres' })).toThrow();
    const apiEnvWithDirectUrl = parseEnv({
      NODE_ENV: 'production',
      DIRECT_DATABASE_URL: 'mysql://localhost/db',
      SUPABASE_SERVICE_ROLE_KEY: 'should-not-enter-app-env',
    });
    expect('DIRECT_DATABASE_URL' in apiEnvWithDirectUrl.database).toBe(false);
    expect(
      (apiEnvWithDirectUrl.database as Record<string, unknown>).DIRECT_DATABASE_URL,
    ).toBeUndefined();
    expect(() => parseEnv({ DB_POOL_MAX: '0' })).toThrow();
    expect(() => parseEnv({ DB_POOL_MAX: '100' })).toThrow();
    expect(() => parseEnv({ DB_IDLE_TIMEOUT_SECONDS: '1' })).toThrow();
    expect(() => parseEnv({ DB_CONNECT_TIMEOUT_SECONDS: '1' })).toThrow();
    expect(() => parseEnv({ ALLOWED_ORIGINS: 'not-a-valid-origin' })).toThrow();
  });

  it('isolates API env from worker DB requirements while failing closed in parseWorkerEnv', async () => {
    const { parseApiEnv, parseWorkerEnv } = await import('../src/server/config/env');

    // API startup succeeds cleanly without WORKER_DATABASE_URL, DIRECT_DATABASE_URL, or SUPABASE_SERVICE_ROLE_KEY
    const apiEnv = parseApiEnv({
      NODE_ENV: 'production',
      APP_URL: 'https://studexo.example.com',
      DATABASE_URL: 'postgresql://studexo_app:pw@db.example.com:6543/postgres',
    });
    expect(apiEnv.database.DATABASE_URL).toContain('studexo_app');

    // Worker startup fails closed if WORKER_DATABASE_URL is omitted or blank
    expect(() => parseWorkerEnv({ NODE_ENV: 'production' })).toThrow();
    expect(() =>
      parseWorkerEnv({
        NODE_ENV: 'production',
        WORKER_DATABASE_URL: '   ',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'worker-service-role-key',
      }),
    ).toThrow();

    const workerEnv = parseWorkerEnv({
      NODE_ENV: 'production',
      WORKER_DATABASE_URL: 'postgresql://studexo_purge_worker:pw@db.example.com:6543/postgres',
      WORKER_DB_POOL_MAX: '3',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'worker-service-role-key',
    });
    expect(workerEnv.database.WORKER_DB_POOL_MAX).toBe(3);
    expect(workerEnv.database.WORKER_DATABASE_URL).toContain('studexo_purge_worker');
  });

  it('enforces verified TLS in production (rejecting sslmode=require/disable/allow/prefer/no-verify) while allowing local dev/test loopback', async () => {
    const { buildPostgresClientOptions } = await import('../src/server/db/client');
    const { parseWorkerEnv, resolvePostgresTlsConfig } = await import('../src/server/config/env');

    for (const badMode of ['disable', 'allow', 'prefer', 'require', 'no-verify', 'false']) {
      expect(() =>
        parseEnv({
          NODE_ENV: 'production',
          DATABASE_URL: `postgresql://studexo_app:pw@db.example.com:6543/postgres?sslmode=${badMode}`,
        }),
      ).toThrow(/insecure sslmode/i);

      expect(() =>
        parseWorkerEnv({
          NODE_ENV: 'production',
          WORKER_DATABASE_URL: `postgresql://studexo_purge_worker:pw@db.example.com:6543/postgres?sslmode=${badMode}`,
          SUPABASE_URL: 'https://example.supabase.co',
          SUPABASE_SERVICE_ROLE_KEY: 'worker-service-role-key',
        }),
      ).toThrow(/insecure sslmode/i);
    }

    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://studexo_app:pw@db.example.com:6543/postgres?ssl=false',
      }),
    ).toThrow(/insecure ssl/i);

    const prodUrl = 'postgresql://studexo_app:pw@db.example.com:6543/postgres';
    expect(
      resolvePostgresTlsConfig(prodUrl, 'DATABASE_URL', { isProduction: true }),
    ).toBe('verify-full');

    const fakePem = '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----';
    const prodOpts = buildPostgresClientOptions({
      connectionString: prodUrl,
      envVarName: 'DATABASE_URL',
      isProduction: true,
      max: 5,
      idleTimeoutSeconds: 20,
      connectTimeoutSeconds: 10,
      sslRootCert: fakePem,
    });
    expect(prodOpts.prepare).toBe(false);
    expect(prodOpts.ssl).toEqual({
      rejectUnauthorized: true,
      ca: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    });

    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        DB_SSL_ROOT_CERT: 'not-a-valid-pem-certificate',
      }),
    ).toThrow(/PEM-encoded/);

    // Localhost in test/dev permits local disposable PostgreSQL without SSL
    expect(
      resolvePostgresTlsConfig(
        'postgresql://studexo_app:pw@127.0.0.1:5432/studexo',
        'DATABASE_URL',
        { isProduction: false },
      ),
    ).toBe(false);

    // Non-local hosts outside production still enforce verify-full unless disabled locally
    expect(
      resolvePostgresTlsConfig(
        'postgresql://studexo_app:pw@staging-db.example.com:6543/postgres',
        'DATABASE_URL',
        { isProduction: false },
      ),
    ).toBe('verify-full');
  });

  it('enforces fail-closed DIRECT_DATABASE_URL and verified TLS parity in parseMigrationEnv', async () => {
    const { parseMigrationEnv } = await import('../src/server/config/env');

    expect(() => parseMigrationEnv({ NODE_ENV: 'production' })).toThrow();
    expect(() =>
      parseMigrationEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://studexo_app:pw@db.example.com:6543/postgres',
        DIRECT_DATABASE_URL: '   ',
      }),
    ).toThrow();

    for (const badMode of ['disable', 'allow', 'prefer', 'require', 'no-verify', 'false']) {
      expect(() =>
        parseMigrationEnv({
          NODE_ENV: 'production',
          DIRECT_DATABASE_URL: `postgresql://studexo_migrator:pw@db.example.com:5432/postgres?sslmode=${badMode}`,
        }),
      ).toThrow(/insecure sslmode/i);
    }

    const fakePem = '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----';
    const migrationEnv = parseMigrationEnv({
      NODE_ENV: 'production',
      DIRECT_DATABASE_URL: 'postgresql://studexo_migrator:pw@db.example.com:5432/postgres',
      DB_SSL_ROOT_CERT: fakePem,
    });
    expect(migrationEnv.database.DIRECT_DATABASE_URL).toContain('studexo_migrator');
    expect(migrationEnv.database.DB_SSL_ROOT_CERT).toBe(fakePem);
  });
});
