import type { AppEnv } from '../config/env';

export {
  buildPostgresClientOptions,
  checkDatabaseReadiness,
  closeAllDbs,
  closeDb,
  closeWorkerDb,
  createRuntimeDbClient,
  createWorkerDbClient,
  DatabaseNotConfiguredError,
  getDb,
  getMigrationConnectionConfig,
  getWorkerDb,
  hasActiveDbClient,
  hasActiveWorkerDbClient,
  type DatabaseReadinessResult,
  type MigrationConnectionConfig,
  type RuntimeDatabaseClientHandle,
  type StudexoDatabase,
} from './client';
export * from './schema/index';

export interface DatabaseConfigStatus {
  configured: boolean;
  connected: false;
  poolMax: number;
  idleTimeoutSeconds: number;
  connectTimeoutSeconds: number;
}

/**
 * Non-connecting database configuration descriptor.
 * Phase 8B.2A wires schema and lazy client factories without initiating live DB connections.
 */
export function getDatabaseConfigStatus(appEnv: AppEnv): DatabaseConfigStatus {
  return {
    configured: Boolean(appEnv.database.DATABASE_URL),
    connected: false as const,
    poolMax: appEnv.database.DB_POOL_MAX,
    idleTimeoutSeconds: appEnv.database.DB_IDLE_TIMEOUT_SECONDS,
    connectTimeoutSeconds: appEnv.database.DB_CONNECT_TIMEOUT_SECONDS,
  };
}
