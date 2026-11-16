import { z } from 'zod';

const emptyToUndefined = (value: unknown): unknown => {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  return value;
};

const optionalUrl = z.preprocess(
  emptyToUndefined,
  z.string().url('Must be a valid http/https URL').optional(),
);

const isPostgresConnectionString = (val: string): boolean =>
  val.startsWith('postgres://') || val.startsWith('postgresql://');

const optionalPostgresUrl = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .refine(
      isPostgresConnectionString,
      'Must be a valid PostgreSQL connection string (postgres:// or postgresql://)',
    )
    .optional(),
);

const requiredPostgresUrl = z.preprocess(
  emptyToUndefined,
  z
    .string({ error: 'PostgreSQL connection string is required.' })
    .refine(
      isPostgresConnectionString,
      'Must be a valid PostgreSQL connection string (postgres:// or postgresql://)',
    ),
);

const optionalNonEmptyString = z.preprocess(
  emptyToUndefined,
  z.string().min(1).optional(),
);

const INSECURE_PRODUCTION_SSL_MODES = new Set([
  'disable',
  'false',
  '0',
  'allow',
  'prefer',
  'require',
  'no-verify',
]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function normalizePemCertificate(rawCert: string): string {
  const normalized = rawCert.includes('\\n') ? rawCert.replace(/\\n/g, '\n') : rawCert;
  const trimmed = normalized.trim();
  if (!trimmed.includes('-----BEGIN CERTIFICATE-----') || !trimmed.includes('-----END CERTIFICATE-----')) {
    throw new Error('DB_SSL_ROOT_CERT must contain a valid PEM-encoded X.509 certificate.');
  }
  return trimmed;
}

export type PostgresSslSetting =
  | false
  | 'verify-full'
  | {
      rejectUnauthorized: true;
      ca: string;
    };

export interface PostgresTlsValidationOptions {
  isProduction: boolean;
  sslRootCert?: string;
}

/**
 * Validates PostgreSQL URL TLS parameters and derives safe `postgres.js` `ssl` options.
 * In `NODE_ENV === 'production'`, insecure or unverified TLS modes—including `sslmode=require`,
 * which sets `rejectUnauthorized = false` in `postgres@3.4.9`—are strictly rejected.
 */
export function resolvePostgresTlsConfig(
  connectionString: string,
  envVarName: string,
  options: PostgresTlsValidationOptions,
): PostgresSslSetting {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(`${envVarName} is not a parseable PostgreSQL connection URL.`);
  }

  const sslMode = parsed.searchParams.get('sslmode')?.trim().toLowerCase();
  const sslParam = parsed.searchParams.get('ssl')?.trim().toLowerCase();
  const normalizedCa = options.sslRootCert ? normalizePemCertificate(options.sslRootCert) : undefined;

  if (options.isProduction) {
    if (sslMode && INSECURE_PRODUCTION_SSL_MODES.has(sslMode)) {
      throw new Error(
        `${envVarName} uses insecure sslmode="${sslMode}" in production; use verified TLS (sslmode=verify-full or omit insecure overrides).`,
      );
    }
    if (sslParam && INSECURE_PRODUCTION_SSL_MODES.has(sslParam)) {
      throw new Error(
        `${envVarName} uses insecure ssl="${sslParam}" in production; certificate and hostname verification are mandatory.`,
      );
    }

    return normalizedCa ? { rejectUnauthorized: true, ca: normalizedCa } : 'verify-full';
  }

  const socketHost = parsed.searchParams.get('host')?.trim();
  const hostname = parsed.hostname.toLowerCase();
  const isLoopbackOrSocket =
    LOOPBACK_HOSTS.has(hostname) || (hostname === '' && Boolean(socketHost?.startsWith('/')));

  if (sslMode === 'disable' || sslParam === 'false' || sslParam === '0') {
    if (!isLoopbackOrSocket) {
      throw new Error(
        `${envVarName} cannot disable TLS for non-local host "${parsed.hostname || 'unknown'}".`,
      );
    }
    return false;
  }

  if (sslMode === 'verify-full' || sslMode === 'verify-ca' || !isLoopbackOrSocket) {
    return normalizedCa ? { rejectUnauthorized: true, ca: normalizedCa } : 'verify-full';
  }

  return false;
}

const runtimeEnvSchema = z.object({
  NODE_ENV: z.preprocess(
    emptyToUndefined,
    z.enum(['development', 'test', 'production']).default('development'),
  ),
  PORT: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(65535).default(3000),
  ),
  APP_URL: optionalUrl,
  ALLOWED_ORIGINS: optionalNonEmptyString,
  CSP_FRAME_ANCESTORS: optionalNonEmptyString,
  TRUST_PROXY_HOPS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(5).default(1),
  ),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  ),
});

const supabaseEnvSchema = z.object({
  SUPABASE_URL: optionalUrl,
  SUPABASE_ANON_KEY: optionalNonEmptyString,
  SUPABASE_SERVICE_ROLE_KEY: optionalNonEmptyString,
  VITE_SUPABASE_URL: optionalUrl,
  VITE_SUPABASE_ANON_KEY: optionalNonEmptyString,
});

const poolTuningSchema = z.object({
  DB_POOL_MAX: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(20).default(5),
  ),
  DB_IDLE_TIMEOUT_SECONDS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(5).max(300).default(20),
  ),
  DB_CONNECT_TIMEOUT_SECONDS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(2).max(60).default(10),
  ),
  DB_SSL_ROOT_CERT: optionalNonEmptyString,
});

const databaseEnvSchema = poolTuningSchema.extend({
  DATABASE_URL: optionalPostgresUrl,
  DIRECT_DATABASE_URL: optionalPostgresUrl,
});

const workerDatabaseEnvSchema = poolTuningSchema.extend({
  WORKER_DATABASE_URL: requiredPostgresUrl,
  WORKER_DB_POOL_MAX: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(10).default(2),
  ),
});

const migrationDatabaseEnvSchema = poolTuningSchema
  .pick({
    DB_IDLE_TIMEOUT_SECONDS: true,
    DB_CONNECT_TIMEOUT_SECONDS: true,
    DB_SSL_ROOT_CERT: true,
  })
  .extend({
    DIRECT_DATABASE_URL: requiredPostgresUrl,
  });

const geminiEnvSchema = z.object({
  GEMINI_API_KEY: optionalNonEmptyString,
});

export interface AppEnv {
  runtime: z.infer<typeof runtimeEnvSchema> & {
    logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
    allowedOrigins: string[];
    cspFrameAncestors: string[];
  };
  supabase: z.infer<typeof supabaseEnvSchema>;
  database: z.infer<typeof databaseEnvSchema>;
  gemini: z.infer<typeof geminiEnvSchema>;
}

export interface WorkerEnv {
  runtime: {
    NODE_ENV: 'development' | 'test' | 'production';
    logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  };
  database: z.infer<typeof workerDatabaseEnvSchema>;
  supabase: {
    SUPABASE_URL?: string;
    SUPABASE_SERVICE_ROLE_KEY?: string;
  };
}

export interface MigrationEnv {
  runtime: {
    NODE_ENV: 'development' | 'test' | 'production';
    logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  };
  database: z.infer<typeof migrationDatabaseEnvSchema>;
}

function normalizeOrigin(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

function parseTrustedHttpsOrigin(rawEntry: string): string {
  if (rawEntry.includes('*')) {
    throw new Error(`Wildcard origins are not permitted in CSP_FRAME_ANCESTORS: "${rawEntry}"`);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawEntry);
  } catch {
    throw new Error(`Invalid URL entry in CSP_FRAME_ANCESTORS: "${rawEntry}"`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Only HTTPS origins are permitted in CSP_FRAME_ANCESTORS: "${rawEntry}"`);
  }

  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error(
      `CSP_FRAME_ANCESTORS entries must be pure origins without paths or query strings: "${rawEntry}"`,
    );
  }

  return parsed.origin;
}

/**
 * Parses and validates runtime API server configuration.
 * Intentionally does NOT require `WORKER_DATABASE_URL` or initialize background worker credentials.
 */
export function parseEnv(rawEnv: NodeJS.ProcessEnv = process.env): AppEnv {
  const runtime = runtimeEnvSchema.parse(rawEnv);
  const supabase = supabaseEnvSchema.parse(rawEnv);
  const database = databaseEnvSchema.parse(rawEnv);
  const gemini = geminiEnvSchema.parse(rawEnv);

  const isProduction = runtime.NODE_ENV === 'production';
  if (database.DB_SSL_ROOT_CERT) {
    normalizePemCertificate(database.DB_SSL_ROOT_CERT);
  }
  if (database.DATABASE_URL) {
    resolvePostgresTlsConfig(database.DATABASE_URL, 'DATABASE_URL', {
      isProduction,
      sslRootCert: database.DB_SSL_ROOT_CERT,
    });
  }
  if (database.DIRECT_DATABASE_URL) {
    resolvePostgresTlsConfig(database.DIRECT_DATABASE_URL, 'DIRECT_DATABASE_URL', {
      isProduction,
      sslRootCert: database.DB_SSL_ROOT_CERT,
    });
  }

  const originSet = new Set<string>();
  if (runtime.APP_URL) {
    const appOrigin = normalizeOrigin(runtime.APP_URL);
    if (appOrigin) originSet.add(appOrigin);
  }
  if (runtime.ALLOWED_ORIGINS) {
    for (const candidate of runtime.ALLOWED_ORIGINS.split(',')) {
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      const normalized = normalizeOrigin(trimmed);
      if (!normalized) {
        throw new Error(`Invalid origin entry in ALLOWED_ORIGINS: "${trimmed}"`);
      }
      originSet.add(normalized);
    }
  }
  if (runtime.NODE_ENV !== 'production') {
    originSet.add(`http://localhost:${runtime.PORT}`);
    originSet.add(`http://127.0.0.1:${runtime.PORT}`);
  }

  const frameAncestorSet = new Set<string>();
  if (runtime.CSP_FRAME_ANCESTORS) {
    for (const candidate of runtime.CSP_FRAME_ANCESTORS.split(',')) {
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      frameAncestorSet.add(parseTrustedHttpsOrigin(trimmed));
    }
  }

  const defaultLogLevel = runtime.NODE_ENV === 'test' ? 'silent' : 'info';

  return {
    runtime: {
      ...runtime,
      logLevel: runtime.LOG_LEVEL ?? defaultLogLevel,
      allowedOrigins: Array.from(originSet),
      cspFrameAncestors: Array.from(frameAncestorSet),
    },
    supabase,
    database,
    gemini,
  };
}

export const parseApiEnv = parseEnv;

/**
 * Parses and validates dedicated background purge worker configuration.
 * Fails closed whenever `WORKER_DATABASE_URL` is absent or violates TLS policy.
 */
export function parseWorkerEnv(rawEnv: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const runtime = runtimeEnvSchema
    .pick({ NODE_ENV: true, LOG_LEVEL: true })
    .parse(rawEnv);
  const database = workerDatabaseEnvSchema.parse(rawEnv);
  const supabase = supabaseEnvSchema
    .pick({ SUPABASE_URL: true, SUPABASE_SERVICE_ROLE_KEY: true })
    .parse(rawEnv);

  const isProduction = runtime.NODE_ENV === 'production';
  if (database.DB_SSL_ROOT_CERT) {
    normalizePemCertificate(database.DB_SSL_ROOT_CERT);
  }

  resolvePostgresTlsConfig(database.WORKER_DATABASE_URL, 'WORKER_DATABASE_URL', {
    isProduction,
    sslRootCert: database.DB_SSL_ROOT_CERT,
  });

  const defaultLogLevel = runtime.NODE_ENV === 'test' ? 'silent' : 'info';

  return {
    runtime: {
      NODE_ENV: runtime.NODE_ENV,
      logLevel: runtime.LOG_LEVEL ?? defaultLogLevel,
    },
    database,
    supabase,
  };
}

/**
 * Parses and validates dedicated migration runner configuration.
 * Fails closed whenever `DIRECT_DATABASE_URL` is absent or violates TLS policy,
 * and never reads `DATABASE_URL` or `WORKER_DATABASE_URL`.
 */
export function parseMigrationEnv(rawEnv: NodeJS.ProcessEnv = process.env): MigrationEnv {
  const runtime = runtimeEnvSchema
    .pick({ NODE_ENV: true, LOG_LEVEL: true })
    .parse(rawEnv);
  const database = migrationDatabaseEnvSchema.parse(rawEnv);

  const isProduction = runtime.NODE_ENV === 'production';
  if (database.DB_SSL_ROOT_CERT) {
    normalizePemCertificate(database.DB_SSL_ROOT_CERT);
  }

  resolvePostgresTlsConfig(database.DIRECT_DATABASE_URL, 'DIRECT_DATABASE_URL', {
    isProduction,
    sslRootCert: database.DB_SSL_ROOT_CERT,
  });

  const defaultLogLevel = runtime.NODE_ENV === 'test' ? 'silent' : 'info';

  return {
    runtime: {
      NODE_ENV: runtime.NODE_ENV,
      logLevel: runtime.LOG_LEVEL ?? defaultLogLevel,
    },
    database,
  };
}

export interface ReadinessIntegrationFlags {
  runtimeConfigured: boolean;
  databaseConfigured: boolean;
  supabaseConfigured: boolean;
  geminiConfigured: boolean;
}

export function getIntegrationReadiness(appEnv: AppEnv): ReadinessIntegrationFlags {
  const supabaseUrl = appEnv.supabase.SUPABASE_URL ?? appEnv.supabase.VITE_SUPABASE_URL;
  const supabaseAnon = appEnv.supabase.SUPABASE_ANON_KEY ?? appEnv.supabase.VITE_SUPABASE_ANON_KEY;

  return {
    runtimeConfigured: true,
    databaseConfigured: Boolean(appEnv.database.DATABASE_URL),
    supabaseConfigured: Boolean(
      supabaseUrl && supabaseAnon && appEnv.supabase.SUPABASE_SERVICE_ROLE_KEY,
    ),
    geminiConfigured: Boolean(appEnv.gemini.GEMINI_API_KEY),
  };
}
