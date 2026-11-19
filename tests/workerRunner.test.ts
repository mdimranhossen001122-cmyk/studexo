import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WorkerRunner } from '../src/server/modules/lifecycle/workerRunner';
import type { StudexoDatabase } from '../src/server/db/client';
import type { WorkerEnv } from '../src/server/config/env';
import type {
  AccountPurgeRepository,
  ExternalIdentityOutboxRepository,
  FilePurgeWorkerRepository,
  FilePurgeLeaseRecoveryRepository,
  AccountPurgeLeaseRecoveryRepository,
  StorageObjectAdapter,
  SupabaseAuthAdminAdapter,
  ExternalIdentityOutboxRecord,
} from '../src/server/modules/lifecycle/storageAndPurge';
import { createLogger } from '../src/server/lib/logger';

const closeWorkerDbMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/server/db/client', () => ({
  closeWorkerDb: () => closeWorkerDbMock(),
}));

describe('Phase 8B.4E.1.2.2: Worker Shutdown Safety Hardening', () => {
  const dummyEnv: WorkerEnv = {
    runtime: { NODE_ENV: 'test', logLevel: 'silent' },
    database: { WORKER_DATABASE_URL: 'postgres://test:test@localhost:5432/test', DB_POOL_MAX: 2, WORKER_DB_POOL_MAX: 2, DB_IDLE_TIMEOUT_SECONDS: 10, DB_CONNECT_TIMEOUT_SECONDS: 5 },
    supabase: {},
  };

  const logger = createLogger('silent');

  beforeEach(() => {
    vi.clearAllMocks();
    closeWorkerDbMock.mockResolvedValue(undefined);
  });

  const createDummyRepos = () => {
    const fileRepo: FilePurgeWorkerRepository = {
      getFileForPurge: async () => null,
      markFilePendingPurge: async () => null,
      acquireFilePurgeLeaseIfUnreferenced: async () => ({ status: 'unavailable', reason: 'not_found', file: null }),
      acquireFilePurgeLease: async () => null,
      markFilePurged: async () => {},
      markFilePurgeFailed: async () => {},
      revertPendingPurgeToNone: async () => {},
      listDueFilesForPurge: async () => [],
      listExpiredPurgeLeases: async () => [],
    };

    const accountRepo: AccountPurgeRepository = {
      getUserForPurge: async () => null,
      markUserPurging: async () => null,
      markUserPurgeFailed: async () => {},
      listUserStoredFiles: async () => [],
      executeAccountPurgeRpc: async () => {},
      listDueUsersForPurge: async () => [],
      listExpiredAccountPurges: async () => [],
    };

    const outboxRepo: ExternalIdentityOutboxRepository = {
      getOutboxItemById: async () => null,
      acquireOutboxLease: async () => ({ status: 'unavailable', reason: 'not_found', item: null }),
      claimDueOutboxItems: async () => [],
      listDueExhaustedOutboxItems: async () => [],
      markOutboxPurged: async () => ({ status: 'updated', item: {} as ExternalIdentityOutboxRecord }),
      markOutboxPurgeFailed: async () => ({ status: 'updated', item: {} as ExternalIdentityOutboxRecord }),
    };

    const fileRecoveryRepo: FilePurgeLeaseRecoveryRepository = {
      markExpiredPurgeLeaseFailed: async () => null,
    };

    const accountRecoveryRepo: AccountPurgeLeaseRecoveryRepository = {
      markExpiredAccountPurgeLeaseFailed: async () => null,
      findExternalIdentityOutboxByAuthUserId: async () => null,
    };

    const storage: StorageObjectAdapter = {
      removeObject: async () => {},
      verifyObjectAbsent: async () => true,
    };

    const authAdmin: SupabaseAuthAdminAdapter = {
      deleteUserById: async () => ({ status: 'deleted' }),
    };

    return { fileRepo, accountRepo, outboxRepo, fileRecoveryRepo, accountRecoveryRepo, storage, authAdmin };
  };

  it('1. Shutdown with no active operations transitions to CLOSED and closes DB pool', async () => {
    const repos = createDummyRepos();
    const runner = new WorkerRunner({
      workerEnv: dummyEnv,
      db: {} as StudexoDatabase,
      logger,
      ...repos,
    });

    runner.start();
    const result = await runner.stop('SIGTERM');

    expect(result.success).toBe(true);
    expect(result.state).toBe('CLOSED');
    expect(result.activeCount).toBe(0);
    expect(closeWorkerDbMock).toHaveBeenCalled();
  });

  it('2. Shutdown with an operation finishing before deadline succeeds', async () => {
    const repos = createDummyRepos();
    let opFinished = false;
    repos.fileRepo.listDueFilesForPurge = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      opFinished = true;
      return [];
    };

    const runner = new WorkerRunner({
      workerEnv: dummyEnv,
      db: {} as StudexoDatabase,
      logger,
      ...repos,
      intervals: { fileDeletionMs: 10 },
      shutdownGracePeriodMs: 1000,
    });

    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 15));

    const result = await runner.stop('SIGTERM');
    expect(opFinished).toBe(true);
    expect(result.success).toBe(true);
    expect(result.state).toBe('CLOSED');
    expect(closeWorkerDbMock).toHaveBeenCalled();
  });

  it('3 & 4. Operation still active at deadline results in SHUTDOWN_BLOCKED and DB pool NOT closed', async () => {
    const repos = createDummyRepos();
    let opPending = true;
    repos.fileRepo.listDueFilesForPurge = async () => {
      await new Promise((resolve) => {
        const check = setInterval(() => {
          if (!opPending) {
            clearInterval(check);
            resolve(undefined);
          }
        }, 10);
      });
      return [];
    };

    const runner = new WorkerRunner({
      workerEnv: dummyEnv,
      db: {} as StudexoDatabase,
      logger,
      ...repos,
      intervals: { fileDeletionMs: 5 },
      shutdownGracePeriodMs: 50, // short grace period
    });

    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await runner.stop('SIGTERM');
    expect(result.success).toBe(false);
    expect(result.state).toBe('SHUTDOWN_BLOCKED');
    expect(result.activeCount).toBeGreaterThan(0);
    expect(closeWorkerDbMock).not.toHaveBeenCalled();

    // cleanup
    opPending = false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('5. Pool closes after the last active operation settles (if drained within grace period)', async () => {
    const repos = createDummyRepos();
    repos.fileRepo.listDueFilesForPurge = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return [];
    };

    const runner = new WorkerRunner({
      workerEnv: dummyEnv,
      db: {} as StudexoDatabase,
      logger,
      ...repos,
      intervals: { fileDeletionMs: 5 },
      shutdownGracePeriodMs: 500,
    });

    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await runner.stop('SIGTERM');
    expect(result.success).toBe(true);
    expect(result.state).toBe('CLOSED');
    expect(closeWorkerDbMock).toHaveBeenCalled();
  });

  it('6. Multiple simultaneous stop() calls are idempotent', async () => {
    const repos = createDummyRepos();
    const runner = new WorkerRunner({
      workerEnv: dummyEnv,
      db: {} as StudexoDatabase,
      logger,
      ...repos,
    });

    runner.start();
    const [res1, res2, res3] = await Promise.all([
      runner.stop('SIGTERM'),
      runner.stop('SIGTERM'),
      runner.stop('SIGTERM'),
    ]);

    expect(res1).toEqual(res2);
    expect(res2).toEqual(res3);
    expect(res1.state).toBe('CLOSED');
    expect(closeWorkerDbMock).toHaveBeenCalledTimes(1);
  });

  it('7. SIGTERM followed by SIGINT handles signals idempotently', async () => {
    const repos = createDummyRepos();
    const runner = new WorkerRunner({
      workerEnv: dummyEnv,
      db: {} as StudexoDatabase,
      logger,
      ...repos,
    });

    runner.start();
    const r1 = await runner.stop('SIGTERM');
    const r2 = await runner.stop('SIGINT');

    expect(r1.state).toBe('CLOSED');
    expect(r2.state).toBe('CLOSED');
    expect(closeWorkerDbMock).toHaveBeenCalledTimes(1);
  });

  it('8. Operation rejection during shutdown is caught safely', async () => {
    const repos = createDummyRepos();
    repos.fileRepo.listDueFilesForPurge = async () => {
      throw new Error('Database connection reset during query');
    };

    const runner = new WorkerRunner({
      workerEnv: dummyEnv,
      db: {} as StudexoDatabase,
      logger,
      ...repos,
      intervals: { fileDeletionMs: 5 },
    });

    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 15));

    const result = await runner.stop('SIGTERM');
    expect(result.success).toBe(true);
    expect(result.state).toBe('CLOSED');
    expect(closeWorkerDbMock).toHaveBeenCalled();
  });

  it('9. Database close failure sets state to SHUTDOWN_BLOCKED and returns success: false', async () => {
    closeWorkerDbMock.mockRejectedValueOnce(new Error('Failed to disconnect pool'));
    const repos = createDummyRepos();
    const runner = new WorkerRunner({
      workerEnv: dummyEnv,
      db: {} as StudexoDatabase,
      logger,
      ...repos,
    });

    runner.start();
    const result = await runner.stop('SIGTERM');

    expect(result.success).toBe(false);
    expect(result.state).toBe('SHUTDOWN_BLOCKED');
  });

  it('10. Incomplete shutdown result and correct exit policy structure', async () => {
    const repos = createDummyRepos();
    let keepRunning = true;
    repos.fileRepo.listDueFilesForPurge = async () => {
      while (keepRunning) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return [];
    };

    const runner = new WorkerRunner({
      workerEnv: dummyEnv,
      db: {} as StudexoDatabase,
      logger,
      ...repos,
      intervals: { fileDeletionMs: 5 },
      shutdownGracePeriodMs: 30,
    });

    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await runner.stop('SIGTERM');
    expect(result.success).toBe(false);
    expect(result.state).toBe('SHUTDOWN_BLOCKED');
    expect(closeWorkerDbMock).not.toHaveBeenCalled();

    keepRunning = false;
  });

  it('11. No new claims after shutdown begins', async () => {
    const repos = createDummyRepos();
    let claimCount = 0;
    repos.fileRepo.listDueFilesForPurge = async () => {
      claimCount++;
      return [];
    };

    const runner = new WorkerRunner({
      workerEnv: dummyEnv,
      db: {} as StudexoDatabase,
      logger,
      ...repos,
      intervals: { fileDeletionMs: 10 },
    });

    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 15));
    const countBeforeStop = claimCount;

    await runner.stop('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Claim count should not increase after stop
    expect(claimCount).toBe(countBeforeStop);
  });

  it('12. Recovery of interrupted work through existing lease-recovery mechanisms during run', async () => {
    const repos = createDummyRepos();
    const listExpiredSpy = vi.spyOn(repos.fileRepo, 'listExpiredPurgeLeases').mockResolvedValue([]);
    const runner = new WorkerRunner({
      workerEnv: dummyEnv,
      db: {} as StudexoDatabase,
      logger,
      ...repos,
      intervals: { leaseRecoveryMs: 20 },
    });

    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runner.stop('SIGTERM');

    expect(listExpiredSpy).toHaveBeenCalled();
  });

  it('13. Reconciliation polling discovers and processes due exhausted candidates with allowExhaustedReconciliation: true', async () => {
    const repos = createDummyRepos();
    const exhaustedItem: ExternalIdentityOutboxRecord = {
      id: 'outbox-exhausted-1',
      formerUserId: 'user-1',
      supabaseAuthUserId: 'auth-sub-1',
      status: 'purge_failed',
      attemptCount: 10,
      maxAttempts: 10,
      nextAttemptAt: new Date(Date.now() - 5000),
      leaseOwner: null,
      lockedUntil: null,
      lastErrorCode: 'TIMEOUT',
      lastErrorMessage: 'Provider timeout',
      completedAt: null,
    };

    let discovered = false;
    let reconciled = false;
    let allowReconcileFlag: boolean | undefined;

    repos.outboxRepo.listDueExhaustedOutboxItems = async () => {
      discovered = true;
      return [exhaustedItem];
    };

    repos.outboxRepo.acquireOutboxLease = async (params) => {
      allowReconcileFlag = params.allowExhaustedReconciliation;
      return {
        status: 'acquired',
        mode: 'reconciliation',
        item: {
          ...exhaustedItem,
          status: 'purging',
          leaseOwner: 'test-lease-token',
          lockedUntil: new Date(Date.now() + 60000),
        },
      };
    };

    repos.outboxRepo.markOutboxPurged = async () => {
      reconciled = true;
      return {
        status: 'updated',
        item: { ...exhaustedItem, status: 'purged', completedAt: new Date() },
      };
    };

    const deleteSpy = vi.spyOn(repos.authAdmin, 'deleteUserById').mockResolvedValue({ status: 'already_absent' });

    const runner = new WorkerRunner({
      workerEnv: dummyEnv,
      db: {} as StudexoDatabase,
      logger,
      ...repos,
      intervals: { reconciliationMs: 5 },
    });

    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const result = await runner.stop('SIGTERM');

    expect(result.success).toBe(true);
    expect(discovered).toBe(true);
    expect(allowReconcileFlag).toBe(true);
    expect(deleteSpy).toHaveBeenCalledWith('auth-sub-1');
    expect(reconciled).toBe(true);
  });

  it('14. The configured reconciliation batch limit is respected', async () => {
    const repos = createDummyRepos();
    let requestedLimit: number | undefined;

    repos.outboxRepo.listDueExhaustedOutboxItems = async ({ limit } = {}) => {
      requestedLimit = limit;
      return [];
    };

    const runner = new WorkerRunner({
      workerEnv: dummyEnv,
      db: {} as StudexoDatabase,
      logger,
      ...repos,
      intervals: { reconciliationMs: 5 },
      batchLimits: { reconciliation: 3 },
    });

    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await runner.stop('SIGTERM');

    expect(requestedLimit).toBe(3);
  });

  it('15. Empty discovery results cause no processing', async () => {
    const repos = createDummyRepos();
    repos.outboxRepo.listDueExhaustedOutboxItems = async () => [];
    const leaseSpy = vi.spyOn(repos.outboxRepo, 'acquireOutboxLease');
    const deleteSpy = vi.spyOn(repos.authAdmin, 'deleteUserById');

    const runner = new WorkerRunner({
      workerEnv: dummyEnv,
      db: {} as StudexoDatabase,
      logger,
      ...repos,
      intervals: { reconciliationMs: 5 },
    });

    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await runner.stop('SIGTERM');

    expect(leaseSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('16. Worker does not launch new reconciliation work after shutdown begins', async () => {
    const repos = createDummyRepos();
    let discoveryCount = 0;
    repos.outboxRepo.listDueExhaustedOutboxItems = async () => {
      discoveryCount++;
      return [];
    };

    const runner = new WorkerRunner({
      workerEnv: dummyEnv,
      db: {} as StudexoDatabase,
      logger,
      ...repos,
      intervals: { reconciliationMs: 10 },
    });

    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 15));
    const countAtStop = discoveryCount;

    await runner.stop('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(discoveryCount).toBe(countAtStop);
  });

  it('17. Active reconciliation operation is tracked and drains cleanly during shutdown', async () => {
    const repos = createDummyRepos();
    let reconcileFinished = false;

    repos.outboxRepo.listDueExhaustedOutboxItems = async () => [
      {
        id: 'outbox-draining-1',
        formerUserId: 'u-drain',
        supabaseAuthUserId: 'auth-drain',
        status: 'purge_failed',
        attemptCount: 10,
        maxAttempts: 10,
        nextAttemptAt: new Date(Date.now() - 1000),
        leaseOwner: null,
        lockedUntil: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        completedAt: null,
      },
    ];

    repos.outboxRepo.acquireOutboxLease = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      reconcileFinished = true;
      return {
        status: 'unavailable',
        reason: 'already_purged',
        item: null,
      };
    };

    const runner = new WorkerRunner({
      workerEnv: dummyEnv,
      db: {} as StudexoDatabase,
      logger,
      ...repos,
      intervals: { reconciliationMs: 5 },
      shutdownGracePeriodMs: 500,
    });

    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await runner.stop('SIGTERM');
    expect(reconcileFinished).toBe(true);
    expect(result.success).toBe(true);
    expect(result.state).toBe('CLOSED');
    expect(closeWorkerDbMock).toHaveBeenCalled();
  });

  it('18. Discovery or processing failure is caught and does not crash the worker loop', async () => {
    const repos = createDummyRepos();
    let attempts = 0;
    repos.outboxRepo.listDueExhaustedOutboxItems = async () => {
      attempts++;
      throw new Error('Database connection dropped during reconciliation discovery');
    };

    const runner = new WorkerRunner({
      workerEnv: dummyEnv,
      db: {} as StudexoDatabase,
      logger,
      ...repos,
      intervals: { reconciliationMs: 5 },
    });

    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const result = await runner.stop('SIGTERM');
    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(result.success).toBe(true);
    expect(result.state).toBe('CLOSED');
  });
});
