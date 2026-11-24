import { parseWorkerEnv } from './config/env';
import { createWorkerDbClient, closeWorkerDb } from './db/client';
import { createLogger } from './lib/logger';
import {
  createPostgresFilePurgeWorkerRepository,
  createPostgresFilePurgeLeaseRecoveryRepository,
} from './modules/lifecycle/postgresFilePurgeRepository';
import {
  createPostgresAccountPurgeRepository,
  createPostgresAccountPurgeLeaseRecoveryRepository,
} from './modules/lifecycle/postgresAccountPurgeRepository';
import { createPostgresExternalIdentityOutboxRepository } from './modules/lifecycle/postgresExternalIdentityOutboxRepository';
import { createSupabaseStorageObjectAdapter } from './modules/lifecycle/supabaseStorageObjectAdapter';
import { createSupabaseAuthAdminAdapter } from './modules/lifecycle/supabaseAuthAdminAdapter';
import { WorkerRunner, type ShutdownResult } from './modules/lifecycle/workerRunner';

async function main() {
  const workerEnv = parseWorkerEnv();
  const logger = createLogger(workerEnv.runtime.logLevel);

  let dbHandle: ReturnType<typeof createWorkerDbClient> | null = null;
  let runner: WorkerRunner | null = null;

  try {
    dbHandle = createWorkerDbClient(workerEnv);
    const db = dbHandle.db;

    const fileRepo = createPostgresFilePurgeWorkerRepository(db);
    const fileRecoveryRepo = createPostgresFilePurgeLeaseRecoveryRepository(db);
    const accountRepo = createPostgresAccountPurgeRepository(db);
    const accountRecoveryRepo = createPostgresAccountPurgeLeaseRecoveryRepository(db);
    const outboxRepo = createPostgresExternalIdentityOutboxRepository(db);

    const isProduction = workerEnv.runtime.NODE_ENV === 'production';

    const storage = createSupabaseStorageObjectAdapter({
      supabaseUrl: workerEnv.supabase.SUPABASE_URL,
      serviceRoleKey: workerEnv.supabase.SUPABASE_SERVICE_ROLE_KEY,
      isProduction,
    });

    const authAdmin = createSupabaseAuthAdminAdapter({
      supabaseUrl: workerEnv.supabase.SUPABASE_URL,
      serviceRoleKey: workerEnv.supabase.SUPABASE_SERVICE_ROLE_KEY,
      isProduction,
    });

    runner = new WorkerRunner({
      workerEnv,
      db,
      logger,
      fileRepo,
      fileRecoveryRepo,
      accountRepo,
      accountRecoveryRepo,
      outboxRepo,
      storage,
      authAdmin,
    });

    let shutdownTriggered = false;
    const handleShutdown = async (signal: string) => {
      if (shutdownTriggered) return;
      shutdownTriggered = true;
      logger.info({ signal }, 'Received shutdown signal in worker entry point.');

      try {
        const result: ShutdownResult = await runner!.stop(signal);
        if (!result.success) {
          logger.error({ state: result.state, activeCount: result.activeCount }, 'Worker shutdown incomplete or blocked.');
          process.exit(1);
        }
        process.exit(0);
      } catch (error) {
        logger.error({ error }, 'Error during worker shutdown orchestration.');
        process.exit(1);
      }
    };

    if (process.listenerCount('SIGTERM') === 0) {
      process.once('SIGTERM', () => void handleShutdown('SIGTERM'));
    }
    if (process.listenerCount('SIGINT') === 0) {
      process.once('SIGINT', () => void handleShutdown('SIGINT'));
    }

    runner.start();
    logger.info('Studexo dedicated lifecycle worker started successfully.');
  } catch (error) {
    logger.error({ error }, 'Fatal worker startup error.');
    if (dbHandle && !runner) {
      try {
        await closeWorkerDb();
      } catch (closeError) {
        logger.error({ error: closeError }, 'Error closing worker database client during startup cleanup.');
      }
    }
    process.exit(1);
  }
}

if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
  void main();
}
