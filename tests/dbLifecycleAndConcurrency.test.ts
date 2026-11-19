import crypto from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { StudexoDatabase } from '../src/server/db/client';
import {
  assertUploadCanComplete,
  calculateDeletionSchedule,
  canCancelScheduledDeletion,
  executeStorageFirstAccountPurge,
  isAccountPurgeLeaseExpired,
  isPurgeLeaseExpired,
  processExternalIdentityPurgeOutboxItem,
  processPendingStoredFileDeletion,
  recoverExpiredStoredFilePurgeLease,
  recoverInterruptedAccountPurge,
  requestDraftStoredFileDeletion,
  resolveAuthenticatedUser,
  type AccountPurgeLeaseRecoveryRepository,
  type AccountPurgeRepository,
  type FileDeletionRequestRepository,
  type FilePurgeLeaseRecoveryRepository,
  type FilePurgeWorkerRepository,
  type StorageObjectAdapter,
  type StoredFileLifecycleRecord,
  type UserLifecycleRecord,
} from '../src/server/modules/lifecycle/storageAndPurge';
import {
  buildVerificationClaimLockInput,
  deriveVerificationClaimLockId,
  extractTargetKeyFromClaim,
  supersedeVerificationClaim,
  withRetryableReadCommittedTransaction,
} from '../src/server/modules/verification/supersession';

interface MockClaimRow {
  id: string;
  institutionId: string | null;
  programmeId: string | null;
  scholarshipId: string | null;
  fieldPath: string;
  status: 'unverified' | 'verified' | 'disputed' | 'superseded' | 'rejected';
  supersededByClaimId: string | null;
  supersededAt: Date | null;
}

function createStatefulClaimDbMock(
  initialClaims: MockClaimRow[],
  options: {
    onAdvisoryLock?: (claims: Map<string, MockClaimRow>) => void;
    forceUpdateRowCountZero?: boolean;
  } = {},
): {
  db: StudexoDatabase;
  claims: Map<string, MockClaimRow>;
  callSequence: string[];
  isolations: string[];
} {
  const claims = new Map<string, MockClaimRow>(initialClaims.map((c) => [c.id, { ...c }]));
  const callSequence: string[] = [];
  const isolations: string[] = [];
  const dialect = new PgDialect();

  const db = {
    transaction: async <T>(
      fn: (tx: StudexoDatabase) => Promise<T>,
      config: { isolationLevel: string },
    ): Promise<T> => {
      isolations.push(config.isolationLevel);
      callSequence.push('tx:begin');

      // Queue up sequential selects matching supersedeVerificationClaim's 3 queries:
      // 1) claimScope, 2) lockedClaim after advisory lock, 3) supersedingClaim
      let selectIndex = 0;
      const selectOrderIds: Array<string | undefined> = [];

      const snapshotMap = () => {
        const clone = new Map<string, MockClaimRow>();
        for (const [k, v] of claims.entries()) {
          clone.set(k, { ...v });
        }
        return clone;
      };

      let workingClaims = snapshotMap();

      const tx = {
        select: () => ({
          from: () => ({
            where: (whereExpr: SQL) => ({
              limit: async () => {
                selectIndex += 1;
                const { params } = dialect.sqlToQuery(whereExpr);
                const matchedId = params.find(
                  (param): param is string => typeof param === 'string' && claims.has(param),
                );
                selectOrderIds.push(matchedId);
                callSequence.push(`select#${selectIndex}:${matchedId ?? 'unknown'}`);

                if (!matchedId) {
                  return [];
                }
                const row = workingClaims.get(matchedId);
                return row ? [{ ...row }] : [];
              },
            }),
          }),
        }),
        execute: async () => {
          callSequence.push('advisory_xact_lock');
          if (options.onAdvisoryLock) {
            // Simulates another concurrent transaction holding and committing the lock first
            options.onAdvisoryLock(claims);
            // Refresh READ COMMITTED snapshot after lock acquisition!
            workingClaims = snapshotMap();
          }
          return [];
        },
        update: () => ({
          set: (patch: Partial<MockClaimRow>) => ({
            where: (whereExpr: SQL) => ({
              returning: async () => {
                callSequence.push('conditional_update');
                if (options.forceUpdateRowCountZero) {
                  return [];
                }
                const { params } = dialect.sqlToQuery(whereExpr);
                const targetId = params.find(
                  (param): param is string => typeof param === 'string' && workingClaims.has(param),
                );
                const expectedStatus = params.find(
                  (param): param is MockClaimRow['status'] =>
                    typeof param === 'string' && !workingClaims.has(param),
                );
                if (!targetId) {
                  return [];
                }
                const current = workingClaims.get(targetId);
                if (
                  !current ||
                  current.supersededByClaimId !== null ||
                  (expectedStatus && current.status !== expectedStatus)
                ) {
                  return [];
                }
                workingClaims.set(targetId, {
                  ...current,
                  ...patch,
                });
                return [{ id: targetId }];
              },
            }),
          }),
        }),
      } as unknown as StudexoDatabase;

      try {
        const result = await fn(tx);
        // Commit workingClaims back to shared store
        claims.clear();
        for (const [k, v] of workingClaims.entries()) {
          claims.set(k, v);
        }
        callSequence.push('tx:commit');
        return result;
      } catch (err) {
        callSequence.push('tx:rollback');
        throw err;
      }
    },
  } as unknown as StudexoDatabase;

  return { db, claims, callSequence, isolations };
}

describe('Verification supersession concurrency & transaction behavior', () => {
  it('derives deterministic signed 64-bit MD5 advisory lock keys matching PostgreSQL bit(64)::bigint', () => {
    const key = {
      targetType: 'programme' as const,
      targetId: '11111111-2222-3333-4444-555555555555',
      fieldPath: 'tuition_annual.amount',
    };

    const { lockInput, lockId } = deriveVerificationClaimLockId(key);
    expect(lockInput).toBe(
      'studexo:vclaim:programme:11111111-2222-3333-4444-555555555555:tuition_annual.amount',
    );
    expect(lockInput).toBe(buildVerificationClaimLockInput(key));

    const hex = crypto.createHash('md5').update(lockInput, 'utf8').digest('hex').slice(0, 16);
    const unsigned = BigInt(`0x${hex}`);
    const expectedSigned = unsigned >= 2n ** 63n ? unsigned - 2n ** 64n : unsigned;
    expect(lockId).toBe(expectedSigned);

    expect(deriveVerificationClaimLockId(key).lockId).toBe(lockId);
    expect(
      deriveVerificationClaimLockId({ ...key, fieldPath: 'intake.deadline' }).lockId,
    ).not.toBe(lockId);
  });

  it('extracts single catalog target cleanly and rejects invalid target multiplicity', () => {
    expect(
      extractTargetKeyFromClaim({
        institutionId: null,
        programmeId: 'prog-1',
        scholarshipId: null,
        fieldPath: 'official_url',
      }),
    ).toEqual({
      targetType: 'programme',
      targetId: 'prog-1',
      fieldPath: 'official_url',
    });

    expect(() =>
      extractTargetKeyFromClaim({
        institutionId: 'inst-1',
        programmeId: 'prog-1',
        scholarshipId: null,
        fieldPath: 'official_url',
      }),
    ).toThrow();
  });

  it('retries 40P01 and 40001 errors up to 3 attempts at READ COMMITTED isolation and stops on check failures', async () => {
    const sleepCalls: number[] = [];
    const seenIsolations: string[] = [];
    let counter = 0;

    const { result, attempts } = await withRetryableReadCommittedTransaction(
      async (fn, config) => {
        seenIsolations.push(config.isolationLevel);
        return fn({} as StudexoDatabase);
      },
      async () => {
        counter += 1;
        if (counter === 1) {
          throw { code: '40P01', message: 'deadlock detected' };
        }
        if (counter === 2) {
          throw { cause: { code: '40001' }, message: 'serialization failure' };
        }
        return 'committed';
      },
      {
        maxAttempts: 3,
        baseDelayMs: 10,
        randomFn: () => 0,
        sleepFn: async (ms) => {
          sleepCalls.push(ms);
        },
      },
    );

    expect(result).toBe('committed');
    expect(attempts).toBe(3);
    expect(seenIsolations).toEqual(['read committed', 'read committed', 'read committed']);
    expect(sleepCalls).toHaveLength(2);

    let failCount = 0;
    await expect(
      withRetryableReadCommittedTransaction(
        async (fn) => fn({} as StudexoDatabase),
        async () => {
          failCount += 1;
          throw { code: '23514', message: 'check violation' };
        },
        { maxAttempts: 3, sleepFn: async () => {} },
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(failCount).toBe(1);
  });

  it('acquires advisory lock before re-reading mutable state, serializes concurrent A->B vs A->C, and runs onCommitted strictly post-commit', async () => {
    const claimA: MockClaimRow = {
      id: 'claim-a',
      institutionId: null,
      programmeId: 'prog-1',
      scholarshipId: null,
      fieldPath: 'tuition_annual.amount',
      status: 'verified',
      supersededByClaimId: null,
      supersededAt: null,
    };
    const claimB: MockClaimRow = { ...claimA, id: 'claim-b', status: 'verified' };
    const claimC: MockClaimRow = { ...claimA, id: 'claim-c', status: 'verified' };

    // Simulate concurrent winner committing A -> B while Tx2 waits on pg_advisory_xact_lock for A -> C
    const mock = createStatefulClaimDbMock([claimA, claimB, claimC], {
      onAdvisoryLock: (claimsStore) => {
        const winnerRow = claimsStore.get('claim-a');
        if (winnerRow && winnerRow.status !== 'superseded') {
          claimsStore.set('claim-a', {
            ...winnerRow,
            status: 'superseded',
            supersededByClaimId: 'claim-b',
            supersededAt: new Date('2026-11-10T00:00:00.000Z'),
          });
        }
      },
    });

    const onCommittedLoser = vi.fn();
    await expect(
      supersedeVerificationClaim(mock.db, {
        claimIdToSupersede: 'claim-a',
        supersedingClaimId: 'claim-c',
        onCommitted: onCommittedLoser,
      }),
    ).rejects.toThrow(/already superseded/);

    // Winner's B link must remain untouched, loser rolls back, onCommitted must NOT run
    expect(mock.claims.get('claim-a')?.supersededByClaimId).toBe('claim-b');
    expect(onCommittedLoser).not.toHaveBeenCalled();
    expect(mock.isolations).toEqual(['read committed']);
    expect(mock.callSequence).toEqual([
      'tx:begin',
      'select#1:claim-a',
      'advisory_xact_lock',
      'select#2:claim-a',
      'tx:rollback',
    ]);
  });

  it('rejects ineligible replacement claims, conditional update row-count mismatches, and post-commit hook on rollback', async () => {
    const baseClaim: MockClaimRow = {
      id: 'claim-a',
      institutionId: null,
      programmeId: 'prog-1',
      scholarshipId: null,
      fieldPath: 'tuition_annual.amount',
      status: 'verified',
      supersededByClaimId: null,
      supersededAt: null,
    };

    // 0. Direct already-superseded and rejected claim-to-supersede checks
    const alreadySupersededMock = createStatefulClaimDbMock([
      { ...baseClaim, status: 'superseded', supersededByClaimId: 'claim-existing' },
      { ...baseClaim, id: 'claim-b' },
    ]);
    await expect(
      supersedeVerificationClaim(alreadySupersededMock.db, {
        claimIdToSupersede: 'claim-a',
        supersedingClaimId: 'claim-b',
      }),
    ).rejects.toThrow(/already superseded/);

    const rejectedSourceMock = createStatefulClaimDbMock([
      { ...baseClaim, status: 'rejected' },
      { ...baseClaim, id: 'claim-b' },
    ]);
    await expect(
      supersedeVerificationClaim(rejectedSourceMock.db, {
        claimIdToSupersede: 'claim-a',
        supersedingClaimId: 'claim-b',
      }),
    ).rejects.toThrow(/Rejected verification claim/);

    // 1. Rejected/disputed/superseded replacement claim rejected before UPDATE
    for (const badStatus of ['rejected', 'disputed', 'superseded'] as const) {
      const mock = createStatefulClaimDbMock([
        baseClaim,
        {
          ...baseClaim,
          id: 'claim-bad',
          status: badStatus,
          supersededByClaimId: badStatus === 'superseded' ? 'claim-x' : null,
        },
      ]);
      const hook = vi.fn();
      await expect(
        supersedeVerificationClaim(mock.db, {
          claimIdToSupersede: 'claim-a',
          supersedingClaimId: 'claim-bad',
          onCommitted: hook,
        }),
      ).rejects.toThrow(/ineligible status/);
      expect(hook).not.toHaveBeenCalled();
    }

    // 2. Conditional UPDATE returning 0 rows must throw & suppress onCommitted
    const zeroRowMock = createStatefulClaimDbMock(
      [baseClaim, { ...baseClaim, id: 'claim-b' }],
      { forceUpdateRowCountZero: true },
    );
    const zeroRowHook = vi.fn();
    await expect(
      supersedeVerificationClaim(zeroRowMock.db, {
        claimIdToSupersede: 'claim-a',
        supersedingClaimId: 'claim-b',
        onCommitted: zeroRowHook,
      }),
    ).rejects.toThrow(/Expected 1 affected row/);
    expect(zeroRowHook).not.toHaveBeenCalled();

    // 3. Clean commit invokes onCommitted strictly AFTER tx:commit
    const cleanMock = createStatefulClaimDbMock([baseClaim, { ...baseClaim, id: 'claim-b' }]);
    const observedOrder: string[] = [];
    const res = await supersedeVerificationClaim(cleanMock.db, {
      claimIdToSupersede: 'claim-a',
      supersedingClaimId: 'claim-b',
      supersededAt: new Date('2026-11-12T00:00:00.000Z'),
      onCommitted: () => {
        observedOrder.push(...cleanMock.callSequence, 'onCommitted');
      },
    });
    expect(res.supersededClaimId).toBe('claim-a');
    expect(res.supersedingClaimId).toBe('claim-b');
    expect(observedOrder).toEqual([
      'tx:begin',
      'select#1:claim-a',
      'advisory_xact_lock',
      'select#2:claim-a',
      'select#3:claim-b',
      'conditional_update',
      'tx:commit',
      'onCommitted',
    ]);
  });
});

describe('Storage-first deletion, account-purge orchestration, and lease recovery', () => {
  const userRecord: UserLifecycleRecord = {
    id: 'user-1',
    supabaseAuthUserId: 'auth-1',
    status: 'active',
    purgeState: 'none',
    deletionRequestedAt: null,
    deletionScheduledFor: null,
    purgeAttempts: 0,
  };

  function makeFile(overrides: Partial<StoredFileLifecycleRecord> = {}): StoredFileLifecycleRecord {
    return {
      id: 'file-1',
      ownerUserId: 'user-1',
      storageBucket: 'private-docs',
      objectKey: 'user-1/draft.pdf',
      uploadStatus: 'uploaded',
      purgeState: 'none',
      deletedAt: null,
      purgedAt: null,
      purgeAttempts: 0,
      purgeLeaseUntil: null,
      lastPurgeError: null,
      ...overrides,
    };
  }

  it('resolves users from verified JWT subject and calculates 14-day deletion grace windows', async () => {
    const resolved = await resolveAuthenticatedUser(
      { supabaseAuthUserId: 'auth-1', provider: 'google', providerSubject: 'g-1' },
      {
        findUserBySupabaseAuthId: async () => null,
        findUserByProviderIdentity: async (p, sub) =>
          p === 'google' && sub === 'g-1' ? userRecord : null,
      },
    );
    expect(resolved?.id).toBe('user-1');

    const requestedAt = new Date('2026-11-01T00:00:00.000Z');
    const schedule = calculateDeletionSchedule(requestedAt);
    expect(schedule.deletionScheduledFor.toISOString()).toBe('2026-11-15T00:00:00.000Z');

    const pendingUser: UserLifecycleRecord = {
      ...userRecord,
      status: 'pending_deletion',
      purgeState: 'pending_purge',
      ...schedule,
    };
    expect(canCancelScheduledDeletion(pendingUser, new Date('2026-11-14T23:59:59.000Z'))).toBe(
      true,
    );
    expect(canCancelScheduledDeletion(pendingUser, new Date('2026-11-15T00:00:00.000Z'))).toBe(
      false,
    );
  });

  it('blocks upload completion races once purge_state leaves none', () => {
    expect(() => assertUploadCanComplete(makeFile({ uploadStatus: 'pending' }))).not.toThrow();
    expect(() =>
      assertUploadCanComplete(makeFile({ uploadStatus: 'pending', purgeState: 'pending_purge' })),
    ).toThrow(/purge_state/);
    expect(() =>
      assertUploadCanComplete(makeFile({ uploadStatus: 'quarantined', purgeState: 'none' })),
    ).toThrow(/upload_status/);
  });

  it('separates Stage 1 API deletion requests (studexo_app) from Stage 2 Storage-first worker purging (studexo_purge_worker)', async () => {
    const callOrder: string[] = [];
    const file = makeFile();

    const apiRepo: FileDeletionRequestRepository = {
      getOwnedFile: async () => file,
      requestFileDeletion: async (_fileId, actorUserId) => {
        callOrder.push('api:requestDeletion');
        return { ...file, purgeState: 'pending_purge', deletedByUserId: actorUserId };
      },
    };

    const workerRepo: FilePurgeWorkerRepository = {
      getFileForPurge: async () => ({ ...file, purgeState: 'pending_purge', deletedByUserId: 'user-1' }),
      markFilePendingPurge: async () => {
        callOrder.push('worker:markPending');
        return { ...file, purgeState: 'pending_purge' };
      },
      acquireFilePurgeLeaseIfUnreferenced: async (_fileId, _ownerUserId, leaseSeconds) => {
        callOrder.push(`worker:acquireLeaseIfUnreferenced(${leaseSeconds})`);
        return {
          status: 'acquired',
          file: { ...file, purgeState: 'purging' },
        };
      },
      acquireFilePurgeLease: async () => {
        callOrder.push('worker:acquireLease');
        return { ...file, purgeState: 'purging' };
      },
      markFilePurged: async () => {
        callOrder.push('worker:markDbPurged');
      },
      markFilePurgeFailed: async () => {
        callOrder.push('worker:markDbFailed');
      },
      revertPendingPurgeToNone: async () => {
        callOrder.push('worker:revertPending');
      },
      listDueFilesForPurge: async () => [],
      listExpiredPurgeLeases: async () => [],
    };

    const storage: StorageObjectAdapter = {
      removeObject: async () => {
        callOrder.push('worker:storageRemove');
      },
      verifyObjectAbsent: async () => {
        callOrder.push('worker:storageVerifyAbsent');
        return true;
      },
    };

    // Stage 1: API only marks pending_purge and returns async 202 (never touches worker or Storage)
    const apiResult = await requestDraftStoredFileDeletion({
      fileId: 'file-1',
      authenticatedUserId: 'user-1',
      repo: apiRepo,
    });
    expect(apiResult).toEqual({ fileId: 'file-1', outcome: 'pending_purge', httpStatus: 202 });
    expect(callOrder).toEqual(['api:requestDeletion']);

    // Stage 1 idempotency for already queued / already purged rows
    const alreadyQueuedResult = await requestDraftStoredFileDeletion({
      fileId: 'file-1',
      authenticatedUserId: 'user-1',
      repo: {
        ...apiRepo,
        getOwnedFile: async () => makeFile({ purgeState: 'pending_purge' }),
      },
    });
    expect(alreadyQueuedResult).toEqual({
      fileId: 'file-1',
      outcome: 'pending_purge',
      httpStatus: 202,
    });

    const alreadyPurgedApi = await requestDraftStoredFileDeletion({
      fileId: 'file-1',
      authenticatedUserId: 'user-1',
      repo: {
        ...apiRepo,
        getOwnedFile: async () => makeFile({ purgeState: 'purged', uploadStatus: 'deleted' }),
      },
    });
    expect(alreadyPurgedApi).toEqual({
      fileId: 'file-1',
      outcome: 'already_purged',
      httpStatus: 200,
    });

    // Stage 2: Worker executes atomic reference-checked lease -> Storage delete -> verify absent -> mark purged
    callOrder.length = 0;
    const markPurgedArgs: unknown[][] = [];
    const workerResult = await processPendingStoredFileDeletion({
      fileId: 'file-1',
      ownerUserId: 'user-1',
      now: new Date('2026-11-10T00:00:00.000Z'),
      repo: {
        ...workerRepo,
        markFilePurged: async (...args) => {
          markPurgedArgs.push(args);
          callOrder.push('worker:markDbPurged');
        },
      },
      storage,
    });

    expect(workerResult).toEqual({ fileId: 'file-1', outcome: 'purged' });
    expect(callOrder).toEqual([
      'worker:acquireLeaseIfUnreferenced(60)',
      'worker:storageRemove',
      'worker:storageVerifyAbsent',
      'worker:markDbPurged',
    ]);
    expect(markPurgedArgs).toEqual([['file-1', 'user-1', new Date('2026-11-10T00:00:00.000Z')]]);

    // Stage 2: Blocking references revert untouched pending_purge cleanly without touching Storage
    const revertSpy = vi.fn();
    const removeSpy = vi.fn();
    const blockedRes = await processPendingStoredFileDeletion({
      fileId: 'file-1',
      ownerUserId: 'user-1',
      repo: {
        ...workerRepo,
        acquireFilePurgeLeaseIfUnreferenced: async () => ({
          status: 'blocked_by_references',
          blockingReferences: 2,
          file: { ...file, purgeState: 'pending_purge', deletedByUserId: 'user-1' },
        }),
        revertPendingPurgeToNone: revertSpy,
      },
      storage: { removeObject: removeSpy, verifyObjectAbsent: async () => true },
    });
    expect(blockedRes).toEqual({
      fileId: 'file-1',
      outcome: 'reverted_blocked_by_refs',
      blockingReferences: 2,
    });
    expect(revertSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).not.toHaveBeenCalled();

    // Stage 2: Already purged or skipped none states
    const alreadyPurgedWorker = await processPendingStoredFileDeletion({
      fileId: 'file-1',
      ownerUserId: 'user-1',
      repo: {
        ...workerRepo,
        getFileForPurge: async () => makeFile({ purgeState: 'purged', uploadStatus: 'deleted' }),
      },
      storage: { removeObject: removeSpy, verifyObjectAbsent: async () => true },
    });
    expect(alreadyPurgedWorker).toEqual({ fileId: 'file-1', outcome: 'already_purged' });

    // Stage 2: If Storage object is still present after removal, markFilePurged MUST NOT run
    const markPurgedSpy = vi.fn();
    const markFailedSpy = vi.fn();
    await expect(
      processPendingStoredFileDeletion({
        fileId: 'file-1',
        ownerUserId: 'user-1',
        repo: { ...workerRepo, markFilePurged: markPurgedSpy, markFilePurgeFailed: markFailedSpy },
        storage: {
          removeObject: async () => {},
          verifyObjectAbsent: async () => false,
        },
      }),
    ).rejects.toThrow(/still exists/);
    expect(markPurgedSpy).not.toHaveBeenCalled();
    expect(markFailedSpy).toHaveBeenCalledTimes(1);
  });

  it('aborts account purge before Storage removal if markFilePendingPurge or acquireFilePurgeLease returns null, and marks file/user failed on Storage failure', async () => {
    const expiredUser: UserLifecycleRecord = {
      ...userRecord,
      status: 'pending_deletion',
      purgeState: 'pending_purge',
      deletionRequestedAt: new Date('2026-10-01T00:00:00.000Z'),
      deletionScheduledFor: new Date('2026-10-15T00:00:00.000Z'),
    };
    const file = makeFile();
    const rpcSpy = vi.fn();
    const userFailSpy = vi.fn();
    const fileFailSpy = vi.fn();
    const removeSpy = vi.fn();

    const baseAccountRepo: AccountPurgeRepository = {
      getUserForPurge: async () => expiredUser,
      markUserPurging: async ({ leaseOwner, leaseUntil }) => ({
        ...expiredUser,
        purgeState: 'purging',
        purgeLeaseOwner: leaseOwner,
        purgeLeaseUntil: leaseUntil ?? null,
        purgeAttempts: expiredUser.purgeAttempts + 1,
      }),
      markUserPurgeFailed: userFailSpy,
      listUserStoredFiles: async () => [file],
      executeAccountPurgeRpc: rpcSpy,
      listDueUsersForPurge: async () => [],
      listExpiredAccountPurges: async () => [],
    };
    const baseFileRepo: FilePurgeWorkerRepository = {
      getFileForPurge: async () => file,
      markFilePendingPurge: async () => ({ ...file, purgeState: 'pending_purge' }),
      acquireFilePurgeLeaseIfUnreferenced: async () => ({
        status: 'acquired',
        file: { ...file, purgeState: 'purging' },
      }),
      acquireFilePurgeLease: async () => ({ ...file, purgeState: 'purging' }),
      markFilePurged: async () => {},
      markFilePurgeFailed: fileFailSpy,
      revertPendingPurgeToNone: async () => {},
      listDueFilesForPurge: async () => [],
      listExpiredPurgeLeases: async () => [],
    };

    // Case 1: markFilePendingPurge returns null -> must abort BEFORE touching Storage or DB RPC
    await expect(
      executeStorageFirstAccountPurge({
        userId: 'user-1',
        now: new Date('2026-10-16T00:00:00.000Z'),
        accountRepo: baseAccountRepo,
        fileRepo: { ...baseFileRepo, markFilePendingPurge: async () => null },
        storage: { removeObject: removeSpy, verifyObjectAbsent: async () => true },
      }),
    ).rejects.toThrow(/pending_purge/);
    expect(removeSpy).not.toHaveBeenCalled();
    expect(rpcSpy).not.toHaveBeenCalled();
    expect(userFailSpy).toHaveBeenCalledTimes(1);
    expect(userFailSpy).toHaveBeenCalledWith('user-1', expect.stringMatching(/pending_purge/), {
      expectedLeaseOwner: 'purge-worker',
      expectedPurgeAttempts: 1,
    });

    // Case 2: acquireFilePurgeLease returns null -> must abort BEFORE touching Storage or DB RPC
    userFailSpy.mockClear();
    await expect(
      executeStorageFirstAccountPurge({
        userId: 'user-1',
        now: new Date('2026-10-16T00:00:00.000Z'),
        accountRepo: baseAccountRepo,
        fileRepo: { ...baseFileRepo, acquireFilePurgeLease: async () => null },
        storage: { removeObject: removeSpy, verifyObjectAbsent: async () => true },
      }),
    ).rejects.toThrow(/lease busy/);
    expect(removeSpy).not.toHaveBeenCalled();
    expect(rpcSpy).not.toHaveBeenCalled();
    expect(userFailSpy).toHaveBeenCalledTimes(1);
    expect(userFailSpy).toHaveBeenCalledWith('user-1', expect.stringMatching(/lease busy/), {
      expectedLeaseOwner: 'purge-worker',
      expectedPurgeAttempts: 1,
    });

    // Case 3: Storage verification returns false -> marks BOTH fileRepo & accountRepo failed, never runs DB RPC
    userFailSpy.mockClear();
    fileFailSpy.mockClear();
    await expect(
      executeStorageFirstAccountPurge({
        userId: 'user-1',
        now: new Date('2026-10-16T00:00:00.000Z'),
        accountRepo: baseAccountRepo,
        fileRepo: baseFileRepo,
        storage: { removeObject: async () => {}, verifyObjectAbsent: async () => false },
      }),
    ).rejects.toThrow(/remained present/);
    expect(fileFailSpy).toHaveBeenCalledWith('file-1', 'user-1', expect.stringMatching(/remained present/));
    expect(userFailSpy).toHaveBeenCalledTimes(1);
    expect(userFailSpy).toHaveBeenCalledWith('user-1', expect.stringMatching(/remained present/), {
      expectedLeaseOwner: 'purge-worker',
      expectedPurgeAttempts: 1,
    });
    expect(rpcSpy).not.toHaveBeenCalled();

    // Case 4: Full success with mixed already_purged + active file + retryable purge_failed file forwarding leaseSeconds
    const now = new Date('2026-10-16T12:00:00.000Z');
    const alreadyPurgedFile = makeFile({
      id: 'file-done',
      purgeState: 'purged',
      uploadStatus: 'deleted',
      purgedAt: new Date('2026-10-16T00:00:00.000Z'),
    });
    const activeFile = makeFile({ id: 'file-active' });
    const failedRetryFile = makeFile({
      id: 'file-failed',
      purgeState: 'purge_failed',
      purgeAttempts: 1,
      lastPurgeError: 'transient s3 error',
    });
    let activeIsPurged = false;
    let failedIsPurged = false;
    const markPendingCalledFor: string[] = [];
    const recordedLeaseSeconds: Array<{ id: string; leaseSeconds: number }> = [];

    const successResult = await executeStorageFirstAccountPurge({
      userId: 'user-1',
      now,
      leaseSeconds: 90,
      accountRepo: {
        ...baseAccountRepo,
        listUserStoredFiles: async () => [
          alreadyPurgedFile,
          activeIsPurged
            ? { ...activeFile, purgeState: 'purged', uploadStatus: 'deleted', purgedAt: now }
            : activeFile,
          failedIsPurged
            ? { ...failedRetryFile, purgeState: 'purged', uploadStatus: 'deleted', purgedAt: now }
            : failedRetryFile,
        ],
      },
      fileRepo: {
        ...baseFileRepo,
        markFilePendingPurge: async (id) => {
          markPendingCalledFor.push(id);
          return { ...activeFile, id, purgeState: 'pending_purge' };
        },
        acquireFilePurgeLease: async (id, _owner, leaseSeconds) => {
          recordedLeaseSeconds.push({ id, leaseSeconds });
          const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000);
          const source = id === 'file-failed' ? failedRetryFile : activeFile;
          return { ...source, id, purgeState: 'purging', purgeLeaseUntil: leaseUntil };
        },
        markFilePurged: async (id) => {
          if (id === 'file-failed') {
            failedIsPurged = true;
          } else {
            activeIsPurged = true;
          }
        },
      },
      storage: { removeObject: async () => {}, verifyObjectAbsent: async () => true },
    });

    // purge_failed files must retry directly via acquireFilePurgeLease without triggering 23514 on markFilePendingPurge
    expect(markPendingCalledFor).toEqual(['file-active']);
    expect(recordedLeaseSeconds).toEqual([
      { id: 'file-active', leaseSeconds: 90 },
      { id: 'file-failed', leaseSeconds: 90 },
    ]);
    expect(successResult).toEqual({
      userId: 'user-1',
      purgedFileIds: ['file-active', 'file-failed'],
      alreadyPurgedFileIds: ['file-done'],
      databasePurgeExecuted: true,
    });
    expect(rpcSpy).toHaveBeenCalledWith('user-1', {
      expectedLeaseOwner: 'purge-worker',
      expectedPurgeAttempts: 1,
    });

    // Outbox helper completes external identity purge
    const outboxRes = await processExternalIdentityPurgeOutboxItem(
      {
        id: 'outbox-1',
        formerUserId: 'user-1',
        supabaseAuthUserId: 'auth-1',
        status: 'pending_purge',
        attemptCount: 0,
        maxAttempts: 10,
      },
      { deleteUserById: async () => ({ status: 'deleted' }) },
    );
    expect(outboxRes).toEqual({ status: 'purged' });
  });

  it('recovers expired stored_files purge leases while preserving attempts/errors and never stealing active or terminal files', async () => {
    const now = new Date('2026-11-12T10:00:00.000Z');
    const repoSpy = vi.fn();
    const repo: FilePurgeLeaseRecoveryRepository = {
      markExpiredPurgeLeaseFailed: async (params) => {
        repoSpy(params);
        return {
          ...makeFile(),
          purgeState: 'purge_failed',
          purgeAttempts: 2,
          purgeLeaseUntil: null,
          lastPurgeError: params.errorMessage,
        };
      },
    };

    // 1. Expired lease -> recovered to purge_failed with attempt count & previous error preserved
    const expiredFile = makeFile({
      purgeState: 'purging',
      purgeAttempts: 2,
      purgeLeaseUntil: new Date('2026-11-12T09:58:00.000Z'),
      lastPurgeError: 'timeout on prior run',
    });
    expect(isPurgeLeaseExpired(expiredFile, now)).toBe(true);
    const recovered = await recoverExpiredStoredFilePurgeLease({ file: expiredFile, now, repo });
    expect(recovered.outcome).toBe('recovered_to_purge_failed');
    expect(recovered.file.purgeAttempts).toBe(2);
    expect(recovered.file.lastPurgeError).toContain('timeout on prior run');
    expect(repoSpy).toHaveBeenCalledTimes(1);

    // 2. Active lease -> refused, repo NOT called
    repoSpy.mockClear();
    const activeFile = makeFile({
      purgeState: 'purging',
      purgeAttempts: 1,
      purgeLeaseUntil: new Date('2026-11-12T10:01:00.000Z'),
    });
    expect(isPurgeLeaseExpired(activeFile, now)).toBe(false);
    const activeRes = await recoverExpiredStoredFilePurgeLease({ file: activeFile, now, repo });
    expect(activeRes.outcome).toBe('active_lease');
    expect(repoSpy).not.toHaveBeenCalled();

    // 3. Terminal purged/deleted file -> skipped, repo NOT called
    const terminalFile = makeFile({ purgeState: 'purged', uploadStatus: 'deleted' });
    const termRes = await recoverExpiredStoredFilePurgeLease({ file: terminalFile, now, repo });
    expect(termRes.outcome).toBe('skipped_terminal');
    expect(repoSpy).not.toHaveBeenCalled();
  });

  it('aborts executeStorageFirstAccountPurge cleanly when markUserPurging returns null and forwards leaseOwner/leaseUntil', async () => {
    const expiredUser: UserLifecycleRecord = {
      ...userRecord,
      status: 'pending_deletion',
      purgeState: 'pending_purge',
      deletionRequestedAt: new Date('2026-10-01T00:00:00.000Z'),
      deletionScheduledFor: new Date('2026-10-15T00:00:00.000Z'),
    };
    const listFilesSpy = vi.fn();
    const markPurgingSpy = vi.fn(async () => null);
    const removeSpy = vi.fn();
    const rpcSpy = vi.fn();

    await expect(
      executeStorageFirstAccountPurge({
        userId: 'user-1',
        leaseOwner: 'worker-42',
        now: new Date('2026-10-16T00:00:00.000Z'),
        leaseSeconds: 120,
        accountRepo: {
          getUserForPurge: async () => expiredUser,
          markUserPurging: markPurgingSpy,
          markUserPurgeFailed: async () => {},
          listUserStoredFiles: listFilesSpy,
          executeAccountPurgeRpc: rpcSpy,
          listDueUsersForPurge: async () => [],
          listExpiredAccountPurges: async () => [],
        },
        fileRepo: {
          getFileForPurge: async () => null,
          markFilePendingPurge: async () => null,
          acquireFilePurgeLeaseIfUnreferenced: async () => ({
            status: 'unavailable',
            reason: 'not_found',
            file: null,
          }),
          acquireFilePurgeLease: async () => null,
          markFilePurged: async () => {},
          markFilePurgeFailed: async () => {},
          revertPendingPurgeToNone: async () => {},
          listDueFilesForPurge: async () => [],
          listExpiredPurgeLeases: async () => [],
        },
        storage: { removeObject: removeSpy, verifyObjectAbsent: async () => true },
      }),
    ).rejects.toThrow(/Unable to claim account purge lease/);

    expect(markPurgingSpy).toHaveBeenCalledWith({
      userId: 'user-1',
      leaseOwner: 'worker-42',
      leaseSeconds: 120,
      leaseUntil: new Date('2026-10-16T00:02:00.000Z'),
    });
    expect(listFilesSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it('recovers interrupted account purges to purge_failed while verifying Storage absence, checking outbox, and refusing active leases', async () => {
    const now = new Date('2026-11-12T10:00:00.000Z');
    const expiredPurgingUser: UserLifecycleRecord = {
      ...userRecord,
      status: 'pending_deletion',
      purgeState: 'purging',
      deletionRequestedAt: new Date('2026-10-01T00:00:00.000Z'),
      deletionScheduledFor: new Date('2026-10-15T00:00:00.000Z'),
      purgeLeaseOwner: 'worker-crashed',
      purgeLeaseUntil: new Date('2026-11-12T09:55:00.000Z'),
      purgeAttempts: 3,
      lastPurgeError: 'previous transient error',
    };

    const expiredLeaseFile = makeFile({
      id: 'file-leaking',
      objectKey: 'user-1/leaking.pdf',
      purgeState: 'purging',
      purgeAttempts: 1,
      purgeLeaseUntil: new Date('2026-11-12T09:56:00.000Z'),
    });
    const pendingStillInStorageFile = makeFile({
      id: 'file-present',
      objectKey: 'user-1/present.pdf',
      purgeState: 'none',
    });
    const alreadyPurgedFile = makeFile({
      id: 'file-done',
      objectKey: 'user-1/done.pdf',
      purgeState: 'purged',
      uploadStatus: 'deleted',
      purgedAt: new Date('2026-11-12T09:50:00.000Z'),
    });

    const markUserFailedSpy = vi.fn(
      async ({ failedAt, errorMessage }: { userId: string; failedAt: Date; errorMessage: string }) => ({
        ...expiredPurgingUser,
        status: 'pending_deletion' as const,
        purgeState: 'purge_failed' as const,
        purgeLeaseOwner: null,
        purgeLeaseUntil: null,
        lastPurgeError: `${errorMessage} (${failedAt.toISOString()})`,
      }),
    );

    const fileRecoveryRepo: FilePurgeLeaseRecoveryRepository = {
      markExpiredPurgeLeaseFailed: async ({ fileId, errorMessage }) => ({
        ...expiredLeaseFile,
        id: fileId,
        purgeState: 'purge_failed',
        purgeLeaseUntil: null,
        lastPurgeError: errorMessage,
      }),
    };

    const recoveryRepo: AccountPurgeLeaseRecoveryRepository = {
      markExpiredAccountPurgeLeaseFailed: markUserFailedSpy,
      findExternalIdentityOutboxByAuthUserId: async () => null,
    };

    expect(isAccountPurgeLeaseExpired(expiredPurgingUser, now)).toBe(true);

    // 1. Expired user lease + expired file lease where Storage object was already deleted before crash
    const recovered = await recoverInterruptedAccountPurge({
      userId: 'user-1',
      now,
      accountRepo: {
        getUserForPurge: async () => expiredPurgingUser,
        listUserStoredFiles: async () => [expiredLeaseFile, pendingStillInStorageFile, alreadyPurgedFile],
      },
      fileRecoveryRepo,
      recoveryRepo,
      storage: {
        verifyObjectAbsent: async (_bucket, key) => key === 'user-1/leaking.pdf',
      },
    });

    expect(recovered.outcome).toBe('recovered_to_purge_failed');
    expect(recovered.user?.status).toBe('pending_deletion');
    expect(recovered.user?.purgeState).toBe('purge_failed');
    expect(recovered.user?.purgeAttempts).toBe(3);
    expect(recovered.user?.purgeLeaseOwner).toBeNull();
    expect(recovered.user?.purgeLeaseUntil).toBeNull();
    expect(recovered.recoveredFileIds).toEqual(['file-leaking']);
    expect(recovered.storageConfirmedAbsentFileIds).toEqual(['file-leaking']);
    expect(recovered.storageStillPresentFileIds).toEqual(['file-present']);
    expect(recovered.outboxStatus).toBeNull();
    expect(markUserFailedSpy).toHaveBeenCalledTimes(1);

    // 2. Active user lease -> refuses to steal lease
    markUserFailedSpy.mockClear();
    const activeLeaseRes = await recoverInterruptedAccountPurge({
      userId: 'user-1',
      now,
      accountRepo: {
        getUserForPurge: async () => ({
          ...expiredPurgingUser,
          purgeLeaseUntil: new Date('2026-11-12T10:04:00.000Z'),
        }),
        listUserStoredFiles: async () => [],
      },
      fileRecoveryRepo,
      recoveryRepo,
      storage: { verifyObjectAbsent: async () => true },
    });
    expect(activeLeaseRes.outcome).toBe('active_lease');
    expect(markUserFailedSpy).not.toHaveBeenCalled();

    // 3. Expired user lease but active file lease -> refuses to steal file lease
    const activeFileLeaseRes = await recoverInterruptedAccountPurge({
      userId: 'user-1',
      now,
      accountRepo: {
        getUserForPurge: async () => expiredPurgingUser,
        listUserStoredFiles: async () => [
          makeFile({ purgeState: 'purging', purgeLeaseUntil: new Date('2026-11-12T10:03:00.000Z') }),
        ],
      },
      fileRecoveryRepo,
      recoveryRepo,
      storage: { verifyObjectAbsent: async () => true },
    });
    expect(activeFileLeaseRes.outcome).toBe('blocked_active_file_lease');
    expect(markUserFailedSpy).not.toHaveBeenCalled();

    // 4. Already deleted user / terminal purged / active user -> non-destructive skips
    const missingRes = await recoverInterruptedAccountPurge({
      userId: 'user-1',
      now,
      accountRepo: { getUserForPurge: async () => null, listUserStoredFiles: async () => [] },
      fileRecoveryRepo,
      recoveryRepo,
      storage: { verifyObjectAbsent: async () => true },
    });
    expect(missingRes.outcome).toBe('user_already_purged');

    const activeUserRes = await recoverInterruptedAccountPurge({
      userId: 'user-1',
      now,
      accountRepo: {
        getUserForPurge: async () => ({ ...userRecord, status: 'active', purgeState: 'none' }),
        listUserStoredFiles: async () => [],
      },
      fileRecoveryRepo,
      recoveryRepo,
      storage: { verifyObjectAbsent: async () => true },
    });
    expect(activeUserRes.outcome).toBe('skipped_not_pending_deletion');
  });

  // Pure offline contract-evaluator unit tests mirroring the Phase 8B.2J SQL trigger predicates.
  // Live PostgreSQL execution of the actual PL/pgSQL triggers remains in the disposable PG phase.
  it('enforces offline policy contracts for superseded verification_claims anonymisation and stored_files.deleted_by_user_id attribution', () => {
    type DbRole = 'studexo_app' | 'studexo_migrator' | 'studexo_purge_worker' | 'studexo_purge_owner' | 'studexo_catalog_admin';

    function canAnonymiseSupersededClaim(params: {
      currentUser: DbRole;
      purgeModeGuc: string | null;
      referencedUser: { status: string; purgeState: string } | null;
      oldRow: {
        verifiedByUserId: string | null;
        status: string;
        claimedValue: string;
        notes: string | null;
        updatedAt: string;
      };
      newRow: {
        verifiedByUserId: string | null;
        status: string;
        claimedValue: string;
        notes: string | null;
        updatedAt: string;
      };
    }): boolean {
      const inAccountPurge =
        params.currentUser === 'studexo_purge_owner' && params.purgeModeGuc === 'account_purge';
      return (
        inAccountPurge &&
        params.oldRow.verifiedByUserId !== null &&
        params.newRow.verifiedByUserId === null &&
        params.newRow.status === params.oldRow.status &&
        params.newRow.claimedValue === params.oldRow.claimedValue &&
        params.newRow.notes === params.oldRow.notes &&
        params.newRow.updatedAt === params.oldRow.updatedAt &&
        params.referencedUser !== null &&
        params.referencedUser.status === 'pending_deletion' &&
        params.referencedUser.purgeState === 'purging'
      );
    }

    function canMutateStoredFileDeletedByUserId(params: {
      currentUser: DbRole;
      purgeModeGuc: string | null;
      fileDeletionModeGuc?: string | null;
      fileOwnerUserId?: string;
      oldPurgeState?: string;
      newPurgeState?: string;
      deleterUser: { id?: string; role?: string; status: string; purgeState: string } | null;
      oldDeletedByUserId: string | null;
      newDeletedByUserId: string | null;
    }): boolean {
      if (params.oldDeletedByUserId === params.newDeletedByUserId) {
        return true;
      }
      if (params.currentUser === 'studexo_purge_owner' && params.purgeModeGuc === 'account_purge') {
        return (
          params.oldDeletedByUserId !== null &&
          params.newDeletedByUserId === null &&
          params.deleterUser !== null &&
          params.deleterUser.status === 'pending_deletion' &&
          params.deleterUser.purgeState === 'purging'
        );
      }
      if (
        params.currentUser === 'studexo_migrator' &&
        params.fileDeletionModeGuc === 'request'
      ) {
        return (
          params.oldDeletedByUserId === null &&
          params.newDeletedByUserId !== null &&
          params.oldPurgeState === 'none' &&
          params.newPurgeState === 'pending_purge' &&
          params.deleterUser !== null &&
          params.deleterUser.status === 'active' &&
          params.deleterUser.purgeState === 'none' &&
          (params.fileOwnerUserId === params.newDeletedByUserId ||
            params.deleterUser.role === 'admin')
        );
      }
      return false;
    }

    const oldClaim = {
      verifiedByUserId: 'user-1',
      status: 'superseded',
      claimedValue: '15000',
      notes: 'original note',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };

    expect(
      canAnonymiseSupersededClaim({
        currentUser: 'studexo_purge_owner',
        purgeModeGuc: 'account_purge',
        referencedUser: { status: 'pending_deletion', purgeState: 'purging' },
        oldRow: oldClaim,
        newRow: { ...oldClaim, verifiedByUserId: null },
      }),
    ).toBe(true);

    // Rejected: studexo_migrator or studexo_app
    for (const forbiddenRole of ['studexo_migrator', 'studexo_app', 'studexo_catalog_admin'] as const) {
      expect(
        canAnonymiseSupersededClaim({
          currentUser: forbiddenRole,
          purgeModeGuc: 'account_purge',
          referencedUser: { status: 'pending_deletion', purgeState: 'purging' },
          oldRow: oldClaim,
          newRow: { ...oldClaim, verifiedByUserId: null },
        }),
      ).toBe(false);
    }

    // Rejected: missing GUC or wrong user lifecycle state
    expect(
      canAnonymiseSupersededClaim({
        currentUser: 'studexo_purge_owner',
        purgeModeGuc: null,
        referencedUser: { status: 'pending_deletion', purgeState: 'purging' },
        oldRow: oldClaim,
        newRow: { ...oldClaim, verifiedByUserId: null },
      }),
    ).toBe(false);
    expect(
      canAnonymiseSupersededClaim({
        currentUser: 'studexo_purge_owner',
        purgeModeGuc: 'account_purge',
        referencedUser: { status: 'active', purgeState: 'none' },
        oldRow: oldClaim,
        newRow: { ...oldClaim, verifiedByUserId: null },
      }),
    ).toBe(false);

    // Rejected: mutating any field other than verified_by_user_id
    expect(
      canAnonymiseSupersededClaim({
        currentUser: 'studexo_purge_owner',
        purgeModeGuc: 'account_purge',
        referencedUser: { status: 'pending_deletion', purgeState: 'purging' },
        oldRow: oldClaim,
        newRow: { ...oldClaim, verifiedByUserId: null, claimedValue: '99999' },
      }),
    ).toBe(false);

    // Legitimate file deletion attribution via SECURITY DEFINER request_stored_file_deletion (owner & admin)
    expect(
      canMutateStoredFileDeletedByUserId({
        currentUser: 'studexo_migrator',
        purgeModeGuc: null,
        fileDeletionModeGuc: 'request',
        fileOwnerUserId: 'owner-1',
        oldPurgeState: 'none',
        newPurgeState: 'pending_purge',
        deleterUser: { id: 'owner-1', role: 'student', status: 'active', purgeState: 'none' },
        oldDeletedByUserId: null,
        newDeletedByUserId: 'owner-1',
      }),
    ).toBe(true);
    expect(
      canMutateStoredFileDeletedByUserId({
        currentUser: 'studexo_migrator',
        purgeModeGuc: null,
        fileDeletionModeGuc: 'request',
        fileOwnerUserId: 'owner-1',
        oldPurgeState: 'none',
        newPurgeState: 'pending_purge',
        deleterUser: { id: 'admin-1', role: 'admin', status: 'active', purgeState: 'none' },
        oldDeletedByUserId: null,
        newDeletedByUserId: 'admin-1',
      }),
    ).toBe(true);

    // Rejected: non-admin cross-user spoofing, inactive actor, direct update without GUC
    expect(
      canMutateStoredFileDeletedByUserId({
        currentUser: 'studexo_migrator',
        purgeModeGuc: null,
        fileDeletionModeGuc: 'request',
        fileOwnerUserId: 'owner-1',
        oldPurgeState: 'none',
        newPurgeState: 'pending_purge',
        deleterUser: { id: 'other-1', role: 'student', status: 'active', purgeState: 'none' },
        oldDeletedByUserId: null,
        newDeletedByUserId: 'other-1',
      }),
    ).toBe(false);
    expect(
      canMutateStoredFileDeletedByUserId({
        currentUser: 'studexo_migrator',
        purgeModeGuc: null,
        fileDeletionModeGuc: null,
        fileOwnerUserId: 'owner-1',
        oldPurgeState: 'none',
        newPurgeState: 'pending_purge',
        deleterUser: { id: 'owner-1', role: 'student', status: 'active', purgeState: 'none' },
        oldDeletedByUserId: null,
        newDeletedByUserId: 'owner-1',
      }),
    ).toBe(false);

    // Cross-user stored_files.deleted_by_user_id clearing during account purge
    expect(
      canMutateStoredFileDeletedByUserId({
        currentUser: 'studexo_purge_owner',
        purgeModeGuc: 'account_purge',
        deleterUser: { status: 'pending_deletion', purgeState: 'purging' },
        oldDeletedByUserId: 'user-1',
        newDeletedByUserId: null,
      }),
    ).toBe(true);

    // Rejected for studexo_app / studexo_purge_worker even when purge_state is already 'purged'
    for (const nonPurgeOwner of ['studexo_app', 'studexo_purge_worker', 'studexo_migrator'] as const) {
      expect(
        canMutateStoredFileDeletedByUserId({
          currentUser: nonPurgeOwner,
          purgeModeGuc: null,
          deleterUser: { status: 'pending_deletion', purgeState: 'purging' },
          oldDeletedByUserId: 'user-1',
          newDeletedByUserId: null,
        }),
      ).toBe(false);
    }
  });

  it('enforces Phase 8B.2L user INSERT role/lifecycle guard and stored_files pending_purge -> none atomic rollback + re-request lifecycle', async () => {
    type DbRole =
      | 'studexo_app'
      | 'studexo_migrator'
      | 'studexo_purge_worker'
      | 'studexo_purge_owner'
      | 'studexo_catalog_admin';

    const ALLOWED_APP_INSERT_COLUMNS = new Set([
      'id',
      'supabase_auth_user_id',
      'primary_email',
      'display_name',
    ]);

    function validateUserInsert(params: {
      currentUser: DbRole;
      providedColumns: string[];
      row: {
        role: 'student' | 'counselor' | 'admin';
        status: 'active' | 'pending_deletion' | 'suspended';
        purgeState: 'none' | 'pending_purge' | 'purging' | 'purge_failed' | 'purged';
        deletionRequestedAt: string | null;
        deletionScheduledFor: string | null;
        purgeLeaseOwner: string | null;
        purgeLeaseUntil: string | null;
        purgeAttempts: number;
        lastPurgeError: string | null;
        purgedAt: string | null;
      };
    }): { ok: true } | { ok: false; sqlstate: '42501' | '23514' } {
      if (params.currentUser === 'studexo_app') {
        for (const col of params.providedColumns) {
          if (!ALLOWED_APP_INSERT_COLUMNS.has(col)) {
            return { ok: false, sqlstate: '42501' };
          }
        }
      }
      if (
        ['studexo_app', 'studexo_purge_worker', 'studexo_purge_owner', 'studexo_catalog_admin'].includes(
          params.currentUser,
        ) &&
        params.row.role !== 'student'
      ) {
        return { ok: false, sqlstate: '42501' };
      }
      if (
        params.row.status !== 'active' ||
        params.row.purgeState !== 'none' ||
        params.row.deletionRequestedAt !== null ||
        params.row.deletionScheduledFor !== null ||
        params.row.purgeLeaseOwner !== null ||
        params.row.purgeLeaseUntil !== null ||
        params.row.purgeAttempts !== 0 ||
        params.row.lastPurgeError !== null ||
        params.row.purgedAt !== null
      ) {
        return { ok: false, sqlstate: '23514' };
      }
      return { ok: true };
    }

    const cleanStudent = {
      role: 'student' as const,
      status: 'active' as const,
      purgeState: 'none' as const,
      deletionRequestedAt: null,
      deletionScheduledFor: null,
      purgeLeaseOwner: null,
      purgeLeaseUntil: null,
      purgeAttempts: 0,
      lastPurgeError: null,
      purgedAt: null,
    };

    // Normal student registration via column-scoped grant succeeds
    expect(
      validateUserInsert({
        currentUser: 'studexo_app',
        providedColumns: ['id', 'supabase_auth_user_id', 'primary_email', 'display_name'],
        row: cleanStudent,
      }),
    ).toEqual({ ok: true });

    // studexo_app cannot insert privileged roles, non-active status, or dirty lifecycle columns
    expect(
      validateUserInsert({
        currentUser: 'studexo_app',
        providedColumns: ['id', 'supabase_auth_user_id', 'primary_email', 'role'],
        row: { ...cleanStudent, role: 'admin' },
      }),
    ).toEqual({ ok: false, sqlstate: '42501' });
    expect(
      validateUserInsert({
        currentUser: 'studexo_app',
        providedColumns: ['id', 'supabase_auth_user_id', 'primary_email', 'status'],
        row: { ...cleanStudent, status: 'suspended' },
      }),
    ).toEqual({ ok: false, sqlstate: '42501' });
    expect(
      validateUserInsert({
        currentUser: 'studexo_app',
        providedColumns: ['id', 'supabase_auth_user_id', 'primary_email', 'purge_state'],
        row: { ...cleanStudent, purgeState: 'purged' },
      }),
    ).toEqual({ ok: false, sqlstate: '42501' });

    // Direct trigger guard also blocks non-student/dirty inserts across worker/catalog_admin
    expect(
      validateUserInsert({
        currentUser: 'studexo_catalog_admin',
        providedColumns: ['role'],
        row: { ...cleanStudent, role: 'admin' },
      }),
    ).toEqual({ ok: false, sqlstate: '42501' });
    expect(
      validateUserInsert({
        currentUser: 'studexo_migrator',
        providedColumns: ['role', 'purge_state'],
        row: { ...cleanStudent, role: 'admin', purgeState: 'purged' },
      }),
    ).toEqual({ ok: false, sqlstate: '23514' });
    // Privileged admin provisioning retains clean admin insert path
    expect(
      validateUserInsert({
        currentUser: 'studexo_migrator',
        providedColumns: ['role'],
        row: { ...cleanStudent, role: 'admin' },
      }),
    ).toEqual({ ok: true });

    // Stored-file stateful two-stage rollback + re-request end-to-end orchestration check
    interface MutableStoredFileState extends StoredFileLifecycleRecord {
      deletedByUserId: string | null;
      purgeRequestedAt: Date | null;
    }

    let dbRow: MutableStoredFileState = {
      ...makeFile(),
      deletedByUserId: null,
      purgeRequestedAt: null,
    };
    let refCount = 1;

    const statefulApiRepo: FileDeletionRequestRepository = {
      getOwnedFile: async () => ({ ...dbRow }),
      requestFileDeletion: async (_fileId, actorUserId) => {
        if (dbRow.purgeState !== 'none' || dbRow.deletedByUserId !== null) {
          throw new Error('SQLSTATE 23514: stored_files row is not eligible for deletion request');
        }
        dbRow = {
          ...dbRow,
          purgeState: 'pending_purge',
          deletedByUserId: actorUserId,
          purgeRequestedAt: new Date('2026-11-15T10:00:00.000Z'),
        };
        return { ...dbRow };
      },
    };

    const statefulWorkerRepo: FilePurgeWorkerRepository = {
      getFileForPurge: async () => ({ ...dbRow }),
      markFilePendingPurge: async () => ({ ...dbRow, purgeState: 'pending_purge' }),
      acquireFilePurgeLeaseIfUnreferenced: async (fileId, ownerUserId, leaseSeconds) => {
        if (dbRow.id !== fileId || dbRow.ownerUserId !== ownerUserId) {
          return { status: 'unavailable', reason: 'not_found', file: null };
        }
        if (refCount > 0) {
          return { status: 'blocked_by_references', blockingReferences: refCount, file: { ...dbRow } };
        }
        dbRow = {
          ...dbRow,
          purgeState: 'purging',
          purgeAttempts: dbRow.purgeAttempts + 1,
          purgeLeaseUntil: new Date(Date.now() + leaseSeconds * 1000),
        };
        return { status: 'acquired', file: { ...dbRow } };
      },
      acquireFilePurgeLease: async (_fileId, _owner, leaseSeconds) => {
        dbRow = {
          ...dbRow,
          purgeState: 'purging',
          purgeAttempts: dbRow.purgeAttempts + 1,
          purgeLeaseUntil: new Date(Date.now() + leaseSeconds * 1000),
        };
        return { ...dbRow };
      },
      markFilePurged: async (_fileId, _owner, now = new Date()) => {
        dbRow = {
          ...dbRow,
          purgeState: 'purged',
          uploadStatus: 'deleted',
          deletedAt: now,
          purgedAt: now,
          purgeLeaseUntil: null,
        };
      },
      markFilePurgeFailed: async (_fileId, _owner, errMsg) => {
        dbRow = {
          ...dbRow,
          purgeState: 'purge_failed',
          purgeLeaseUntil: null,
          lastPurgeError: errMsg,
        };
      },
      revertPendingPurgeToNone: async (fileId, ownerUserId) => {
        if (dbRow.id !== fileId || dbRow.ownerUserId !== ownerUserId) {
          throw new Error('SQLSTATE 22023: ownership mismatch');
        }
        if (
          dbRow.purgeState !== 'pending_purge' ||
          dbRow.uploadStatus === 'deleted' ||
          dbRow.deletedAt !== null ||
          dbRow.purgedAt !== null ||
          dbRow.purgeLeaseUntil !== null ||
          dbRow.purgeAttempts !== 0 ||
          dbRow.lastPurgeError !== null
        ) {
          throw new Error('SQLSTATE 23514: stored_files row is ineligible for pending_purge -> none revert');
        }
        dbRow = {
          ...dbRow,
          purgeState: 'none',
          deletedByUserId: null,
          purgeRequestedAt: null,
        };
      },
      listDueFilesForPurge: async () => [],
      listExpiredPurgeLeases: async () => [],
    };

    const storageAdapter: StorageObjectAdapter = {
      removeObject: async () => {},
      verifyObjectAbsent: async () => true,
    };

    // 1. Stage 1 API marks pending_purge; Stage 2 worker detects blocking reference & rolls back cleanly
    const req1 = await requestDraftStoredFileDeletion({
      fileId: 'file-1',
      authenticatedUserId: 'user-1',
      repo: statefulApiRepo,
    });
    expect(req1).toEqual({ fileId: 'file-1', outcome: 'pending_purge', httpStatus: 202 });

    const workerBlocked = await processPendingStoredFileDeletion({
      fileId: 'file-1',
      ownerUserId: 'user-1',
      repo: statefulWorkerRepo,
      storage: storageAdapter,
    });
    expect(workerBlocked).toEqual({
      fileId: 'file-1',
      outcome: 'reverted_blocked_by_refs',
      blockingReferences: 1,
    });

    // Verify rollback cleared deleted_by_user_id & purge_requested_at atomically with purge_state = 'none'
    expect(dbRow.purgeState).toBe('none');
    expect(dbRow.deletedByUserId).toBeNull();
    expect(dbRow.purgeRequestedAt).toBeNull();

    // 2. After reference is unlinked, re-running Stage 1 API + Stage 2 worker succeeds without 23514 wedge
    refCount = 0;
    const req2 = await requestDraftStoredFileDeletion({
      fileId: 'file-1',
      authenticatedUserId: 'user-1',
      repo: statefulApiRepo,
    });
    expect(req2).toEqual({ fileId: 'file-1', outcome: 'pending_purge', httpStatus: 202 });

    const retryResult = await processPendingStoredFileDeletion({
      fileId: 'file-1',
      ownerUserId: 'user-1',
      now: new Date('2026-11-15T10:05:00.000Z'),
      repo: statefulWorkerRepo,
      storage: storageAdapter,
    });
    expect(retryResult).toEqual({ fileId: 'file-1', outcome: 'purged' });
    expect(dbRow.purgeState).toBe('purged');
    expect(dbRow.uploadStatus).toBe('deleted');
    expect(dbRow.deletedByUserId).toBe('user-1');

    // 3. Attempting rollback on already-purged row fails
    await expect(statefulWorkerRepo.revertPendingPurgeToNone('file-1', 'user-1')).rejects.toThrow(
      /SQLSTATE 23514/,
    );
  });
});

