import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StudexoDatabase } from '../src/server/db/client';
import * as schema from '../src/server/db/schema/index';
import {
  createPostgresFilePurgeLeaseRecoveryRepository,
  createPostgresFilePurgeWorkerRepository,
  STORED_FILE_LIFECYCLE_COLUMNS,
} from '../src/server/modules/lifecycle/postgresFilePurgeRepository';
import { createPostgresAccountPurgeRepository } from '../src/server/modules/lifecycle/postgresAccountPurgeRepository';
import {
  processPendingStoredFileDeletion,
  type StoredFileLifecycleRecord,
} from '../src/server/modules/lifecycle/storageAndPurge';

const STEP_7_GRANTED_SELECT_COLUMNS = new Set([
  'id',
  'owner_user_id',
  'storage_bucket',
  'object_key',
  'upload_status',
  'deleted_at',
  'deleted_by_user_id',
  'purge_state',
  'purge_requested_at',
  'purge_lease_until',
  'purge_attempts',
  'last_purge_error',
  'purged_at',
]);

const STEP_7_GRANTED_UPDATE_COLUMNS = new Set([
  'upload_status',
  'deleted_at',
  'purge_state',
  'purge_requested_at',
  'purge_lease_until',
  'purge_attempts',
  'last_purge_error',
  'purged_at',
  'updated_at',
]);

interface MockFileRow extends StoredFileLifecycleRecord {
  deletedByUserId: string | null;
  purgeLeaseUntil: Date | null;
  lastPurgeError: string | null;
  purgeRequestedAt: Date | null;
  updatedAt: Date;
}

interface CapturedQuery {
  op: 'select' | 'update' | 'execute';
  sql: string;
  params: unknown[];
}

function createPostgresRepoHarness(options: {
  initialFile?: MockFileRow | null;
  blockingReferences?: number;
  now?: Date;
  onBeforeUpdateError?: Error;
}) {
  const dialect = new PgDialect();
  const dbNow = options.now ?? new Date('2026-11-16T12:00:00.000Z');
  let storedFile: MockFileRow | null = options.initialFile ? { ...options.initialFile } : null;
  let blockingRefs = options.blockingReferences ?? 0;

  const queries: CapturedQuery[] = [];
  const isolations: string[] = [];
  const txEvents: string[] = [];

  function buildTx(
    workingState: { file: MockFileRow | null; refs: number },
    inTransaction: boolean,
  ) {
    return {
      select: (projection: Record<string, unknown>) => ({
        from: (table: { [Symbol.toStringTag]?: string }) => {
          const tableSym = JSON.stringify(Object.keys(projection));
          const isDocVersionCount =
            Object.keys(projection).length === 1 && 'count' in projection;

          return {
            where: (whereExpr: SQL) => {
              const compiledWhere = dialect.sqlToQuery(whereExpr);
              const handleSelect = async () => {
                if (isDocVersionCount) {
                  queries.push({
                    op: 'select',
                    sql: `SELECT count(document_versions.id) WHERE ${compiledWhere.sql}`,
                    params: compiledWhere.params,
                  });
                  return [{ count: workingState.refs }];
                }

                const matches =
                  workingState.file !== null &&
                  compiledWhere.params.includes(workingState.file.id) &&
                  compiledWhere.params.includes(workingState.file.ownerUserId);

                if (!matches || !workingState.file) {
                  return [];
                }

                const f = workingState.file;
                const isLeaseActive =
                  f.purgeState === 'purging' &&
                  f.purgeLeaseUntil !== null &&
                  f.purgeLeaseUntil.getTime() > dbNow.getTime();

                return [
                  {
                    ...f,
                    ...('isLeaseActive' in projection ? { isLeaseActive } : {}),
                  },
                ];
              };

              const chain = {
                limit: (_n: number) => ({
                  for: async (mode: string) => {
                    queries.push({
                      op: 'select',
                      sql: `SELECT ${tableSym} FROM stored_files WHERE ${compiledWhere.sql} LIMIT 1 FOR ${mode.toUpperCase()}`,
                      params: compiledWhere.params,
                    });
                    return handleSelect();
                  },
                  then: (
                    onfulfilled: (value: unknown[]) => unknown,
                    onrejected?: (reason: unknown) => unknown,
                  ) => {
                    queries.push({
                      op: 'select',
                      sql: `SELECT ${tableSym} FROM ${String(table)} WHERE ${compiledWhere.sql} LIMIT 1`,
                      params: compiledWhere.params,
                    });
                    return handleSelect().then(onfulfilled, onrejected);
                  },
                }),
                then: (
                  onfulfilled: (value: unknown[]) => unknown,
                  onrejected?: (reason: unknown) => unknown,
                ) => handleSelect().then(onfulfilled, onrejected),
              };
              return chain;
            },
          };
        },
      }),
      update: (_table: unknown) => ({
        set: (patch: Record<string, unknown>) => ({
          where: (whereExpr: SQL) => ({
            returning: async (returningCols: Record<string, unknown>) => {
              const compiledWhere = dialect.sqlToQuery(whereExpr);
              const setFragments: string[] = [];
              for (const [key, val] of Object.entries(patch)) {
                if (val && typeof val === 'object' && 'queryChunks' in (val as object)) {
                  const q = dialect.sqlToQuery(val as SQL);
                  setFragments.push(`${key}=${q.sql}`);
                } else {
                  setFragments.push(`${key}=$val`);
                }
              }
              queries.push({
                op: 'update',
                sql: `UPDATE stored_files SET ${setFragments.join(', ')} WHERE ${compiledWhere.sql} RETURNING ${Object.keys(returningCols).join(',')}`,
                params: compiledWhere.params,
              });

              if (options.onBeforeUpdateError) {
                throw options.onBeforeUpdateError;
              }

              if (!workingState.file) {
                return [];
              }

              const f = workingState.file;
              const matchesIdOwner =
                compiledWhere.params.includes(f.id) &&
                compiledWhere.params.includes(f.ownerUserId);
              if (!matchesIdOwner) {
                return [];
              }

              // Check markFilePendingPurge eligibility
              if (patch.purgeState === 'pending_purge') {
                if (
                  (f.purgeState !== 'none' && f.purgeState !== 'pending_purge') ||
                  f.uploadStatus === 'deleted'
                ) {
                  return [];
                }
                workingState.file = {
                  ...f,
                  purgeState: 'pending_purge',
                  purgeRequestedAt: f.purgeRequestedAt ?? dbNow,
                  updatedAt: dbNow,
                };
                return [{ ...workingState.file }];
              }

              // Check acquire lease -> purging
              if (patch.purgeState === 'purging') {
                const leaseSql = setFragments.find((s) => s.startsWith('purgeLeaseUntil='));
                let leaseSeconds = 60;
                if (leaseSql) {
                  const rawSqlObj = patch.purgeLeaseUntil as SQL;
                  const compiled = dialect.sqlToQuery(rawSqlObj);
                  const numericParam = compiled.params.find((p) => typeof p === 'number');
                  if (typeof numericParam === 'number') {
                    leaseSeconds = numericParam;
                  }
                }
                workingState.file = {
                  ...f,
                  purgeState: 'purging',
                  purgeAttempts: f.purgeAttempts + 1,
                  purgeLeaseUntil: new Date(dbNow.getTime() + leaseSeconds * 1000),
                  updatedAt: dbNow,
                };
                return [{ ...workingState.file }];
              }

              // Check markFilePurged
              if (patch.purgeState === 'purged') {
                if (f.purgeState !== 'purging') {
                  return [];
                }
                const completedAt =
                  patch.purgedAt instanceof Date ? patch.purgedAt : dbNow;
                workingState.file = {
                  ...f,
                  uploadStatus: 'deleted',
                  purgeState: 'purged',
                  deletedAt: f.deletedAt ?? completedAt,
                  purgedAt: completedAt,
                  purgeLeaseUntil: null,
                  updatedAt: dbNow,
                };
                return [{ id: workingState.file.id }];
              }

              // Check markFilePurgeFailed / recovery
              if (patch.purgeState === 'purge_failed') {
                if (f.purgeState !== 'purging') {
                  return [];
                }
                if (
                  compiledWhere.sql.includes('purge_lease_until') &&
                  f.purgeLeaseUntil !== null &&
                  f.purgeLeaseUntil.getTime() > dbNow.getTime()
                ) {
                  return [];
                }
                workingState.file = {
                  ...f,
                  purgeState: 'purge_failed',
                  purgeLeaseUntil: null,
                  lastPurgeError:
                    typeof patch.lastPurgeError === 'string'
                      ? patch.lastPurgeError
                      : f.lastPurgeError,
                  updatedAt: dbNow,
                };
                return [{ ...workingState.file }];
              }

              void inTransaction;
              return [];
            },
          }),
        }),
      }),
      execute: async (rawSql: SQL) => {
        const compiled = dialect.sqlToQuery(rawSql);
        queries.push({
          op: 'execute',
          sql: compiled.sql,
          params: compiled.params,
        });
        if (compiled.sql.includes('revert_stored_file_deletion_request') && workingState.file) {
          const [pFileId, pOwnerId] = compiled.params;
          const f = workingState.file;
          if (f.id !== pFileId || f.ownerUserId !== pOwnerId) {
            throw new Error('SQLSTATE 22023: Owned stored_files row does not exist');
          }
          if (
            f.purgeState !== 'pending_purge' ||
            f.purgeAttempts !== 0 ||
            f.purgeLeaseUntil !== null ||
            f.lastPurgeError !== null
          ) {
            throw new Error('SQLSTATE 23514: File ineligible for pending_purge -> none revert');
          }
          workingState.file = {
            ...f,
            purgeState: 'none',
            deletedByUserId: null,
            purgeRequestedAt: null,
            updatedAt: dbNow,
          };
        }
        return [];
      },
    };
  }

  const rootWorking = {
    get file() {
      return storedFile;
    },
    set file(val: MockFileRow | null) {
      storedFile = val;
    },
    get refs() {
      return blockingRefs;
    },
  };

  const rootTx = buildTx(rootWorking, false);

  const db = {
    ...rootTx,
    transaction: async <T>(
      fn: (tx: StudexoDatabase) => Promise<T>,
      config: { isolationLevel: string },
    ): Promise<T> => {
      isolations.push(config.isolationLevel);
      txEvents.push('tx:begin');
      const snapshot = {
        file: storedFile ? { ...storedFile } : null,
        refs: blockingRefs,
      };
      const tx = buildTx(snapshot, true) as unknown as StudexoDatabase;
      try {
        const res = await fn(tx);
        storedFile = snapshot.file;
        txEvents.push('tx:commit');
        return res;
      } catch (error) {
        txEvents.push('tx:rollback');
        throw error;
      }
    },
  } as unknown as StudexoDatabase;

  return {
    db,
    queries,
    isolations,
    txEvents,
    getFile: () => storedFile,
    setRefs: (count: number) => {
      blockingRefs = count;
    },
  };
}

function makeMockFile(overrides: Partial<MockFileRow> = {}): MockFileRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    ownerUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    storageBucket: 'private-docs',
    objectKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/doc.pdf',
    uploadStatus: 'uploaded',
    purgeState: 'pending_purge',
    deletedAt: null,
    deletedByUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    purgedAt: null,
    purgeAttempts: 0,
    purgeLeaseUntil: null,
    lastPurgeError: null,
    purgeRequestedAt: new Date('2026-11-16T11:00:00.000Z'),
    updatedAt: new Date('2026-11-16T11:00:00.000Z'),
    ...overrides,
  };
}

describe('Concrete PostgreSQL FilePurgeWorkerRepository & Atomic Lease Unit Verification', () => {
  it('1-2. returns unavailable(not_found) when file is missing or owned by a different user', async () => {
    const missingHarness = createPostgresRepoHarness({ initialFile: null });
    const missingRepo = createPostgresFilePurgeWorkerRepository(missingHarness.db);

    const missingRes = await missingRepo.acquireFilePurgeLeaseIfUnreferenced(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      60,
    );
    expect(missingRes).toEqual({ status: 'unavailable', reason: 'not_found', file: null });
    expect(missingHarness.isolations).toEqual(['read committed']);
    expect(missingHarness.queries[0]?.sql).toContain('FOR UPDATE');

    const wrongOwnerHarness = createPostgresRepoHarness({ initialFile: makeMockFile() });
    const wrongOwnerRepo = createPostgresFilePurgeWorkerRepository(wrongOwnerHarness.db);
    const wrongOwnerRes = await wrongOwnerRepo.acquireFilePurgeLeaseIfUnreferenced(
      '11111111-1111-4111-8111-111111111111',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      60,
    );
    expect(wrongOwnerRes).toEqual({ status: 'unavailable', reason: 'not_found', file: null });
  });

  it('3-4. refuses active purging leases and recovers expired purging leases via PostgreSQL time', async () => {
    const now = new Date('2026-11-16T12:00:00.000Z');

    // Active lease (expires in future) -> must NOT steal or increment purge_attempts
    const activeHarness = createPostgresRepoHarness({
      now,
      initialFile: makeMockFile({
        purgeState: 'purging',
        purgeAttempts: 1,
        purgeLeaseUntil: new Date('2026-11-16T12:02:00.000Z'),
      }),
    });
    const activeRepo = createPostgresFilePurgeWorkerRepository(activeHarness.db);
    const activeRes = await activeRepo.acquireFilePurgeLeaseIfUnreferenced(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      60,
    );
    expect(activeRes.status).toBe('unavailable');
    if (activeRes.status === 'unavailable') {
      expect(activeRes.reason).toBe('active_lease');
      expect(activeRes.file?.purgeAttempts).toBe(1);
    }
    expect(activeHarness.getFile()?.purgeAttempts).toBe(1);
    expect(activeHarness.queries.some((q) => q.op === 'update')).toBe(false);

    // Expired lease -> acquires lease, increments purge_attempts, computes expiry with PG time
    const expiredHarness = createPostgresRepoHarness({
      now,
      initialFile: makeMockFile({
        purgeState: 'purging',
        purgeAttempts: 1,
        purgeLeaseUntil: new Date('2026-11-16T11:59:00.000Z'),
      }),
    });
    const expiredRepo = createPostgresFilePurgeWorkerRepository(expiredHarness.db);
    const expiredRes = await expiredRepo.acquireFilePurgeLeaseIfUnreferenced(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      90,
    );
    expect(expiredRes.status).toBe('acquired');
    if (expiredRes.status === 'acquired') {
      expect(expiredRes.file.purgeState).toBe('purging');
      expect(expiredRes.file.purgeAttempts).toBe(2);
      expect(expiredRes.file.purgeLeaseUntil?.toISOString()).toBe('2026-11-16T12:01:30.000Z');
    }

    const updateQuery = expiredHarness.queries.find((q) => q.op === 'update');
    expect(updateQuery?.sql).toContain('pg_catalog.now()');
    expect(updateQuery?.sql).toContain('pg_catalog.make_interval');
  });

  it('5. returns blocked_by_references without mutating stored_files and preserves untouched-file rollback', async () => {
    const harness = createPostgresRepoHarness({
      initialFile: makeMockFile({
        purgeState: 'pending_purge',
        purgeAttempts: 0,
        purgeLeaseUntil: null,
        lastPurgeError: null,
      }),
      blockingReferences: 2,
    });
    const repo = createPostgresFilePurgeWorkerRepository(harness.db);

    const removedObjects: string[] = [];
    const result = await processPendingStoredFileDeletion({
      fileId: '11111111-1111-4111-8111-111111111111',
      ownerUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      repo,
      storage: {
        removeObject: async (_bucket, key) => {
          removedObjects.push(key);
        },
        verifyObjectAbsent: async () => true,
      },
    });

    expect(result).toEqual({
      fileId: '11111111-1111-4111-8111-111111111111',
      outcome: 'reverted_blocked_by_refs',
      blockingReferences: 2,
    });
    expect(removedObjects).toEqual([]);
    expect(harness.getFile()?.purgeState).toBe('none');
    expect(harness.getFile()?.deletedByUserId).toBeNull();
    expect(harness.getFile()?.purgeRequestedAt).toBeNull();
    expect(
      harness.queries.some(
        (q) =>
          q.op === 'execute' &&
          q.sql.includes('studexo.revert_stored_file_deletion_request'),
      ),
    ).toBe(true);

    // Touched purge_failed file with blocking references must throw without calling revert RPC
    const failedHarness = createPostgresRepoHarness({
      initialFile: makeMockFile({
        purgeState: 'purge_failed',
        purgeAttempts: 1,
        lastPurgeError: 'previous storage error',
      }),
      blockingReferences: 1,
    });
    const failedRepo = createPostgresFilePurgeWorkerRepository(failedHarness.db);
    await expect(
      processPendingStoredFileDeletion({
        fileId: '11111111-1111-4111-8111-111111111111',
        ownerUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        repo: failedRepo,
        storage: { removeObject: async () => {}, verifyObjectAbsent: async () => true },
      }),
    ).rejects.toThrow(/active document or evidence reference/);
    expect(
      failedHarness.queries.some((q) =>
        q.sql.includes('revert_stored_file_deletion_request'),
      ),
    ).toBe(false);
    expect(failedHarness.getFile()?.purgeState).toBe('purge_failed');
  });

  it('6-9. acquires lease cleanly with zero refs, rolls back transaction on DB errors, and validates leaseSeconds', async () => {
    const successHarness = createPostgresRepoHarness({
      now: new Date('2026-11-16T12:00:00.000Z'),
      initialFile: makeMockFile({ purgeState: 'pending_purge', purgeAttempts: 0 }),
      blockingReferences: 0,
    });
    const successRepo = createPostgresFilePurgeWorkerRepository(successHarness.db);

    const res = await successRepo.acquireFilePurgeLeaseIfUnreferenced(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      45,
    );
    expect(res.status).toBe('acquired');
    if (res.status === 'acquired') {
      expect(res.file.purgeState).toBe('purging');
      expect(res.file.purgeAttempts).toBe(1);
      expect(res.file.purgeLeaseUntil?.toISOString()).toBe('2026-11-16T12:00:45.000Z');
    }
    expect(successHarness.txEvents).toEqual(['tx:begin', 'tx:commit']);

    // Invalid leaseSeconds rejects before starting DB work
    await expect(
      successRepo.acquireFilePurgeLeaseIfUnreferenced(
        '11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        0,
      ),
    ).rejects.toThrow(/leaseSeconds/);
    await expect(
      successRepo.acquireFilePurgeLease(
        '11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        Number.NaN,
      ),
    ).rejects.toThrow(/leaseSeconds/);

    // DB failure inside transaction rolls back cleanly without mutating row
    const errorHarness = createPostgresRepoHarness({
      initialFile: makeMockFile({ purgeState: 'pending_purge', purgeAttempts: 0 }),
      blockingReferences: 0,
      onBeforeUpdateError: new Error('simulated PG connection drop'),
    });
    const errorRepo = createPostgresFilePurgeWorkerRepository(errorHarness.db);
    await expect(
      errorRepo.acquireFilePurgeLeaseIfUnreferenced(
        '11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        60,
      ),
    ).rejects.toThrow(/simulated PG connection drop/);
    expect(errorHarness.txEvents).toEqual(['tx:begin', 'tx:rollback']);
    expect(errorHarness.getFile()?.purgeState).toBe('pending_purge');
    expect(errorHarness.getFile()?.purgeAttempts).toBe(0);
  });

  it('10. enforces Step 7 column-grant boundaries and two-method account-purge support (plus recovery repo)', async () => {
    // Every column in STORED_FILE_LIFECYCLE_COLUMNS must belong to Step 7 SELECT grant
    const projectedSqlColumns = Object.values(STORED_FILE_LIFECYCLE_COLUMNS).map((col) => col.name);
    expect(projectedSqlColumns).toHaveLength(12);
    for (const colName of projectedSqlColumns) {
      expect(STEP_7_GRANTED_SELECT_COLUMNS.has(colName)).toBe(true);
    }

    // Verify postgresFilePurgeRepository.ts never writes ungranted columns like deletedByUserId
    const repoSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src', 'server', 'modules', 'lifecycle', 'postgresFilePurgeRepository.ts'),
      'utf8',
    );
    expect(repoSource).not.toMatch(/\.set\(\{[^}]*deletedByUserId/s);
    expect(repoSource).not.toContain('.returning()');
    for (const updateCol of [
      'upload_status',
      'deleted_at',
      'purge_state',
      'purge_requested_at',
      'purge_lease_until',
      'purge_attempts',
      'last_purge_error',
      'purged_at',
      'updated_at',
    ]) {
      expect(STEP_7_GRANTED_UPDATE_COLUMNS.has(updateCol)).toBe(true);
    }

    // Account-purge method (acquireFilePurgeLease) ignores blocking document_versions references
    const accountPurgeHarness = createPostgresRepoHarness({
      initialFile: makeMockFile({ purgeState: 'pending_purge' }),
      blockingReferences: 3,
    });
    const repo = createPostgresFilePurgeWorkerRepository(accountPurgeHarness.db);
    const leased = await repo.acquireFilePurgeLease(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      60,
    );
    expect(leased?.purgeState).toBe('purging');
    expect(
      accountPurgeHarness.queries.some((q) => q.sql.includes('document_versions')),
    ).toBe(false);

    // Lease recovery repo transitions expired purging -> purge_failed and rejects active leases
    const expiredRecoveryHarness = createPostgresRepoHarness({
      now: new Date('2026-11-16T12:00:00.000Z'),
      initialFile: makeMockFile({
        purgeState: 'purging',
        purgeAttempts: 2,
        purgeLeaseUntil: new Date('2026-11-16T11:58:00.000Z'),
      }),
    });
    const recoveryRepo = createPostgresFilePurgeLeaseRecoveryRepository(expiredRecoveryHarness.db);
    const recovered = await recoveryRepo.markExpiredPurgeLeaseFailed({
      fileId: '11111111-1111-4111-8111-111111111111',
      ownerUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      failedAt: new Date('2026-11-16T12:00:00.000Z'),
      errorMessage: 'lease expired',
    });
    expect(recovered?.purgeState).toBe('purge_failed');
    expect(recovered?.purgeAttempts).toBe(2);
    expect(recovered?.purgeLeaseUntil).toBeNull();
    expect(recovered?.lastPurgeError).toBe('lease expired');
  });
  it('11. coordinates mid-transaction FOR UPDATE lock barriers around acquireFilePurgeLeaseIfUnreferenced()', async () => {
    const harness = createPostgresRepoHarness({
      initialFile: makeMockFile({ purgeState: 'pending_purge', purgeAttempts: 0 }),
      blockingReferences: 0,
    });

    const lockAcquiredBarrier = createDeferredBarrier('unit-test FOR UPDATE lock acquired');
    const releaseLockBarrier = createDeferredBarrier('unit-test release FOR UPDATE lock');
    const eventOrder: string[] = [];

    const barrierDb = createLockBarrierDatabase(harness.db, async () => {
      eventOrder.push('after:for_update_lock');
      lockAcquiredBarrier.release();
      await releaseLockBarrier.wait();
      eventOrder.push('resumed:after_barrier');
    });

    const repo = createPostgresFilePurgeWorkerRepository(barrierDb);
    let leaseSettled = false;
    const leasePromise = repo
      .acquireFilePurgeLeaseIfUnreferenced(
        '11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        60,
      )
      .finally(() => {
        leaseSettled = true;
      });

    await lockAcquiredBarrier.wait();
    // At the barrier, FOR UPDATE has executed, but reference count and UPDATE have not run yet
    expect(leaseSettled).toBe(false);
    expect(harness.queries).toHaveLength(1);
    expect(harness.queries[0]?.sql).toContain('FOR UPDATE');
    expect(harness.getFile()?.purgeState).toBe('pending_purge');

    releaseLockBarrier.release();
    const result = await leasePromise;
    expect(leaseSettled).toBe(true);
    expect(result.status).toBe('acquired');
    expect(eventOrder).toEqual(['after:for_update_lock', 'resumed:after_barrier']);
    expect(harness.queries).toHaveLength(3);
  });
});

interface DeferredBarrier {
  wait: () => Promise<void>;
  release: () => void;
}

function createDeferredBarrier(label: string, timeoutMs = 5_000): DeferredBarrier {
  let resolveFn!: () => void;
  let released = false;
  const promise = new Promise<void>((resolve) => {
    resolveFn = () => {
      released = true;
      resolve();
    };
  });

  return {
    async wait() {
      if (released) {
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`Timed out after ${timeoutMs}ms waiting for barrier: ${label}`));
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    },
    release() {
      resolveFn();
    },
  };
}

/**
 * Wraps a `StudexoDatabase` instance so that `onAfterForUpdateLock` is invoked inside the
 * active transaction immediately after `SELECT ... FOR UPDATE` acquires the `stored_files`
 * row lock and before `acquireFilePurgeLeaseIfUnreferenced()` runs its reference count,
 * `UPDATE`, or `COMMIT`. Does not alter any SQL generated by the production repository.
 */
function createLockBarrierDatabase(
  baseDb: StudexoDatabase,
  onAfterForUpdateLock: (context: { tx: StudexoDatabase }) => Promise<void>,
): StudexoDatabase {
  const wrapTx = (tx: StudexoDatabase): StudexoDatabase =>
    new Proxy(tx, {
      get(target, prop, receiver) {
        if (prop !== 'select') {
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        }

        return (...selectArgs: Parameters<StudexoDatabase['select']>) => {
          const selectBuilder = target.select(...selectArgs);
          return new Proxy(selectBuilder, {
            get(sTarget, sProp, sReceiver) {
              if (sProp !== 'from') {
                const value = Reflect.get(sTarget, sProp, sReceiver);
                return typeof value === 'function' ? value.bind(sTarget) : value;
              }

              return (...fromArgs: Parameters<typeof selectBuilder.from>) => {
                const fromBuilder = sTarget.from(...fromArgs);
                return new Proxy(fromBuilder, {
                  get(fTarget, fProp, fReceiver) {
                    if (fProp !== 'where') {
                      const value = Reflect.get(fTarget, fProp, fReceiver);
                      return typeof value === 'function' ? value.bind(fTarget) : value;
                    }

                    return (...whereArgs: Parameters<typeof fromBuilder.where>) => {
                      const whereBuilder = fTarget.where(...whereArgs);
                      return new Proxy(whereBuilder, {
                        get(wTarget, wProp, wReceiver) {
                          if (wProp !== 'limit') {
                            const value = Reflect.get(wTarget, wProp, wReceiver);
                            return typeof value === 'function' ? value.bind(wTarget) : value;
                          }

                          return (...limitArgs: Parameters<typeof whereBuilder.limit>) => {
                            const limitBuilder = wTarget.limit(...limitArgs);
                            return new Proxy(limitBuilder, {
                              get(lTarget, lProp, lReceiver) {
                                if (lProp !== 'for') {
                                  const value = Reflect.get(lTarget, lProp, lReceiver);
                                  return typeof value === 'function'
                                    ? value.bind(lTarget)
                                    : value;
                                }

                                return async (
                                  ...forArgs: Parameters<typeof limitBuilder.for>
                                ) => {
                                  const lockedRows = await lTarget.for(...forArgs);
                                  await onAfterForUpdateLock({ tx: target });
                                  return lockedRows;
                                };
                              },
                            });
                          };
                        },
                      });
                    };
                  },
                });
              };
            },
          });
        };
      },
    });

  return new Proxy(baseDb, {
    get(target, prop, receiver) {
      if (prop !== 'transaction') {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }

      return async <T>(
        fn: (tx: StudexoDatabase) => Promise<T>,
        config?: Parameters<StudexoDatabase['transaction']>[1],
      ): Promise<T> => {
        return target.transaction(async (realTx) => fn(wrapTx(realTx)), config);
      };
    },
  });
}

interface ObservedLockWait {
  blockedPid: number;
  waitEventType: string | null;
  waitEvent: string | null;
  state: string | null;
  query: string;
  blockingPids: number[];
}

/**
 * Polls `pg_catalog.pg_stat_activity` and `pg_catalog.pg_blocking_pids(pid)` to deterministically
 * verify that a concurrent transaction is blocked on a PostgreSQL lock.
 */
async function waitForPostgresLockWait(
  observerSql: Sql,
  options: {
    blockedQueryPattern: string;
    blockerPid?: number;
    timeoutMs?: number;
  },
): Promise<ObservedLockWait> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = await observerSql<
      {
        blockedPid: number;
        waitEventType: string | null;
        waitEvent: string | null;
        state: string | null;
        query: string;
        blockingPids: number[];
      }[]
    >`
      SELECT
        a.pid::int AS "blockedPid",
        a.wait_event_type AS "waitEventType",
        a.wait_event AS "waitEvent",
        a.state AS "state",
        a.query AS "query",
        ARRAY(SELECT unnest(pg_catalog.pg_blocking_pids(a.pid))::int) AS "blockingPids"
      FROM pg_catalog.pg_stat_activity a
      WHERE a.datname = pg_catalog.current_database()
        AND a.pid <> pg_catalog.pg_backend_pid()
        AND a.wait_event_type = 'Lock'
        AND pg_catalog.cardinality(pg_catalog.pg_blocking_pids(a.pid)) > 0
        AND a.query ILIKE ${`%${options.blockedQueryPattern}%`}
    `;

    for (const row of rows) {
      if (
        options.blockerPid === undefined ||
        row.blockingPids.includes(options.blockerPid)
      ) {
        return row;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for PostgreSQL lock wait matching "${options.blockedQueryPattern}"` +
      (options.blockerPid !== undefined ? ` blocked by PID ${options.blockerPid}` : ''),
  );
}

/**
 * Real PostgreSQL Concurrency & Role-Isolation Suite.
 * Executes only when `TEST_POSTGRES_URL` points to an isolated disposable PostgreSQL 17+ test database.
 */
const TEST_POSTGRES_URL = process.env.TEST_POSTGRES_URL?.trim();

describe.skipIf(!TEST_POSTGRES_URL)(
  'Real PostgreSQL atomic file-purge lease concurrency & Step 7 role enforcement',
  () => {
    let adminSql: Sql;
    let workerSql: Sql;
    let workerDb: StudexoDatabase;
    let testRoleAdminPassword: string;

    function assertDisposableTestDatabaseUrl(rawUrl: string): void {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname.toLowerCase();
      if (
        rawUrl.includes('yxhqqdbywxjhcejdmtkq') ||
        host.endsWith('.supabase.co') ||
        host.endsWith('.pooler.supabase.com')
      ) {
        throw new Error(
          'Refusing to run destructive concurrency tests against a Supabase staging or production host.',
        );
      }
    }

    async function setupSchemaAndRoles() {
      const sqlFiles = [
        '0000_init_studexo_mvp.sql',
        '0001_studexo_integrity_triggers_and_extensions.sql',
        '0002_studexo_user_insert_and_file_rollback_guards.sql',
        '0003_studexo_schema_lockout_and_outbox_guard.sql',
        '0004_fenced_account_purge.sql',
        '0005_fenced_account_purge_equality.sql',
      ];

      await adminSql.unsafe(`
        CREATE SCHEMA IF NOT EXISTS extensions;
        CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studexo_migrator') THEN
            CREATE ROLE studexo_migrator LOGIN NOINHERIT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studexo_purge_owner') THEN
            CREATE ROLE studexo_purge_owner NOLOGIN NOINHERIT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studexo_app') THEN
            CREATE ROLE studexo_app LOGIN NOINHERIT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studexo_purge_worker') THEN
            CREATE ROLE studexo_purge_worker LOGIN NOINHERIT PASSWORD '${testRoleAdminPassword}';
          ELSE
            ALTER ROLE studexo_purge_worker WITH LOGIN NOINHERIT PASSWORD '${testRoleAdminPassword}';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studexo_catalog_admin') THEN
            CREATE ROLE studexo_catalog_admin NOLOGIN NOINHERIT;
          END IF;
        END $$;
        CREATE SCHEMA IF NOT EXISTS studexo AUTHORIZATION studexo_migrator;
        CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION studexo_migrator;
        GRANT USAGE ON SCHEMA extensions TO studexo_migrator, studexo_app, studexo_purge_worker, studexo_catalog_admin;
      `);

      const migratedRows = await adminSql<{ alreadyMigrated: boolean }[]>`
        SELECT to_regclass('studexo.stored_files') IS NOT NULL AS "alreadyMigrated"
      `;
      const alreadyMigrated = Boolean(migratedRows[0]?.alreadyMigrated);

      if (!alreadyMigrated) {
        await adminSql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE studexo_migrator`);
          for (const fileName of sqlFiles) {
            const raw = fs.readFileSync(path.resolve(process.cwd(), 'drizzle', fileName), 'utf8');
            const statements = raw.split('--> statement-breakpoint');
            for (const stmt of statements) {
              const trimmed = stmt.trim();
              if (trimmed) {
                await tx.unsafe(trimmed);
              }
            }
          }
        });
      }

      await adminSql.unsafe(`
        REVOKE ALL ON FUNCTION studexo.execute_account_purge(uuid, varchar, integer) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION studexo.execute_account_purge(uuid, varchar, integer) TO studexo_purge_worker;
        GRANT USAGE, CREATE ON SCHEMA studexo TO studexo_purge_owner;
        ALTER FUNCTION studexo.execute_account_purge(uuid, varchar, integer) OWNER TO studexo_purge_owner;
        REVOKE CREATE ON SCHEMA studexo FROM studexo_purge_owner;
        GRANT USAGE ON SCHEMA studexo TO studexo_purge_owner;
        GRANT SELECT, UPDATE, DELETE ON studexo.users TO studexo_purge_owner;
        GRANT SELECT, UPDATE (deleted_by_user_id), DELETE ON studexo.stored_files TO studexo_purge_owner;
        GRANT SELECT, DELETE ON studexo.documents, studexo.application_documents TO studexo_purge_owner;
        GRANT SELECT, UPDATE, DELETE ON
          studexo.auth_identities,
          studexo.account_settings,
          studexo.user_consents,
          studexo.student_profiles,
          studexo.student_qualifications,
          studexo.student_test_scores,
          studexo.student_experiences,
          studexo.student_publications_and_projects,
          studexo.document_versions,
          studexo.saved_opportunities,
          studexo.university_applications,
          studexo.scholarship_applications,
          studexo.application_checklists,
          studexo.application_notes,
          studexo.application_status_history,
          studexo.planner_tasks,
          studexo.planner_events,
          studexo.notification_preferences,
          studexo.notification_deliveries,
          studexo.ai_permissions,
          studexo.ai_conversations,
          studexo.ai_messages,
          studexo.ai_runs,
          studexo.ai_usage_records,
          studexo.ai_run_context_links
        TO studexo_purge_owner;
        GRANT SELECT, UPDATE (verified_by_user_id) ON studexo.verification_claims TO studexo_purge_owner;
        GRANT INSERT, SELECT ON studexo.external_identity_purge_outbox TO studexo_purge_owner;
        GRANT EXECUTE ON FUNCTION studexo.is_auth_user_pending_purge(uuid) TO studexo_purge_owner;

        GRANT USAGE ON SCHEMA studexo TO studexo_app;
        GRANT SELECT, INSERT, UPDATE ON studexo.users TO studexo_app;
        GRANT SELECT, INSERT ON studexo.stored_files TO studexo_app;
        GRANT UPDATE (original_filename, mime_type, byte_size, sha256_checksum, upload_status, uploaded_at, updated_at) ON studexo.stored_files TO studexo_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON studexo.documents, studexo.document_versions TO studexo_app;
        GRANT EXECUTE ON FUNCTION studexo.request_stored_file_deletion(uuid, uuid) TO studexo_app;
        GRANT EXECUTE ON FUNCTION studexo.is_auth_user_pending_purge(uuid) TO studexo_app;

        GRANT USAGE ON SCHEMA studexo TO studexo_purge_worker;
        GRANT SELECT (id, supabase_auth_user_id, status, deletion_requested_at, deletion_scheduled_for, purge_state, purge_lease_owner, purge_lease_until, purge_attempts, last_purge_error, purged_at) ON studexo.users TO studexo_purge_worker;
        GRANT UPDATE (purge_state, purge_lease_owner, purge_lease_until, purge_attempts, last_purge_error, purged_at, updated_at) ON studexo.users TO studexo_purge_worker;
        GRANT SELECT (id, owner_user_id, storage_bucket, object_key, upload_status, deleted_at, deleted_by_user_id, purge_state, purge_requested_at, purge_lease_until, purge_attempts, last_purge_error, purged_at) ON studexo.stored_files TO studexo_purge_worker;
        GRANT UPDATE (upload_status, deleted_at, purge_state, purge_requested_at, purge_lease_until, purge_attempts, last_purge_error, purged_at, updated_at) ON studexo.stored_files TO studexo_purge_worker;
        GRANT SELECT (id, stored_file_id, user_id) ON studexo.document_versions TO studexo_purge_worker;
        GRANT SELECT ON studexo.external_identity_purge_outbox TO studexo_purge_worker;
        GRANT UPDATE (status, attempt_count, next_attempt_at, lease_owner, locked_until, last_error_code, last_error_message, completed_at, updated_at) ON studexo.external_identity_purge_outbox TO studexo_purge_worker;
        GRANT EXECUTE ON FUNCTION studexo.revert_stored_file_deletion_request(uuid, uuid) TO studexo_purge_worker;
        GRANT EXECUTE ON FUNCTION studexo.is_auth_user_pending_purge(uuid) TO studexo_purge_worker;
      `);
    }

    beforeAll(async () => {
      assertDisposableTestDatabaseUrl(TEST_POSTGRES_URL!);
      testRoleAdminPassword = crypto.randomBytes(16).toString('hex');
      adminSql = postgres(TEST_POSTGRES_URL!, { prepare: false, max: 5 });
      await setupSchemaAndRoles();

      const workerUrl = new URL(TEST_POSTGRES_URL!);
      workerUrl.username = 'studexo_purge_worker';
      workerUrl.password = testRoleAdminPassword;
      workerSql = postgres(workerUrl.toString(), { prepare: false, max: 5 });
      workerDb = drizzle(workerSql, { schema });
    });

    afterAll(async () => {
      await workerSql?.end({ timeout: 5 });
      await adminSql?.end({ timeout: 5 });
    });

    async function seedUserAndFile(params: {
      purgeState?: 'none' | 'pending_purge' | 'purging' | 'purge_failed';
      leaseOffsetSql?: string;
      purgeAttempts?: number;
    }) {
      const userId = crypto.randomUUID();
      const docId = crypto.randomUUID();
      const fileId = crypto.randomUUID();

      await adminSql.unsafe(`SET ROLE studexo_migrator`);
      try {
        await adminSql`
          INSERT INTO studexo.users (id, primary_email, display_name)
          VALUES (${userId}::uuid, ${`student-${userId}@example.com`}, 'Test Student')
        `;
        await adminSql`
          INSERT INTO studexo.documents (id, user_id, document_type, title)
          VALUES (${docId}::uuid, ${userId}::uuid, 'transcript', 'Academic Transcript')
        `;
        await adminSql`
          INSERT INTO studexo.stored_files (
            id, owner_user_id, storage_bucket, object_key, original_filename, mime_type, byte_size, upload_status
          ) VALUES (
            ${fileId}::uuid, ${userId}::uuid, 'private-docs', ${`${userId}/${fileId}.pdf`}, 'transcript.pdf', 'application/pdf', 1024, 'uploaded'
          )
        `;

        if (params.purgeState && params.purgeState !== 'none') {
          await adminSql`SELECT studexo.request_stored_file_deletion(${fileId}::uuid, ${userId}::uuid)`;
        }
        if (params.purgeState === 'purging' || params.purgeState === 'purge_failed') {
          await adminSql.unsafe(`SET ROLE studexo_purge_worker`);
          const leaseExpr = params.leaseOffsetSql ?? `pg_catalog.now() + interval '60 seconds'`;
          await adminSql.unsafe(
            `UPDATE studexo.stored_files
                SET purge_state = '${params.purgeState}',
                    purge_attempts = ${params.purgeAttempts ?? 1},
                    purge_lease_until = ${params.purgeState === 'purging' ? leaseExpr : 'NULL'}
              WHERE id = '${fileId}'::uuid`,
          );
        }
      } finally {
        await adminSql.unsafe(`RESET ROLE`);
      }

      return { userId, docId, fileId };
    }

    it('enforces concurrent workers race, expired lease recovery, untouched rollback, and both acquireFilePurgeLeaseIfUnreferenced() concurrency interleavings', async () => {
      const workerRepo = createPostgresFilePurgeWorkerRepository(workerDb);

      // A. Two concurrent purge workers racing on same pending_purge file -> 1 acquired, 1 active_lease
      const { userId: u1, fileId: f1 } = await seedUserAndFile({ purgeState: 'pending_purge' });
      const [r1, r2] = await Promise.all([
        workerRepo.acquireFilePurgeLeaseIfUnreferenced(f1, u1, 60),
        workerRepo.acquireFilePurgeLeaseIfUnreferenced(f1, u1, 60),
      ]);
      const outcomes = [r1.status, r2.status].sort();
      expect(outcomes).toEqual(['acquired', 'unavailable']);
      const loser = r1.status === 'unavailable' ? r1 : r2;
      if (loser.status === 'unavailable') {
        expect(loser.reason).toBe('active_lease');
      }

      // B. Expired lease recovered cleanly by studexo_purge_worker
      const { userId: u2, fileId: f2 } = await seedUserAndFile({
        purgeState: 'purging',
        leaseOffsetSql: `pg_catalog.now() - interval '10 seconds'`,
        purgeAttempts: 1,
      });
      const recovered = await workerRepo.acquireFilePurgeLeaseIfUnreferenced(f2, u2, 60);
      expect(recovered.status).toBe('acquired');
      if (recovered.status === 'acquired') {
        expect(recovered.file.purgeAttempts).toBe(2);
      }

      const appConnSql = postgres(TEST_POSTGRES_URL!, { prepare: false, max: 2 });
      try {
        // C. Interleaving A (Purge-first):
        // 1. Transaction A calls actual acquireFilePurgeLeaseIfUnreferenced() and obtains FOR UPDATE lock on stored_files.
        // 2. Ensure Transaction A has not committed.
        // 3. Transaction B attempts to insert a document_versions row referencing the same file.
        // 4. Verify Transaction B blocks on the trigger's FOR SHARE lock via pg_stat_activity / pg_blocking_pids.
        // 5. Allow Transaction A to finish and commit the lease acquisition.
        // 6. Verify Transaction B resumes and fails with SQLSTATE 23514.
        // 7. Verify final file state is purging and reference row was not inserted.
        const { userId: u3, docId: d3, fileId: f3 } = await seedUserAndFile({
          purgeState: 'pending_purge',
        });
        const txALockAcquired = createDeferredBarrier('Interleaving A: txA acquired FOR UPDATE');
        const releaseTxACommit = createDeferredBarrier('Interleaving A: release txA to commit');
        let txAPidA = 0;

        const barrierWorkerDb = createLockBarrierDatabase(workerDb, async ({ tx }) => {
          const pidRows = (await tx.execute(
            sql`SELECT pg_catalog.pg_backend_pid()::int AS pid`,
          )) as unknown as Array<{ pid: number }>;
          txAPidA = Number(pidRows[0]?.pid ?? 0);

          const [lockGrantedRow] = await adminSql<{ granted: boolean }[]>`
            SELECT EXISTS (
              SELECT 1
              FROM pg_catalog.pg_locks l
              JOIN pg_catalog.pg_class c ON c.oid = l.relation
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE l.pid = ${txAPidA}::int
                AND n.nspname = 'studexo'
                AND c.relname = 'stored_files'
                AND l.mode = 'RowShareLock'
                AND l.granted = true
            ) AS granted
          `;
          expect(lockGrantedRow?.granted).toBe(true);

          txALockAcquired.release();
          await releaseTxACommit.wait();
        });
        const barrierWorkerRepo = createPostgresFilePurgeWorkerRepository(barrierWorkerDb);

        let txASettledA = false;
        const txAPromiseA = barrierWorkerRepo
          .acquireFilePurgeLeaseIfUnreferenced(f3, u3, 60)
          .finally(() => {
            txASettledA = true;
          });

        let txBSettledA = false;
        let txBPromiseA: Promise<unknown> | undefined;
        try {
          await txALockAcquired.wait();
          expect(txASettledA).toBe(false);
          expect(txAPidA).toBeGreaterThan(0);

          // Confirm via independent read that Transaction A has not committed the purging state yet
          const uncommittedViewA = await workerRepo.getFileForPurge(f3, u3);
          expect(uncommittedViewA?.purgeState).toBe('pending_purge');
          expect(uncommittedViewA?.purgeAttempts).toBe(0);

          txBPromiseA = appConnSql
            .begin(async (aTx) => {
              await aTx.unsafe(`SET LOCAL ROLE studexo_app`);
              await aTx`
                INSERT INTO studexo.document_versions (document_id, user_id, stored_file_id, version_number)
                VALUES (${d3}::uuid, ${u3}::uuid, ${f3}::uuid, 1)
              `;
            })
            .finally(() => {
              txBSettledA = true;
            });

          const observedWaitA = await waitForPostgresLockWait(adminSql, {
            blockedQueryPattern: 'INSERT INTO studexo.document_versions',
            blockerPid: txAPidA,
          });
          console.info(
            '[LIVE-PG17-EVIDENCE] Interleaving A (Purge-First Lock Wait):',
            JSON.stringify({
              blockerPid: txAPidA,
              blockedPid: observedWaitA.blockedPid,
              blockingPids: observedWaitA.blockingPids,
              waitEventType: observedWaitA.waitEventType,
              waitEvent: observedWaitA.waitEvent,
              state: observedWaitA.state,
            }),
          );
          expect(observedWaitA.waitEventType).toBe('Lock');
          expect(observedWaitA.blockingPids).toContain(txAPidA);
          expect(txBSettledA).toBe(false);
          expect(txASettledA).toBe(false);
        } finally {
          releaseTxACommit.release();
        }

        const txAResultA = await txAPromiseA;
        expect(txAResultA.status).toBe('acquired');
        if (txAResultA.status === 'acquired') {
          expect(txAResultA.file.purgeState).toBe('purging');
          expect(txAResultA.file.purgeAttempts).toBe(1);
        }

        await expect(txBPromiseA).rejects.toMatchObject({ code: '23514' });

        const finalFileA = await workerRepo.getFileForPurge(f3, u3);
        expect(finalFileA?.purgeState).toBe('purging');
        expect(finalFileA?.purgeAttempts).toBe(1);
        const [refCountA] = await adminSql<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM studexo.document_versions
          WHERE stored_file_id = ${f3}::uuid
        `;
        expect(refCountA?.count).toBe(0);

        // D. Interleaving B (Reference-first):
        // 1. Transaction A inserts a valid document_versions row while the file is eligible (purge_state = 'none').
        // 2. Ensure the trigger's FOR SHARE lock on stored_files remains held.
        // 3. Transition the file to pending_purge within Transaction A respecting guard_stored_files_lifecycle().
        // 4. Transaction B calls the actual acquireFilePurgeLeaseIfUnreferenced() method.
        // 5. Verify Transaction B blocks on FOR UPDATE via pg_stat_activity / pg_blocking_pids.
        // 6. Commit Transaction A.
        // 7. Verify Transaction B resumes and returns blocked_by_references.
        // 8. Verify no lease was acquired and the file's purge state and attempts remain unchanged by the lease attempt.
        const { userId: u4, docId: d4, fileId: f4 } = await seedUserAndFile({
          purgeState: 'none',
        });
        const txAReadyB = createDeferredBarrier('Interleaving B: txA holds lock after ref insert');
        const releaseTxACommitB = createDeferredBarrier('Interleaving B: release txA to commit');
        let txAPidB = 0;

        const txAPromiseB = appConnSql.begin(async (txA) => {
          const [pidRow] = await txA<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid()::int AS pid`;
          txAPidB = Number(pidRow?.pid ?? 0);

          await txA.unsafe(`SET LOCAL ROLE studexo_app`);
          await txA`
            INSERT INTO studexo.document_versions (document_id, user_id, stored_file_id, version_number)
            VALUES (${d4}::uuid, ${u4}::uuid, ${f4}::uuid, 1)
          `;

          // Confirm trigger's FOR SHARE lock on studexo.stored_files is actively held by Transaction A
          const [shareLockHeld] = await txA<{ held: boolean }[]>`
            SELECT EXISTS (
              SELECT 1
              FROM pg_catalog.pg_locks l
              JOIN pg_catalog.pg_class c ON c.oid = l.relation
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE l.pid = pg_catalog.pg_backend_pid()
                AND n.nspname = 'studexo'
                AND c.relname = 'stored_files'
                AND l.mode = 'RowShareLock'
                AND l.granted = true
            ) AS held
          `;
          expect(shareLockHeld?.held).toBe(true);

          // Transition file to pending_purge within Transaction A respecting guard_stored_files_lifecycle()
          await txA.unsafe(`SET LOCAL ROLE studexo_migrator`);
          await txA`SELECT pg_catalog.set_config('studexo.file_deletion_mode', 'request', true)`;
          await txA`
            UPDATE studexo.stored_files
               SET deleted_by_user_id = ${u4}::uuid,
                   purge_state = 'pending_purge',
                   purge_requested_at = pg_catalog.now()
             WHERE id = ${f4}::uuid
          `;
          await txA`SELECT pg_catalog.set_config('studexo.file_deletion_mode', '', true)`;

          txAReadyB.release();
          await releaseTxACommitB.wait();
        });

        let txBSettledB = false;
        let txBPromiseB: ReturnType<typeof workerRepo.acquireFilePurgeLeaseIfUnreferenced> | undefined;
        try {
          await txAReadyB.wait();
          expect(txAPidB).toBeGreaterThan(0);

          txBPromiseB = workerRepo
            .acquireFilePurgeLeaseIfUnreferenced(f4, u4, 60)
            .finally(() => {
              txBSettledB = true;
            });

          const observedWaitB = await waitForPostgresLockWait(adminSql, {
            blockedQueryPattern: 'FOR UPDATE',
            blockerPid: txAPidB,
          });
          console.info(
            '[LIVE-PG17-EVIDENCE] Interleaving B (Reference-First Lock Wait):',
            JSON.stringify({
              blockerPid: txAPidB,
              blockedPid: observedWaitB.blockedPid,
              blockingPids: observedWaitB.blockingPids,
              waitEventType: observedWaitB.waitEventType,
              waitEvent: observedWaitB.waitEvent,
              state: observedWaitB.state,
            }),
          );
          expect(observedWaitB.waitEventType).toBe('Lock');
          expect(observedWaitB.blockingPids).toContain(txAPidB);
          expect(txBSettledB).toBe(false);
        } finally {
          releaseTxACommitB.release();
        }

        await txAPromiseB;
        const txBResultB = await txBPromiseB!;
        expect(txBResultB.status).toBe('blocked_by_references');
        if (txBResultB.status === 'blocked_by_references') {
          expect(txBResultB.blockingReferences).toBe(1);
          expect(txBResultB.file.purgeState).toBe('pending_purge');
          expect(txBResultB.file.purgeAttempts).toBe(0);
          expect(txBResultB.file.purgeLeaseUntil).toBeNull();
        }

        const finalFileB = await workerRepo.getFileForPurge(f4, u4);
        expect(finalFileB?.purgeState).toBe('pending_purge');
        expect(finalFileB?.purgeAttempts).toBe(0);
        expect(finalFileB?.purgeLeaseUntil).toBeNull();

        // Untouched pending_purge file blocked by reference reverts cleanly to none via revertPendingPurgeToNone
        await workerRepo.revertPendingPurgeToNone(f4, u4);
        const revertedFileB = await workerRepo.getFileForPurge(f4, u4);
        expect(revertedFileB?.purgeState).toBe('none');
        expect(revertedFileB?.deletedByUserId).toBeNull();

        // E. Previously attempted file (purge_failed / purge_attempts > 0) is rejected by revertPendingPurgeToNone (SQLSTATE 23514)
        const { userId: uFailed, fileId: fFailed } = await seedUserAndFile({
          purgeState: 'purge_failed',
          purgeAttempts: 1,
        });
        await expect(workerRepo.revertPendingPurgeToNone(fFailed, uFailed)).rejects.toMatchObject({
          cause: { code: '23514' },
        });

        // Verify studexo_purge_worker is denied SELECT on ungranted columns (sha256_checksum) and UPDATE on deleted_by_user_id (SQLSTATE 42501)
        await expect(
          workerSql`SELECT sha256_checksum FROM studexo.stored_files WHERE id = ${fFailed}::uuid`,
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          workerSql`UPDATE studexo.stored_files SET deleted_by_user_id = NULL WHERE id = ${fFailed}::uuid`,
        ).rejects.toMatchObject({ code: '42501' });

        // F. Account-purge two-method path: departing user with document_versions still referencing stored_file
        // acquires lease via acquireFilePurgeLease, marks purged, and executes studexo.execute_account_purge(userId)
        const { userId: u5, docId: d5, fileId: f5 } = await seedUserAndFile({ purgeState: 'none' });
        await adminSql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE studexo_app`);
          await tx`
            INSERT INTO studexo.document_versions (document_id, user_id, stored_file_id, version_number)
            VALUES (${d5}::uuid, ${u5}::uuid, ${f5}::uuid, 1)
          `;
        });
        await adminSql.unsafe(`SET ROLE studexo_purge_owner`);
        try {
          await adminSql`
            UPDATE studexo.users
               SET status = 'pending_deletion',
                   purge_state = 'pending_purge',
                   deletion_requested_at = pg_catalog.now() - interval '15 days',
                   deletion_scheduled_for = pg_catalog.now() - interval '1 day'
             WHERE id = ${u5}::uuid
          `;
        } finally {
          await adminSql.unsafe(`RESET ROLE`);
        }

        const accountRepo = createPostgresAccountPurgeRepository(workerDb);
        const accountUser = await accountRepo.markUserPurging({
          userId: u5,
          leaseOwner: 'test-file-purge-lease-worker',
          leaseSeconds: 60,
        });
        expect(accountUser).not.toBeNull();
        expect(accountUser?.purgeState).toBe('purging');
        expect(accountUser?.purgeLeaseOwner).not.toBeNull();
        expect(accountUser?.purgeAttempts).toBeGreaterThan(0);

        await workerRepo.markFilePendingPurge(f5, u5);
        const blockedBySingleFile = await workerRepo.acquireFilePurgeLeaseIfUnreferenced(f5, u5, 60);
        expect(blockedBySingleFile.status).toBe('blocked_by_references');

        const accountLease = await workerRepo.acquireFilePurgeLease(f5, u5, 60);
        expect(accountLease?.purgeState).toBe('purging');
        await workerRepo.markFilePurged(f5, u5);
        await accountRepo.executeAccountPurgeRpc(u5, {
          expectedLeaseOwner: accountUser!.purgeLeaseOwner!,
          expectedPurgeAttempts: accountUser!.purgeAttempts,
        });

        // Confirm user, document_versions, and stored_files rows were purged by execute_account_purge
        const [remainingFiles] = await adminSql<{ count: number }[]>`
          SELECT count(*)::int AS count FROM studexo.stored_files WHERE id = ${f5}::uuid
        `;
        expect(remainingFiles?.count).toBe(0);

        const [remainingUser] = await adminSql<{ count: number }[]>`
          SELECT count(*)::int AS count FROM studexo.users WHERE id = ${u5}::uuid
        `;
        expect(remainingUser?.count).toBe(0);

        // Verify isolation guard rejects known staging and hosted Supabase endpoints
        expect(() =>
          assertDisposableTestDatabaseUrl(
            'postgresql://postgres:secret@db.yxhqqdbywxjhcejdmtkq.supabase.co:5432/postgres',
          ),
        ).toThrow(/Refusing to run destructive concurrency tests/);
        expect(() =>
          assertDisposableTestDatabaseUrl(
            'postgresql://postgres.yxhqqdbywxjhcejdmtkq:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres',
          ),
        ).toThrow(/Refusing to run destructive concurrency tests/);
      } finally {
        await appConnSql.end({ timeout: 5 });
      }
    });
  },
);

