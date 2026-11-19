import type { Logger } from 'pino';
import { closeWorkerDb, type StudexoDatabase } from '../../db/client';
import type { WorkerEnv } from '../../config/env';
import {
  type AccountPurgeRepository,
  type ExternalIdentityOutboxRepository,
  type FilePurgeWorkerRepository,
  type FilePurgeLeaseRecoveryRepository,
  type AccountPurgeLeaseRecoveryRepository,
  type StorageObjectAdapter,
  type SupabaseAuthAdminAdapter,
  processPendingStoredFileDeletion,
  executeStorageFirstAccountPurge,
  executeExternalIdentityOutboxPurge,
  recoverExpiredStoredFilePurgeLease,
  recoverInterruptedAccountPurge,
} from './storageAndPurge';

export type WorkerRunnerState =
  | 'RUNNING'
  | 'STOPPING'
  | 'DRAINING'
  | 'DRAINED'
  | 'SHUTDOWN_BLOCKED'
  | 'CLOSED';

export interface ShutdownResult {
  success: boolean;
  activeCount: number;
  state: WorkerRunnerState;
}

export interface WorkerRunnerOptions {
  workerEnv: WorkerEnv;
  db: StudexoDatabase;
  logger: Logger;
  fileRepo: FilePurgeWorkerRepository;
  fileRecoveryRepo: FilePurgeLeaseRecoveryRepository;
  accountRepo: AccountPurgeRepository;
  accountRecoveryRepo: AccountPurgeLeaseRecoveryRepository;
  outboxRepo: ExternalIdentityOutboxRepository;
  storage: StorageObjectAdapter;
  authAdmin: SupabaseAuthAdminAdapter;
  leaseOwner?: string;
  shutdownGracePeriodMs?: number;
  intervals?: {
    fileDeletionMs?: number;
    accountPurgeMs?: number;
    outboxMs?: number;
    leaseRecoveryMs?: number;
    reconciliationMs?: number;
  };
  batchLimits?: {
    fileDeletion?: number;
    accountPurge?: number;
    outbox?: number;
    leaseRecovery?: number;
    reconciliation?: number;
  };
}

export class WorkerRunner {
  private readonly logger: Logger;
  private readonly db: StudexoDatabase;
  private readonly fileRepo: FilePurgeWorkerRepository;
  private readonly fileRecoveryRepo: FilePurgeLeaseRecoveryRepository;
  private readonly accountRepo: AccountPurgeRepository;
  private readonly accountRecoveryRepo: AccountPurgeLeaseRecoveryRepository;
  private readonly outboxRepo: ExternalIdentityOutboxRepository;
  private readonly storage: StorageObjectAdapter;
  private readonly authAdmin: SupabaseAuthAdminAdapter;
  private readonly leaseOwner: string;
  private readonly shutdownGracePeriodMs: number;

  private readonly intervalsMs: {
    fileDeletion: number;
    accountPurge: number;
    outbox: number;
    leaseRecovery: number;
    reconciliation: number;
  };

  private readonly batchLimits: {
    fileDeletion: number;
    accountPurge: number;
    outbox: number;
    leaseRecovery: number;
    reconciliation: number;
  };

  private isRunning = false;
  private isShuttingDown = false;
  private state: WorkerRunnerState = 'RUNNING';
  private timers: NodeJS.Timeout[] = [];
  private readonly activeOperations = new Set<Promise<unknown>>();
  private shutdownPromise: Promise<ShutdownResult> | null = null;

  private readonly runningLoops = {
    fileDeletion: false,
    accountPurge: false,
    outbox: false,
    leaseRecovery: false,
    reconciliation: false,
  };

  constructor(options: WorkerRunnerOptions) {
    this.logger = options.logger.child({ component: 'lifecycle-worker-runner' });
    this.db = options.db;
    this.fileRepo = options.fileRepo;
    this.fileRecoveryRepo = options.fileRecoveryRepo;
    this.accountRepo = options.accountRepo;
    this.accountRecoveryRepo = options.accountRecoveryRepo;
    this.outboxRepo = options.outboxRepo;
    this.storage = options.storage;
    this.authAdmin = options.authAdmin;
    this.leaseOwner = (options.leaseOwner ?? 'studexo-purge-worker').trim();
    this.shutdownGracePeriodMs = options.shutdownGracePeriodMs ?? 45_000;

    this.intervalsMs = {
      fileDeletion: options.intervals?.fileDeletionMs ?? 10_000,
      accountPurge: options.intervals?.accountPurgeMs ?? 30_000,
      outbox: options.intervals?.outboxMs ?? 15_000,
      leaseRecovery: options.intervals?.leaseRecoveryMs ?? 60_000,
      reconciliation: options.intervals?.reconciliationMs ?? 300_000,
    };

    this.batchLimits = {
      fileDeletion: options.batchLimits?.fileDeletion ?? 10,
      accountPurge: options.batchLimits?.accountPurge ?? 5,
      outbox: options.batchLimits?.outbox ?? 10,
      leaseRecovery: options.batchLimits?.leaseRecovery ?? 10,
      reconciliation: options.batchLimits?.reconciliation ?? 5,
    };
  }

  public getState(): WorkerRunnerState {
    return this.state;
  }

  public start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.isShuttingDown = false;
    this.state = 'RUNNING';

    this.logger.info({ leaseOwner: this.leaseOwner }, 'Starting lifecycle worker runner loops.');

    if (typeof process !== 'undefined') {
      if (process.listenerCount('SIGTERM') === 0) {
        process.once('SIGTERM', () => {
          void this.stop('SIGTERM');
        });
      }
      if (process.listenerCount('SIGINT') === 0) {
        process.once('SIGINT', () => {
          void this.stop('SIGINT');
        });
      }
    }

    this.scheduleLoop('fileDeletion', this.intervalsMs.fileDeletion, () => this.pollFileDeletions());
    this.scheduleLoop('accountPurge', this.intervalsMs.accountPurge, () => this.pollAccountPurges());
    this.scheduleLoop('outbox', this.intervalsMs.outbox, () => this.pollOutbox());
    this.scheduleLoop('leaseRecovery', this.intervalsMs.leaseRecovery, () => this.pollLeaseRecovery());
    this.scheduleLoop('reconciliation', this.intervalsMs.reconciliation, () => this.pollReconciliation());
  }

  private scheduleLoop(
    loopName: keyof typeof this.runningLoops,
    intervalMs: number,
    task: () => Promise<void>,
  ): void {
    const timer = setInterval(() => {
      if (!this.isRunning || this.isShuttingDown) {
        return;
      }
      if (this.runningLoops[loopName]) {
        return; // sequential guard: skip if previous poll is still active
      }

      this.runningLoops[loopName] = true;
      const op = task()
        .catch((error) => {
          this.logger.error({ loopName, error }, 'Lifecycle worker loop iteration failed.');
        })
        .finally(() => {
          this.runningLoops[loopName] = false;
          this.activeOperations.delete(op);
        });

      this.activeOperations.add(op);
    }, intervalMs);

    timer.unref?.();
    this.timers.push(timer);
  }

  private async pollFileDeletions(): Promise<void> {
    if (!this.isRunning || this.isShuttingDown) return;
    try {
      const files = await this.fileRepo.listDueFilesForPurge(this.batchLimits.fileDeletion);
      for (const file of files) {
        if (!this.isRunning || this.isShuttingDown) break;
        const op = processPendingStoredFileDeletion({
          fileId: file.id,
          ownerUserId: file.ownerUserId,
          repo: this.fileRepo,
          storage: this.storage,
        })
          .catch((error) => {
            this.logger.error({ fileId: file.id, error }, 'Failed processing pending file deletion.');
          })
          .finally(() => {
            this.activeOperations.delete(op);
          });
        this.activeOperations.add(op);
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed listing due files for purge.');
    }
  }

  private async pollAccountPurges(): Promise<void> {
    if (!this.isRunning || this.isShuttingDown) return;
    try {
      const users = await this.accountRepo.listDueUsersForPurge(this.batchLimits.accountPurge);
      for (const user of users) {
        if (!this.isRunning || this.isShuttingDown) break;
        const op = executeStorageFirstAccountPurge({
          userId: user.id,
          leaseOwner: this.leaseOwner,
          accountRepo: this.accountRepo,
          fileRepo: this.fileRepo,
          storage: this.storage,
        })
          .catch((error) => {
            this.logger.error({ userId: user.id, error }, 'Failed executing account purge.');
          })
          .finally(() => {
            this.activeOperations.delete(op);
          });
        this.activeOperations.add(op);
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed listing due users for purge.');
    }
  }

  private async pollOutbox(): Promise<void> {
    if (!this.isRunning || this.isShuttingDown) return;
    try {
      const items = await this.outboxRepo.claimDueOutboxItems({
        leaseOwner: this.leaseOwner,
        leaseSeconds: 60,
        limit: this.batchLimits.outbox,
      });

      for (const item of items) {
        if (!this.isRunning || this.isShuttingDown) break;
        const op = executeExternalIdentityOutboxPurge({
          outboxId: item.id,
          leaseOwner: this.leaseOwner,
          repo: this.outboxRepo,
          authAdmin: this.authAdmin,
        })
          .catch((error) => {
            this.logger.error({ outboxId: item.id, error }, 'Failed executing external identity outbox purge.');
          })
          .finally(() => {
            this.activeOperations.delete(op);
          });
        this.activeOperations.add(op);
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed claiming due outbox items.');
    }
  }

  private async pollLeaseRecovery(): Promise<void> {
    if (!this.isRunning || this.isShuttingDown) return;
    try {
      const now = new Date();
      const expiredFiles = await this.fileRepo.listExpiredPurgeLeases(this.batchLimits.leaseRecovery);
      for (const file of expiredFiles) {
        if (!this.isRunning || this.isShuttingDown) break;
        const op = recoverExpiredStoredFilePurgeLease({
          file,
          now,
          repo: this.fileRecoveryRepo,
        })
          .catch((error) => {
            this.logger.error({ fileId: file.id, error }, 'Failed recovering expired file purge lease.');
          })
          .finally(() => {
            this.activeOperations.delete(op);
          });
        this.activeOperations.add(op);
      }

      const expiredUsers = await this.accountRepo.listExpiredAccountPurges(this.batchLimits.leaseRecovery);
      for (const user of expiredUsers) {
        if (!this.isRunning || this.isShuttingDown) break;
        const op = recoverInterruptedAccountPurge({
          userId: user.id,
          now,
          accountRepo: this.accountRepo,
          fileRecoveryRepo: this.fileRecoveryRepo,
          recoveryRepo: this.accountRecoveryRepo,
          storage: this.storage,
        })
          .catch((error) => {
            this.logger.error({ userId: user.id, error }, 'Failed recovering interrupted account purge.');
          })
          .finally(() => {
            this.activeOperations.delete(op);
          });
        this.activeOperations.add(op);
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed polling lease recovery.');
    }
  }

  private async pollReconciliation(): Promise<void> {
    if (!this.isRunning || this.isShuttingDown) return;
    try {
      const items = await this.outboxRepo.listDueExhaustedOutboxItems({
        limit: this.batchLimits.reconciliation,
      });

      for (const item of items) {
        if (!this.isRunning || this.isShuttingDown) break;
        const op = executeExternalIdentityOutboxPurge({
          outboxId: item.id,
          leaseOwner: this.leaseOwner,
          repo: this.outboxRepo,
          authAdmin: this.authAdmin,
          allowExhaustedReconciliation: true,
        })
          .catch((error) => {
            this.logger.error(
              { outboxId: item.id, error },
              'Failed executing external identity exhausted reconciliation.',
            );
          })
          .finally(() => {
            this.activeOperations.delete(op);
          });
        this.activeOperations.add(op);
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed polling exhausted reconciliation.');
    }
  }

  public async stop(signal?: string): Promise<ShutdownResult> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    if (this.state === 'CLOSED' || this.state === 'SHUTDOWN_BLOCKED') {
      return {
        success: this.state === 'CLOSED',
        activeCount: this.activeOperations.size,
        state: this.state,
      };
    }

    if (!this.isRunning && !this.isShuttingDown) {
      this.state = 'CLOSED';
      return {
        success: true,
        activeCount: 0,
        state: this.state,
      };
    }

    this.state = 'STOPPING';
    this.isShuttingDown = true;
    this.isRunning = false;

    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];

    this.logger.info({ signal }, 'Initiating graceful shutdown of lifecycle worker runner.');
    this.state = 'DRAINING';

    this.shutdownPromise = (async (): Promise<ShutdownResult> => {
      const deadline = Date.now() + this.shutdownGracePeriodMs;
      while (this.activeOperations.size > 0 && Date.now() < deadline) {
        await Promise.race([
          Promise.allSettled(Array.from(this.activeOperations)),
          new Promise((resolve) => setTimeout(resolve, 100)),
        ]);
      }

      const activeCount = this.activeOperations.size;
      if (activeCount > 0) {
        this.state = 'SHUTDOWN_BLOCKED';
        this.logger.error(
          { activeCount, state: this.state },
          'Shutdown grace period expired with active lifecycle operations remaining. Database pool NOT closed to prevent breaking active operations.',
        );
        return {
          success: false,
          activeCount,
          state: this.state,
        };
      }

      this.state = 'DRAINED';
      try {
        await closeWorkerDb();
        this.state = 'CLOSED';
        this.logger.info('Worker database connection pool closed successfully.');
        return {
          success: true,
          activeCount: 0,
          state: this.state,
        };
      } catch (error) {
        this.state = 'SHUTDOWN_BLOCKED';
        this.logger.error({ error }, 'Error closing worker database connection pool.');
        return {
          success: false,
          activeCount: 0,
          state: this.state,
        };
      }
    })();

    return this.shutdownPromise;
  }
}
