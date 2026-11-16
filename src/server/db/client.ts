import crypto from 'node:crypto';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import {
  resolvePostgresTlsConfig,
  type AppEnv,
  type PostgresSslSetting,
  type WorkerEnv,
} from '../config/env';
import * as schema from './schema/index';

export type StudexoDatabase = PostgresJsDatabase<typeof schema>;

export interface RuntimeDatabaseClientHandle {
  db: StudexoDatabase;
  sql: Sql;
}

export interface MigrationConnectionConfig {
  dialect: 'postgresql';
  schemaFilter: readonly ['studexo'];
  migrationsDir: './drizzle';
  migrationsSchema: 'drizzle';
  migrationsTable: '__drizzle_migrations';
  urlConfigured: true;
  directConnectionRequiredNote: string;
}

export interface DatabaseReadinessResult {
  configured: boolean;
  connected: boolean;
}

export class DatabaseNotConfiguredError extends Error {
  readonly code = 'DATABASE_NOT_CONFIGURED';

  constructor(message: string) {
    super(message);
    this.name = 'DatabaseNotConfiguredError';
  }
}

let activeHandle: RuntimeDatabaseClientHandle | null = null;
let activeConfigDigest: string | null = null;

let activeWorkerHandle: RuntimeDatabaseClientHandle | null = null;
let activeWorkerConfigDigest: string | null = null;

function computePoolConfigDigest(
  url: string,
  max: number,
  idleTimeoutSeconds: number,
  connectTimeoutSeconds: number,
  isProduction: boolean,
  sslRootCert?: string,
): string {
  return crypto
    .createHash('sha256')
    .update(
      `${url}|${max}|${idleTimeoutSeconds}|${connectTimeoutSeconds}|${isProduction}|${sslRootCert ?? ''}`,
    )
    .digest('hex');
}

export function buildPostgresClientOptions(params: {
  connectionString: string;
  envVarName: string;
  isProduction: boolean;
  max: number;
  idleTimeoutSeconds: number;
  connectTimeoutSeconds: number;
  sslRootCert?: string;
}): {
  prepare: false;
  max: number;
  idle_timeout: number;
  connect_timeout: number;
  ssl: PostgresSslSetting;
  onnotice: () => void;
} {
  const ssl = resolvePostgresTlsConfig(params.connectionString, params.envVarName, {
    isProduction: params.isProduction,
    sslRootCert: params.sslRootCert,
  });

  return {
    prepare: false,
    max: params.max,
    idle_timeout: params.idleTimeoutSeconds,
    connect_timeout: params.connectTimeoutSeconds,
    ssl,
    onnotice: () => {},
  };
}

/**
 * Creates a lazily pooled postgres.js + Drizzle runtime API database client (`studexo_app`).
 * `postgres()` does not open a network socket until a query is executed,
 * and `prepare: false` is enforced for Supavisor transaction-pooler compatibility.
 */
export function createRuntimeDbClient(appEnv: AppEnv): RuntimeDatabaseClientHandle {
  const databaseUrl = appEnv.database.DATABASE_URL;
  if (!databaseUrl) {
    throw new DatabaseNotConfiguredError(
      'Runtime database client requested, but DATABASE_URL is not configured.',
    );
  }

  const sqlClient = postgres(
    databaseUrl,
    buildPostgresClientOptions({
      connectionString: databaseUrl,
      envVarName: 'DATABASE_URL',
      isProduction: appEnv.runtime.NODE_ENV === 'production',
      max: appEnv.database.DB_POOL_MAX,
      idleTimeoutSeconds: appEnv.database.DB_IDLE_TIMEOUT_SECONDS,
      connectTimeoutSeconds: appEnv.database.DB_CONNECT_TIMEOUT_SECONDS,
      sslRootCert: appEnv.database.DB_SSL_ROOT_CERT,
    }),
  );

  const db = drizzle(sqlClient, { schema });
  return { db, sql: sqlClient };
}

function getRuntimeHandle(appEnv: AppEnv): RuntimeDatabaseClientHandle {
  const databaseUrl = appEnv.database.DATABASE_URL;
  if (!databaseUrl) {
    throw new DatabaseNotConfiguredError(
      'Runtime database query attempted, but DATABASE_URL is not configured.',
    );
  }

  const digest = computePoolConfigDigest(
    databaseUrl,
    appEnv.database.DB_POOL_MAX,
    appEnv.database.DB_IDLE_TIMEOUT_SECONDS,
    appEnv.database.DB_CONNECT_TIMEOUT_SECONDS,
    appEnv.runtime.NODE_ENV === 'production',
    appEnv.database.DB_SSL_ROOT_CERT,
  );
  if (activeHandle && activeConfigDigest === digest) {
    return activeHandle;
  }

  if (activeHandle) {
    const previous = activeHandle.sql;
    activeHandle = null;
    activeConfigDigest = null;
    void previous.end({ timeout: 5 }).catch(() => {});
  }

  activeHandle = createRuntimeDbClient(appEnv);
  activeConfigDigest = digest;
  return activeHandle;
}

/**
 * Returns the process-level lazy Drizzle runtime API client (`studexo_app`).
 * Never opens a connection on import or server startup.
 */
export function getDb(appEnv: AppEnv): StudexoDatabase {
  return getRuntimeHandle(appEnv).db;
}

export function hasActiveDbClient(): boolean {
  return activeHandle !== null;
}

export async function closeDb(): Promise<void> {
  if (!activeHandle) {
    return;
  }

  const sqlClient = activeHandle.sql;
  activeHandle = null;
  activeConfigDigest = null;
  await sqlClient.end({ timeout: 5 });
}

/**
 * Creates a lazily pooled postgres.js + Drizzle client strictly for background purge workers
 * (`studexo_purge_worker` via `WORKER_DATABASE_URL`). Isolated from API runtime pools.
 */
export function createWorkerDbClient(workerEnv: WorkerEnv): RuntimeDatabaseClientHandle {
  const workerDatabaseUrl = workerEnv.database.WORKER_DATABASE_URL;
  if (!workerDatabaseUrl) {
    throw new DatabaseNotConfiguredError(
      'Worker database client requested, but WORKER_DATABASE_URL is not configured.',
    );
  }

  const sqlClient = postgres(
    workerDatabaseUrl,
    buildPostgresClientOptions({
      connectionString: workerDatabaseUrl,
      envVarName: 'WORKER_DATABASE_URL',
      isProduction: workerEnv.runtime.NODE_ENV === 'production',
      max: workerEnv.database.WORKER_DB_POOL_MAX,
      idleTimeoutSeconds: workerEnv.database.DB_IDLE_TIMEOUT_SECONDS,
      connectTimeoutSeconds: workerEnv.database.DB_CONNECT_TIMEOUT_SECONDS,
      sslRootCert: workerEnv.database.DB_SSL_ROOT_CERT,
    }),
  );

  const db = drizzle(sqlClient, { schema });
  return { db, sql: sqlClient };
}

export function getWorkerDb(workerEnv: WorkerEnv): StudexoDatabase {
  const workerDatabaseUrl = workerEnv.database.WORKER_DATABASE_URL;
  if (!workerDatabaseUrl) {
    throw new DatabaseNotConfiguredError(
      'Worker database query attempted, but WORKER_DATABASE_URL is not configured.',
    );
  }

  const digest = computePoolConfigDigest(
    workerDatabaseUrl,
    workerEnv.database.WORKER_DB_POOL_MAX,
    workerEnv.database.DB_IDLE_TIMEOUT_SECONDS,
    workerEnv.database.DB_CONNECT_TIMEOUT_SECONDS,
    workerEnv.runtime.NODE_ENV === 'production',
    workerEnv.database.DB_SSL_ROOT_CERT,
  );
  if (activeWorkerHandle && activeWorkerConfigDigest === digest) {
    return activeWorkerHandle.db;
  }

  if (activeWorkerHandle) {
    const previous = activeWorkerHandle.sql;
    activeWorkerHandle = null;
    activeWorkerConfigDigest = null;
    void previous.end({ timeout: 5 }).catch(() => {});
  }

  activeWorkerHandle = createWorkerDbClient(workerEnv);
  activeWorkerConfigDigest = digest;
  return activeWorkerHandle.db;
}

export function hasActiveWorkerDbClient(): boolean {
  return activeWorkerHandle !== null;
}

export async function closeWorkerDb(): Promise<void> {
  if (!activeWorkerHandle) {
    return;
  }

  const sqlClient = activeWorkerHandle.sql;
  activeWorkerHandle = null;
  activeWorkerConfigDigest = null;
  await sqlClient.end({ timeout: 5 });
}

export async function closeAllDbs(): Promise<void> {
  await Promise.all([closeDb(), closeWorkerDb()]);
}

const DEFAULT_READINESS_PROBE_TIMEOUT_MS = 2000;

/**
 * Executes a bounded `SELECT 1` readiness probe against the configured runtime database.
 * Returns `{ configured: false, connected: false }` without creating any client when unset,
 * and catches/masks all driver errors so `/api/ready` never leaks credentials or SQL internals.
 */
export async function checkDatabaseReadiness(
  appEnv: AppEnv,
  timeoutMs: number = DEFAULT_READINESS_PROBE_TIMEOUT_MS,
): Promise<DatabaseReadinessResult> {
  if (!appEnv.database.DATABASE_URL) {
    return { configured: false, connected: false };
  }

  const boundedTimeoutMs = Math.max(50, Math.min(timeoutMs, 10_000));
  const { sql } = getRuntimeHandle(appEnv);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const queryPromise = sql`SELECT 1 AS ok`
    .then(() => true)
    .catch(() => false);

  const timeoutPromise = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), boundedTimeoutMs);
    timer.unref?.();
  });

  try {
    const connected = await Promise.race([queryPromise, timeoutPromise]);
    return { configured: true, connected };
  } catch {
    return { configured: true, connected: false };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Validates that DIRECT_DATABASE_URL is configured for Drizzle Kit migrations (`studexo_migrator`)
 * without returning or logging the secret connection string.
 */
export function getMigrationConnectionConfig(appEnv: AppEnv): MigrationConnectionConfig {
  if (!appEnv.database.DIRECT_DATABASE_URL) {
    throw new DatabaseNotConfiguredError(
      'Migration configuration requested, but DIRECT_DATABASE_URL is not configured.',
    );
  }

  resolvePostgresTlsConfig(appEnv.database.DIRECT_DATABASE_URL, 'DIRECT_DATABASE_URL', {
    isProduction: appEnv.runtime.NODE_ENV === 'production',
    sslRootCert: appEnv.database.DB_SSL_ROOT_CERT,
  });

  return {
    dialect: 'postgresql',
    schemaFilter: ['studexo'],
    migrationsDir: './drizzle',
    migrationsSchema: 'drizzle',
    migrationsTable: '__drizzle_migrations',
    urlConfigured: true,
    directConnectionRequiredNote:
      'Migrations must use DIRECT_DATABASE_URL (session/direct port 5432) via `db:migrate`, never the transaction pooler.',
  };
}
