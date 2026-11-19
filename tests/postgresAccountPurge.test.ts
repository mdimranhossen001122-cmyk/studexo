import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getTableName, is, sql } from 'drizzle-orm';
import { PgColumn } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StudexoDatabase } from '../src/server/db/client';
import * as schema from '../src/server/db/schema';
import {
  EXTERNAL_IDENTITY_OUTBOX_LOOKUP_COLUMNS,
  USER_LIFECYCLE_COLUMNS,
  createPostgresAccountPurgeLeaseRecoveryRepository,
  createPostgresAccountPurgeRepository,
} from '../src/server/modules/lifecycle/postgresAccountPurgeRepository';
import {
  STORED_FILE_LIFECYCLE_COLUMNS,
  createPostgresFilePurgeLeaseRecoveryRepository,
  createPostgresFilePurgeWorkerRepository,
} from '../src/server/modules/lifecycle/postgresFilePurgeRepository';
import {
  type ExternalIdentityOutboxItem,
  type StoredFileLifecycleRecord,
  type UserLifecycleRecord,
  executeStorageFirstAccountPurge,
  recoverInterruptedAccountPurge,
} from '../src/server/modules/lifecycle/storageAndPurge';

function flattenSqlChunk(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (is(value, PgColumn)) {
    return `${getTableName(value.table)}.${value.name}`;
  }
  if (typeof value === 'object') {
    const maybeChunk = value as { value?: unknown; queryChunks?: unknown[] };
    if (Array.isArray(maybeChunk.value)) {
      return maybeChunk.value.map(flattenSqlChunk).join('');
    }
    if (
      typeof maybeChunk.value === 'string' ||
      typeof maybeChunk.value === 'number' ||
      typeof maybeChunk.value === 'boolean'
    ) {
      return String(maybeChunk.value);
    }
    if (Array.isArray(maybeChunk.queryChunks)) {
      return maybeChunk.queryChunks.map(flattenSqlChunk).join('');
    }
  }
  return '';
}

interface SimulatedAccountDbState {
  user: (UserLifecycleRecord & { updatedAt: Date }) | null;
  files: StoredFileLifecycleRecord[];
  outbox: ExternalIdentityOutboxItem[];
  now: Date;
  selectProjections: Array<{ table: string; columns: string[] }>;
  forUpdateCalls: number;
  isolationLevels: string[];
  updateWhereSqls: string[];
  updateSetSqls: string[];
  executedSqls: string[];
  onAfterLock?: () => Promise<void> | void;
}

function createSimulatedAccountStudexoDatabase(state: SimulatedAccountDbState): StudexoDatabase {
  const extractColumns = (projection: Record<string, unknown>): string[] =>
    Object.values(projection).map((col) => {
      if (is(col, PgColumn)) {
        return col.name;
      }
      return flattenSqlChunk(col);
    });

  const txImpl = {
    select(projection: Record<string, unknown>) {
      const cols = extractColumns(projection);
      return {
        from(table: unknown) {
          const tableName = getTableName(table as Parameters<typeof getTableName>[0]);
          state.selectProjections.push({ table: tableName, columns: cols });

          return {
            where(_whereExpr: unknown) {
              if (tableName === 'stored_files') {
                return {
                  orderBy(_orderExpr: unknown) {
                    const sorted = [...state.files].sort((a, b) => a.id.localeCompare(b.id));
                    return Promise.resolve(sorted.map((f) => ({ ...f })));
                  },
                };
              }
              return {
                limit(_n: number) {
                  const buildUserRow = () => {
                    if (!state.user) {
                      return [];
                    }
                    const isGraceExpired =
                      state.user.status === 'pending_deletion' &&
                      state.user.deletionScheduledFor !== null &&
                      state.user.deletionScheduledFor.getTime() <= state.now.getTime();
                    const isLeaseActive =
                      state.user.purgeState === 'purging' &&
                      state.user.purgeLeaseUntil != null &&
                      state.user.purgeLeaseUntil.getTime() > state.now.getTime();
                    const isLeaseExpired =
                      state.user.purgeState === 'purging' &&
                      (state.user.purgeLeaseUntil == null ||
                        state.user.purgeLeaseUntil.getTime() <= state.now.getTime());

                    return [
                      {
                        ...state.user,
                        isGraceExpired,
                        isLeaseActive,
                        isLeaseExpired,
                      },
                    ];
                  };

                  const buildOutboxRow = () => {
                    const whereSql = flattenSqlChunk(_whereExpr);
                    const found = state.outbox.find((item) =>
                      whereSql.includes(item.supabaseAuthUserId),
                    );
                    return found ? [{ ...found }] : [];
                  };

                  const rowsPromise = Promise.resolve(
                    tableName === 'external_identity_purge_outbox'
                      ? buildOutboxRow()
                      : buildUserRow(),
                  );

                  return Object.assign(rowsPromise, {
                    async for(mode: string) {
                      if (mode === 'update') {
                        state.forUpdateCalls += 1;
                      }
                      const rows = buildUserRow();
                      if (state.onAfterLock) {
                        const hook = state.onAfterLock;
                        state.onAfterLock = undefined;
                        await hook();
                      }
                      return rows;
                    },
                  });
                },
              };
            },
          };
        },
      };
    },

    update(table: unknown) {
      const tableName = getTableName(table as Parameters<typeof getTableName>[0]);
      if (tableName !== 'users') {
        throw new Error(`Unexpected update on table ${tableName}`);
      }
      return {
        set(values: Record<string, unknown>) {
          const setSql = Object.entries(values)
            .map(([k, v]) => `${k}=${flattenSqlChunk(v)}`)
            .join(', ');
          state.updateSetSqls.push(setSql);

          return {
            where(whereExpr: unknown) {
              const whereSql = flattenSqlChunk(whereExpr);
              state.updateWhereSqls.push(whereSql);

              return {
                async returning(returningProjection: Record<string, unknown>) {
                  state.selectProjections.push({
                    table: 'users:returning',
                    columns: extractColumns(returningProjection),
                  });

                  if (!state.user) {
                    return [];
                  }

                  if (values.purgeState === 'purging') {
                    const graceOk =
                      state.user.status === 'pending_deletion' &&
                      state.user.deletionScheduledFor !== null &&
                      state.user.deletionScheduledFor.getTime() <= state.now.getTime();
                    const stateOk =
                      state.user.purgeState === 'pending_purge' ||
                      state.user.purgeState === 'purge_failed' ||
                      state.user.purgeState === 'purging';
                    const leaseExpiredOrNotPurging =
                      state.user.purgeState !== 'purging' ||
                      state.user.purgeLeaseUntil == null ||
                      state.user.purgeLeaseUntil.getTime() <= state.now.getTime();

                    if (!graceOk || !stateOk || !leaseExpiredOrNotPurging) {
                      return [];
                    }

                    const secsMatch = flattenSqlChunk(values.purgeLeaseUntil).match(
                      /secs => ([0-9.]+)::double precision/,
                    );
                    const secs = secsMatch ? Number(secsMatch[1]) : 60;
                    state.user = {
                      ...state.user,
                      purgeState: 'purging',
                      purgeLeaseOwner: String(values.purgeLeaseOwner),
                      purgeLeaseUntil: new Date(state.now.getTime() + secs * 1000),
                      purgeAttempts: state.user.purgeAttempts + 1,
                      updatedAt: state.now,
                    };
                    return [{ ...state.user }];
                  }

                  if (values.purgeState === 'purge_failed') {
                    // Distinguish fenced markUserPurgeFailed vs recovery markExpiredAccountPurgeLeaseFailed
                    const isFencedUpdate = whereSql.includes('users.purge_lease_owner');
                    if (isFencedUpdate) {
                      if (
                        state.user.status !== 'pending_deletion' ||
                        state.user.purgeState !== 'purging' ||
                        !whereSql.includes(String(state.user.purgeLeaseOwner)) ||
                        !whereSql.includes(String(state.user.purgeAttempts))
                      ) {
                        return [];
                      }
                    } else {
                      const isExpired =
                        state.user.status === 'pending_deletion' &&
                        state.user.purgeState === 'purging' &&
                        (state.user.purgeLeaseUntil == null ||
                          state.user.purgeLeaseUntil.getTime() <= state.now.getTime());
                      if (!isExpired) {
                        return [];
                      }
                    }

                    state.user = {
                      ...state.user,
                      purgeState: 'purge_failed',
                      purgeLeaseOwner: null,
                      purgeLeaseUntil: null,
                      lastPurgeError: (values.lastPurgeError as string) ?? null,
                      updatedAt: state.now,
                    };
                    return [{ ...state.user }];
                  }

                  return [];
                },
              };
            },
          };
        },
      };
    },

    async execute(query: unknown) {
      const sqlText = flattenSqlChunk(query);
      state.executedSqls.push(sqlText);
      if (sqlText.includes('studexo.execute_account_purge') && state.user) {
        if (state.user.supabaseAuthUserId) {
          state.outbox.push({
            id: '00000000-0000-4000-8000-000000000999',
            formerUserId: state.user.id,
            supabaseAuthUserId: state.user.supabaseAuthUserId,
            status: 'pending_purge',
            attemptCount: 0,
            maxAttempts: 10,
          });
        }
        state.files = [];
        state.user = null;
      }
      return [];
    },
  };

  const db = {
    ...txImpl,
    async transaction<T>(
      callback: (tx: typeof txImpl) => Promise<T>,
      config?: { isolationLevel?: string },
    ): Promise<T> {
      state.isolationLevels.push(config?.isolationLevel ?? 'default');
      return callback(txImpl);
    },
  };

  return db as unknown as StudexoDatabase;
}

describe('Phase 8B.4A — Concrete PostgreSQL Account-Purge Repositories (Offline Verification)', () => {
  const baseNow = new Date('2026-11-17T12:00:00.000Z');
  const userId = '11111111-1111-4111-8111-111111111111';
  const authUserId = '22222222-2222-4222-8222-222222222222';

  function makeUser(overrides: Partial<UserLifecycleRecord> = {}): UserLifecycleRecord & { updatedAt: Date } {
    return {
      id: userId,
      supabaseAuthUserId: authUserId,
      status: 'pending_deletion',
      purgeState: 'pending_purge',
      deletionRequestedAt: new Date('2026-10-01T00:00:00.000Z'),
      deletionScheduledFor: new Date('2026-11-01T00:00:00.000Z'),
      purgeLeaseOwner: null,
      purgeLeaseUntil: null,
      purgeAttempts: 0,
      lastPurgeError: null,
      updatedAt: baseNow,
      ...overrides,
    };
  }

  it('enforces explicit least-privilege column projections on users, stored_files, and external_identity_purge_outbox', () => {
    const userColumns = Object.values(USER_LIFECYCLE_COLUMNS).map((col) => col.name);
    expect(userColumns).toEqual([
      'id',
      'supabase_auth_user_id',
      'status',
      'purge_state',
      'deletion_requested_at',
      'deletion_scheduled_for',
      'purge_lease_owner',
      'purge_lease_until',
      'purge_attempts',
      'last_purge_error',
    ]);

    // Restricted columns on studexo.users must NEVER be projected by studexo_purge_worker
    const forbiddenUserColumns = [
      'primary_email',
      'display_name',
      'role',
      'created_at',
      'updated_at',
    ];
    for (const forbidden of forbiddenUserColumns) {
      expect(userColumns).not.toContain(forbidden);
    }

    const outboxColumns = Object.values(EXTERNAL_IDENTITY_OUTBOX_LOOKUP_COLUMNS).map(
      (col) => col.name,
    );
    expect(outboxColumns).toEqual([
      'id',
      'former_user_id',
      'supabase_auth_user_id',
      'status',
      'attempt_count',
      'max_attempts',
    ]);

    const fileColumns = Object.values(STORED_FILE_LIFECYCLE_COLUMNS).map((col) => col.name);
    expect(fileColumns).not.toContain('created_at');
    expect(fileColumns).not.toContain('updated_at');
  });

  it('acquires an account-purge lease using READ COMMITTED, FOR UPDATE, and PostgreSQL make_interval(secs => leaseSeconds)', async () => {
    const state: SimulatedAccountDbState = {
      user: makeUser({ purgeState: 'pending_purge', purgeAttempts: 1 }),
      files: [],
      outbox: [],
      now: baseNow,
      selectProjections: [],
      forUpdateCalls: 0,
      isolationLevels: [],
      updateWhereSqls: [],
      updateSetSqls: [],
      executedSqls: [],
    };
    const repo = createPostgresAccountPurgeRepository(createSimulatedAccountStudexoDatabase(state));

    const acquired = await repo.markUserPurging({
      userId,
      leaseOwner: 'worker-alpha',
      leaseSeconds: 90,
    });

    expect(acquired).not.toBeNull();
    expect(acquired?.purgeState).toBe('purging');
    expect(acquired?.purgeLeaseOwner).toBe('worker-alpha');
    expect(acquired?.purgeAttempts).toBe(2);
    expect(acquired?.purgeLeaseUntil).toEqual(new Date(baseNow.getTime() + 90_000));
    expect(state.isolationLevels).toEqual(['read committed']);
    expect(state.forUpdateCalls).toBe(1);
    expect(state.updateSetSqls[0]).toContain(
      'pg_catalog.now() + pg_catalog.make_interval(secs => 90::double precision)',
    );
  });

  it('rejects ineligible users, active leases (even with same leaseOwner), and invalid lease parameters, while allowing expired lease takeover', async () => {
    const state: SimulatedAccountDbState = {
      user: makeUser({ status: 'active', purgeState: 'none' }),
      files: [],
      outbox: [],
      now: baseNow,
      selectProjections: [],
      forUpdateCalls: 0,
      isolationLevels: [],
      updateWhereSqls: [],
      updateSetSqls: [],
      executedSqls: [],
    };
    const repo = createPostgresAccountPurgeRepository(createSimulatedAccountStudexoDatabase(state));

    await expect(
      repo.markUserPurging({ userId, leaseOwner: 'worker-1', leaseSeconds: 0 }),
    ).rejects.toThrow(/leaseSeconds must be a finite positive number/);
    await expect(
      repo.markUserPurging({ userId, leaseOwner: '   ', leaseSeconds: 60 }),
    ).rejects.toThrow(/leaseOwner must be a non-empty string/);

    // Active user rejected
    expect(
      await repo.markUserPurging({ userId, leaseOwner: 'worker-1', leaseSeconds: 60 }),
    ).toBeNull();

    // Future deletion_scheduled_for rejected
    state.user = makeUser({
      status: 'pending_deletion',
      purgeState: 'pending_purge',
      deletionScheduledFor: new Date(baseNow.getTime() + 60_000),
    });
    expect(
      await repo.markUserPurging({ userId, leaseOwner: 'worker-1', leaseSeconds: 60 }),
    ).toBeNull();

    // Active purging lease rejected even when same leaseOwner is supplied
    state.user = makeUser({
      status: 'pending_deletion',
      purgeState: 'purging',
      purgeLeaseOwner: 'worker-same',
      purgeLeaseUntil: new Date(baseNow.getTime() + 30_000),
      purgeAttempts: 1,
    });
    expect(
      await repo.markUserPurging({ userId, leaseOwner: 'worker-same', leaseSeconds: 60 }),
    ).toBeNull();

    // Expired purging lease taken over cleanly
    state.user = makeUser({
      status: 'pending_deletion',
      purgeState: 'purging',
      purgeLeaseOwner: 'worker-same',
      purgeLeaseUntil: new Date(baseNow.getTime() - 1_000),
      purgeAttempts: 1,
    });
    const takenOver = await repo.markUserPurging({
      userId,
      leaseOwner: 'worker-same',
      leaseSeconds: 120,
    });
    expect(takenOver).not.toBeNull();
    expect(takenOver?.purgeAttempts).toBe(2);
    expect(takenOver?.purgeLeaseOwner).toBe('worker-same');
  });

  it('fences stale markUserPurgeFailed calls across both different worker identities and reused worker identities', async () => {
    const state: SimulatedAccountDbState = {
      user: makeUser({
        purgeState: 'purging',
        purgeLeaseOwner: 'worker-b',
        purgeLeaseUntil: new Date(baseNow.getTime() + 60_000),
        purgeAttempts: 2,
      }),
      files: [],
      outbox: [],
      now: baseNow,
      selectProjections: [],
      forUpdateCalls: 0,
      isolationLevels: [],
      updateWhereSqls: [],
      updateSetSqls: [],
      executedSqls: [],
    };
    const repo = createPostgresAccountPurgeRepository(createSimulatedAccountStudexoDatabase(state));

    // Case A: Stale worker with different leaseOwner ('worker-a', attempt 1) must not clobber 'worker-b' attempt 2
    const staleDifferentOwner = await repo.markUserPurgeFailed(userId, 'stale error from worker-a', {
      expectedLeaseOwner: 'worker-a',
      expectedPurgeAttempts: 1,
    });
    expect(staleDifferentOwner).toEqual({
      status: 'stale_lease',
      user: expect.objectContaining({
        purgeState: 'purging',
        purgeLeaseOwner: 'worker-b',
        purgeAttempts: 2,
      }),
    });
    expect(state.user?.purgeState).toBe('purging');
    expect(state.user?.purgeLeaseOwner).toBe('worker-b');
    expect(state.user?.lastPurgeError).toBeNull();

    // Case B: Stale worker with SAME leaseOwner ('worker-b', attempt 1) must not clobber 'worker-b' attempt 2
    const staleSameOwner = await repo.markUserPurgeFailed(userId, 'stale error from attempt 1', {
      expectedLeaseOwner: 'worker-b',
      expectedPurgeAttempts: 1,
    });
    expect(staleSameOwner).toEqual({
      status: 'stale_lease',
      user: expect.objectContaining({
        purgeState: 'purging',
        purgeLeaseOwner: 'worker-b',
        purgeAttempts: 2,
      }),
    });
    expect(state.user?.purgeState).toBe('purging');
    expect(state.user?.purgeLeaseOwner).toBe('worker-b');
    expect(state.user?.lastPurgeError).toBeNull();

    // Case C: Current lease holder ('worker-b', attempt 2) records failure and clears lease
    const recorded = await repo.markUserPurgeFailed(userId, 'real failure on attempt 2', {
      expectedLeaseOwner: 'worker-b',
      expectedPurgeAttempts: 2,
    });
    expect(recorded).toEqual({
      status: 'recorded',
      user: expect.objectContaining({
        purgeState: 'purge_failed',
        purgeLeaseOwner: null,
        purgeLeaseUntil: null,
        purgeAttempts: 2,
        lastPurgeError: 'real failure on attempt 2',
      }),
    });
  });

  it('recovers expired account purge leases using PostgreSQL time, preserves purgeAttempts and previous errors, and performs read-only outbox lookup', async () => {
    const state: SimulatedAccountDbState = {
      user: makeUser({
        purgeState: 'purging',
        purgeLeaseOwner: 'crashed-worker',
        purgeLeaseUntil: new Date(baseNow.getTime() - 5_000),
        purgeAttempts: 3,
        lastPurgeError: 'earlier storage timeout',
      }),
      files: [],
      outbox: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          formerUserId: userId,
          supabaseAuthUserId: authUserId,
          status: 'pending_purge',
          attemptCount: 1,
          maxAttempts: 10,
        },
      ],
      now: baseNow,
      selectProjections: [],
      forUpdateCalls: 0,
      isolationLevels: [],
      updateWhereSqls: [],
      updateSetSqls: [],
      executedSqls: [],
    };
    const db = createSimulatedAccountStudexoDatabase(state);
    const recoveryRepo = createPostgresAccountPurgeLeaseRecoveryRepository(db);

    const outbox = await recoveryRepo.findExternalIdentityOutboxByAuthUserId(authUserId);
    expect(outbox).toEqual({
      id: '33333333-3333-4333-8333-333333333333',
      formerUserId: userId,
      supabaseAuthUserId: authUserId,
      status: 'pending_purge',
      attemptCount: 1,
      maxAttempts: 10,
    });
    expect(await recoveryRepo.findExternalIdentityOutboxByAuthUserId('missing-auth-id')).toBeNull();

    const recovered = await recoveryRepo.markExpiredAccountPurgeLeaseFailed({
      userId,
      errorMessage: 'Lease expired during worker crash',
    });
    expect(recovered).not.toBeNull();
    expect(recovered?.purgeState).toBe('purge_failed');
    expect(recovered?.purgeLeaseOwner).toBeNull();
    expect(recovered?.purgeLeaseUntil).toBeNull();
    expect(recovered?.purgeAttempts).toBe(3);
    expect(recovered?.lastPurgeError).toBe(
      'Lease expired during worker crash | previous: earlier storage timeout',
    );

    // Repeated recovery on already purge_failed user returns null idempotently
    expect(
      await recoveryRepo.markExpiredAccountPurgeLeaseFailed({
        userId,
        errorMessage: 'Second recovery call',
      }),
    ).toBeNull();
  });
});

// ============================================================================
// REAL POSTGRESQL 17 INTEGRATION & CONCURRENCY SUITE
// ============================================================================
const TEST_POSTGRES_URL = process.env.TEST_POSTGRES_URL?.trim();

const FORBIDDEN_HOST_PATTERNS = [
  'yxhqqdbywxjhcejdmtkq',
  'supabase.co',
  'supabase.com',
  'pooler.supabase.com',
  'aws-0-',
  'aws-1-',
];

export function assertDisposableTestDatabaseUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('TEST_POSTGRES_URL is not a valid URL.');
  }
  const host = parsed.hostname.toLowerCase();
  const dbName = parsed.pathname.replace(/^\//, '').toLowerCase();

  for (const pattern of FORBIDDEN_HOST_PATTERNS) {
    if (rawUrl.toLowerCase().includes(pattern)) {
      throw new Error(
        `Refusing to run destructive integration tests against forbidden host pattern '${pattern}'.`,
      );
    }
  }

  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error(
      `TEST_POSTGRES_URL must target localhost/127.0.0.1/::1 for disposable testing (got host '${host}').`,
    );
  }

  if (!dbName.includes('test') && !dbName.includes('disposable')) {
    throw new Error(
      `TEST_POSTGRES_URL database name must include 'test' or 'disposable' (got '${dbName}').`,
    );
  }
}

interface DeferredBarrier {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferredBarrier(): DeferredBarrier {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createLockBarrierDatabase(
  baseDb: StudexoDatabase,
  hooks: {
    onTransactionStart?: (tx: StudexoDatabase) => Promise<void>;
    onRowLocked?: () => void;
    holdAfterRowLocked?: Promise<void>;
  },
): StudexoDatabase {
  const wrapForUpdateSelect = <T extends Record<string, unknown>>(target: T): T =>
    new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver);
        if (typeof value !== 'function') {
          return value;
        }
        if (prop === 'for') {
          return (...args: unknown[]) => {
            const queryBuilder = value.apply(obj, args);
            return new Proxy(queryBuilder, {
              get(qObj, qProp, qReceiver) {
                if (qProp === 'then') {
                  return (
                    onFulfilled?: (v: unknown) => unknown,
                    onRejected?: (e: unknown) => unknown,
                  ) =>
                    (queryBuilder as Promise<unknown>).then(async (rows) => {
                      hooks.onRowLocked?.();
                      if (hooks.holdAfterRowLocked) {
                        await hooks.holdAfterRowLocked;
                      }
                      return onFulfilled ? onFulfilled(rows) : rows;
                    }, onRejected);
                }
                const qVal = Reflect.get(qObj, qProp, qReceiver);
                return typeof qVal === 'function' ? qVal.bind(qObj) : qVal;
              },
            });
          };
        }
        return (...args: unknown[]) => {
          const next = value.apply(obj, args);
          if (next && typeof next === 'object') {
            return wrapForUpdateSelect(next as Record<string, unknown>);
          }
          return next;
        };
      },
    });

  return new Proxy(baseDb, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return async (
          callback: (tx: StudexoDatabase) => Promise<unknown>,
          config?: { isolationLevel?: string },
        ) =>
          (target as unknown as {
            transaction: (
              cb: (tx: StudexoDatabase) => Promise<unknown>,
              cfg?: { isolationLevel?: string },
            ) => Promise<unknown>;
          }).transaction(async (tx) => {
            if (hooks.onTransactionStart) {
              await hooks.onTransactionStart(tx);
            }
            const proxiedTx = new Proxy(tx, {
              get(txTarget, txProp, txReceiver) {
                if (txProp === 'select') {
                  return (...selectArgs: unknown[]) => {
                    const selectBuilder = (
                      txTarget as unknown as { select: (...a: unknown[]) => Record<string, unknown> }
                    ).select(...selectArgs);
                    return wrapForUpdateSelect(selectBuilder);
                  };
                }
                const val = Reflect.get(txTarget, txProp, txReceiver);
                return typeof val === 'function' ? val.bind(txTarget) : val;
              },
            });
            return callback(proxiedTx);
          }, config);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function waitForPostgresLockWait(
  observerSql: ReturnType<typeof postgres>,
  blockerPid: number,
  timeoutMs = 5000,
): Promise<{ waiterPid: number; waitEventType: string; waitEvent: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await observerSql<
      Array<{ pid: number; wait_event_type: string | null; wait_event: string | null }>
    >`
      SELECT pid, wait_event_type, wait_event
      FROM pg_stat_activity
      WHERE state = 'active'
        AND wait_event_type = 'Lock'
        AND ${blockerPid} = ANY(pg_blocking_pids(pid))
    `;
    if (rows.length > 0 && rows[0]) {
      return {
        waiterPid: rows[0].pid,
        waitEventType: rows[0].wait_event_type ?? 'Lock',
        waitEvent: rows[0].wait_event ?? 'tuple',
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(
    `Timed out waiting for a PostgreSQL backend to block on lock held by PID ${blockerPid}.`,
  );
}

describe.skipIf(!TEST_POSTGRES_URL)(
  'Phase 8B.4A — Live Disposable PostgreSQL 17 Account-Purge & Concurrency Verification',
  () => {
    let adminSql: ReturnType<typeof postgres>;
    let workerSql: ReturnType<typeof postgres>;
    let workerDb: StudexoDatabase;
    let testRoleAdminPassword = '';

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
        GRANT SELECT (
          id,
          supabase_auth_user_id,
          status,
          deletion_requested_at,
          deletion_scheduled_for,
          purge_state,
          purge_lease_owner,
          purge_lease_until,
          purge_attempts,
          last_purge_error,
          purged_at
        ) ON studexo.users TO studexo_purge_worker;
        GRANT UPDATE (
          purge_state,
          purge_lease_owner,
          purge_lease_until,
          purge_attempts,
          last_purge_error,
          purged_at,
          updated_at
        ) ON studexo.users TO studexo_purge_worker;
        GRANT SELECT (
          id,
          owner_user_id,
          storage_bucket,
          object_key,
          upload_status,
          deleted_at,
          deleted_by_user_id,
          purge_state,
          purge_requested_at,
          purge_lease_until,
          purge_attempts,
          last_purge_error,
          purged_at
        ) ON studexo.stored_files TO studexo_purge_worker;
        GRANT UPDATE (
          upload_status,
          deleted_at,
          purge_state,
          purge_requested_at,
          purge_lease_until,
          purge_attempts,
          last_purge_error,
          purged_at,
          updated_at
        ) ON studexo.stored_files TO studexo_purge_worker;
        GRANT SELECT (id, stored_file_id, user_id) ON studexo.document_versions TO studexo_purge_worker;
        GRANT SELECT ON studexo.external_identity_purge_outbox TO studexo_purge_worker;
        GRANT UPDATE (
          status,
          attempt_count,
          next_attempt_at,
          lease_owner,
          locked_until,
          last_error_code,
          last_error_message,
          completed_at,
          updated_at
        ) ON studexo.external_identity_purge_outbox TO studexo_purge_worker;
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
      await workerSql?.end();
      await adminSql?.end();
    });

    async function seedAccountUser(params?: {
      status?: 'active' | 'suspended' | 'pending_deletion';
      purgeState?: 'none' | 'pending_purge' | 'purging' | 'purge_failed';
      graceWindowExpired?: boolean;
      leaseOffsetSeconds?: number | null;
      leaseOwner?: string | null;
      purgeAttempts?: number;
      lastPurgeError?: string | null;
    }) {
      const userId = crypto.randomUUID();
      const authId = crypto.randomUUID();
      const status = params?.status ?? 'pending_deletion';
      const purgeState = params?.purgeState ?? 'pending_purge';
      const graceExpired = params?.graceWindowExpired ?? true;
      const purgeAttempts = params?.purgeAttempts ?? 0;
      const lastPurgeError = params?.lastPurgeError ?? null;

      await adminSql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE studexo_migrator`);
        await tx.unsafe(
          `INSERT INTO studexo.users (id, supabase_auth_user_id, primary_email, display_name, role, status, purge_state)
           VALUES ($1::uuid, $2::uuid, $3, 'Account Purge Test', 'student', 'active', 'none')`,
          [userId, authId, `user-${userId}@example.com`],
        );

        await tx.unsafe(`SET LOCAL ROLE studexo_purge_owner`);
        if (status === 'suspended') {
          await tx.unsafe(`UPDATE studexo.users SET status = 'suspended' WHERE id = $1::uuid`, [
            userId,
          ]);
        } else if (status === 'pending_deletion') {
          const reqInterval = graceExpired ? `interval '31 days'` : `interval '1 day'`;
          const schedOffset = graceExpired ? `- interval '1 hour'` : `+ interval '14 days'`;
          const initialPurgeState = purgeState === 'none' ? 'none' : 'pending_purge';
          await tx.unsafe(
            `UPDATE studexo.users
                SET status = 'pending_deletion',
                    deletion_requested_at = pg_catalog.now() - ${reqInterval},
                    deletion_scheduled_for = pg_catalog.now() ${schedOffset},
                    purge_state = $2::studexo.purge_state
              WHERE id = $1::uuid`,
            [userId, initialPurgeState],
          );

          if (purgeState === 'purging' || purgeState === 'purge_failed') {
            await tx.unsafe(`SET LOCAL ROLE studexo_purge_worker`);
            const owner = params?.leaseOwner ?? 'seed-worker';
            const leaseOffset = params?.leaseOffsetSeconds ?? 60;
            await tx.unsafe(
              `UPDATE studexo.users
                  SET purge_state = 'purging',
                      purge_lease_owner = $2,
                      purge_lease_until = pg_catalog.now() + pg_catalog.make_interval(secs => $3::double precision),
                      purge_attempts = $4,
                      last_purge_error = $5
                WHERE id = $1::uuid`,
              [userId, owner, Math.max(leaseOffset, 10), Math.max(purgeAttempts, 1), lastPurgeError],
            );

            if (purgeState === 'purge_failed') {
              await tx.unsafe(
                `UPDATE studexo.users
                    SET purge_state = 'purge_failed',
                        purge_lease_owner = NULL,
                        purge_lease_until = NULL,
                        last_purge_error = $2
                  WHERE id = $1::uuid`,
                [userId, lastPurgeError ?? 'seeded failure'],
              );
            } else if (leaseOffset <= 0) {
              await tx.unsafe(`SET LOCAL ROLE studexo_migrator`);
              await tx.unsafe(`ALTER TABLE studexo.users DISABLE TRIGGER trg_users_lifecycle`);
              await tx.unsafe(
                `UPDATE studexo.users
                    SET purge_lease_until = pg_catalog.now() - pg_catalog.make_interval(secs => $2::double precision)
                  WHERE id = $1::uuid`,
                [userId, Math.abs(leaseOffset) + 5],
              );
              await tx.unsafe(`ALTER TABLE studexo.users ENABLE TRIGGER trg_users_lifecycle`);
            }
          }
        }
      });

      return { userId, authId };
    }

    it('1. verifies studexo_purge_worker column-scoped SELECT permissions on studexo.users (last_purge_error allowed; PII/timestamps denied with 42501)', async () => {
      const { userId } = await seedAccountUser({
        status: 'pending_deletion',
        purgeState: 'purge_failed',
        lastPurgeError: 'permission-check-error',
      });

      const accountRepo = createPostgresAccountPurgeRepository(workerDb);
      const user = await accountRepo.getUserForPurge(userId);
      expect(user).not.toBeNull();
      expect(user?.id).toBe(userId);
      expect(user?.lastPurgeError).toBe('permission-check-error');

      const allowedRows = await workerSql`
        SELECT id, supabase_auth_user_id, status, deletion_requested_at, deletion_scheduled_for,
               purge_state, purge_lease_owner, purge_lease_until, purge_attempts, last_purge_error, purged_at
        FROM studexo.users
        WHERE id = ${userId}::uuid
      `;
      expect(allowedRows).toHaveLength(1);
      expect(allowedRows[0]?.last_purge_error).toBe('permission-check-error');

      const forbiddenColumns = [
        'primary_email',
        'display_name',
        'role',
        'created_at',
        'updated_at',
      ];
      for (const col of forbiddenColumns) {
        await expect(
          workerSql.unsafe(`SELECT ${col} FROM studexo.users WHERE id = $1::uuid`, [userId]),
        ).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('2. acquires lease for eligible pending_deletion users (pending_purge & purge_failed) using PostgreSQL time and rejects ineligible/active-lease/missing users', async () => {
      const accountRepo = createPostgresAccountPurgeRepository(workerDb);

      // Missing user
      expect(await accountRepo.getUserForPurge(crypto.randomUUID())).toBeNull();
      expect(
        await accountRepo.markUserPurging({
          userId: crypto.randomUUID(),
          leaseOwner: 'worker-1',
          leaseSeconds: 60,
        }),
      ).toBeNull();

      // Active user -> rejected
      const activeUser = await seedAccountUser({ status: 'active', purgeState: 'none' });
      expect(
        await accountRepo.markUserPurging({
          userId: activeUser.userId,
          leaseOwner: 'worker-1',
          leaseSeconds: 60,
        }),
      ).toBeNull();

      // Suspended user -> rejected
      const suspendedUser = await seedAccountUser({ status: 'suspended', purgeState: 'none' });
      expect(
        await accountRepo.markUserPurging({
          userId: suspendedUser.userId,
          leaseOwner: 'worker-1',
          leaseSeconds: 60,
        }),
      ).toBeNull();

      // Future deletion_scheduled_for -> rejected
      const futureGraceUser = await seedAccountUser({
        status: 'pending_deletion',
        purgeState: 'pending_purge',
        graceWindowExpired: false,
      });
      expect(
        await accountRepo.markUserPurging({
          userId: futureGraceUser.userId,
          leaseOwner: 'worker-1',
          leaseSeconds: 60,
        }),
      ).toBeNull();

      // Eligible pending_purge user -> acquired with PostgreSQL-derived purge_lease_until
      const eligibleUser = await seedAccountUser({
        status: 'pending_deletion',
        purgeState: 'pending_purge',
      });
      const dbNowRows = await adminSql<Array<{ db_now: Date }>>`
        SELECT pg_catalog.now() AS db_now
      `;
      const dbNowBefore = dbNowRows[0]!.db_now;
      const claimed = await accountRepo.markUserPurging({
        userId: eligibleUser.userId,
        leaseOwner: 'worker-1',
        leaseSeconds: 90,
      });
      expect(claimed).not.toBeNull();
      expect(claimed?.purgeState).toBe('purging');
      expect(claimed?.purgeLeaseOwner).toBe('worker-1');
      expect(claimed?.purgeAttempts).toBe(1);
      expect(claimed?.purgeLeaseUntil).not.toBeNull();
      const deltaSeconds =
        ((claimed!.purgeLeaseUntil as Date).getTime() - new Date(dbNowBefore).getTime()) / 1000;
      expect(deltaSeconds).toBeGreaterThanOrEqual(88);
      expect(deltaSeconds).toBeLessThanOrEqual(95);

      // Active lease held -> rejected both for another worker AND for the same leaseOwner
      expect(
        await accountRepo.markUserPurging({
          userId: eligibleUser.userId,
          leaseOwner: 'worker-2',
          leaseSeconds: 60,
        }),
      ).toBeNull();
      expect(
        await accountRepo.markUserPurging({
          userId: eligibleUser.userId,
          leaseOwner: 'worker-1',
          leaseSeconds: 60,
        }),
      ).toBeNull();

      // Expired purging lease -> taken over cleanly and increments purge_attempts
      const expiredLeaseUser = await seedAccountUser({
        status: 'pending_deletion',
        purgeState: 'purging',
        leaseOwner: 'worker-old',
        leaseOffsetSeconds: -30,
        purgeAttempts: 2,
      });
      const takenOver = await accountRepo.markUserPurging({
        userId: expiredLeaseUser.userId,
        leaseOwner: 'worker-new',
        leaseSeconds: 60,
      });
      expect(takenOver).not.toBeNull();
      expect(takenOver?.purgeState).toBe('purging');
      expect(takenOver?.purgeLeaseOwner).toBe('worker-new');
      expect(takenOver?.purgeAttempts).toBe(3);
    });

    it('3. serializes concurrent markUserPurging calls under real PostgreSQL row locking so exactly one worker acquires the lease', async () => {
      const { userId } = await seedAccountUser({
        status: 'pending_deletion',
        purgeState: 'pending_purge',
      });

      const workerUrl = new URL(TEST_POSTGRES_URL!);
      workerUrl.username = 'studexo_purge_worker';
      workerUrl.password = testRoleAdminPassword;

      const sqlA = postgres(workerUrl.toString(), { prepare: false, max: 1 });
      const sqlB = postgres(workerUrl.toString(), { prepare: false, max: 1 });

      try {
        const dbA = drizzle(sqlA, { schema });
        const dbB = drizzle(sqlB, { schema });

        const rowLockedBarrier = createDeferredBarrier();
        const releaseTxABarrier = createDeferredBarrier();
        let txAPid = 0;

        const instrumentedDbA = createLockBarrierDatabase(dbA, {
          onTransactionStart: async (tx) => {
            const rows = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
            txAPid = Number((rows as unknown as Array<{ pid: number }>)[0]?.pid ?? 0);
          },
          onRowLocked: () => rowLockedBarrier.resolve(),
          holdAfterRowLocked: releaseTxABarrier.promise,
        });

        const repoA = createPostgresAccountPurgeRepository(instrumentedDbA);
        const repoB = createPostgresAccountPurgeRepository(dbB);

        const promiseA = repoA.markUserPurging({
          userId,
          leaseOwner: 'worker-concurrent-a',
          leaseSeconds: 60,
        });

        await rowLockedBarrier.promise;
        expect(txAPid).toBeGreaterThan(0);

        const promiseB = repoB.markUserPurging({
          userId,
          leaseOwner: 'worker-concurrent-b',
          leaseSeconds: 60,
        });

        // Observe real PostgreSQL row-lock contention on studexo.users
        const lockWait = await waitForPostgresLockWait(adminSql, txAPid);
        expect(lockWait.waitEventType).toBe('Lock');

        releaseTxABarrier.resolve();

        const [resA, resB] = await Promise.all([promiseA, promiseB]);
        expect(resA).not.toBeNull();
        expect(resA?.purgeLeaseOwner).toBe('worker-concurrent-a');
        expect(resA?.purgeAttempts).toBe(1);
        expect(resB).toBeNull();
      } finally {
        await sqlA.end();
        await sqlB.end();
      }
    });

    it('4. enforces stale-worker fencing on markUserPurgeFailed for both different worker identities and reused worker identities', async () => {
      const accountRepo = createPostgresAccountPurgeRepository(workerDb);

      // Scenario A: Worker A (attempt 1) expires; Worker B acquires attempt 2; stale Worker A fails -> must NOT clobber Worker B
      const { userId: userDiff } = await seedAccountUser({
        status: 'pending_deletion',
        purgeState: 'purging',
        leaseOwner: 'worker-a',
        leaseOffsetSeconds: -20,
        purgeAttempts: 1,
      });

      const workerBClaim = await accountRepo.markUserPurging({
        userId: userDiff,
        leaseOwner: 'worker-b',
        leaseSeconds: 90,
      });
      expect(workerBClaim?.purgeAttempts).toBe(2);
      expect(workerBClaim?.purgeLeaseOwner).toBe('worker-b');

      const staleDiffResult = await accountRepo.markUserPurgeFailed(
        userDiff,
        'stale worker-a failure',
        {
          expectedLeaseOwner: 'worker-a',
          expectedPurgeAttempts: 1,
        },
      );
      expect(staleDiffResult).toMatchObject({
        status: 'stale_lease',
        user: {
          id: userDiff,
          purgeState: 'purging',
          purgeLeaseOwner: 'worker-b',
          purgeAttempts: 2,
        },
      });

      const afterStaleDiff = await accountRepo.getUserForPurge(userDiff);
      expect(afterStaleDiff?.purgeState).toBe('purging');
      expect(afterStaleDiff?.purgeLeaseOwner).toBe('worker-b');
      expect(afterStaleDiff?.purgeAttempts).toBe(2);
      expect(afterStaleDiff?.lastPurgeError).toBeNull();

      // Scenario B: Same worker identity ('worker-same') is reused across attempt 1 and attempt 2
      const { userId: userSame } = await seedAccountUser({
        status: 'pending_deletion',
        purgeState: 'purging',
        leaseOwner: 'worker-same',
        leaseOffsetSeconds: -20,
        purgeAttempts: 1,
      });

      const secondAttemptClaim = await accountRepo.markUserPurging({
        userId: userSame,
        leaseOwner: 'worker-same',
        leaseSeconds: 90,
      });
      expect(secondAttemptClaim?.purgeAttempts).toBe(2);
      expect(secondAttemptClaim?.purgeLeaseOwner).toBe('worker-same');

      // Stale attempt 1 from 'worker-same' tries to mark failed with expectedPurgeAttempts: 1
      const staleSameResult = await accountRepo.markUserPurgeFailed(
        userSame,
        'stale attempt 1 from worker-same',
        {
          expectedLeaseOwner: 'worker-same',
          expectedPurgeAttempts: 1,
        },
      );
      expect(staleSameResult).toMatchObject({
        status: 'stale_lease',
        user: {
          id: userSame,
          purgeState: 'purging',
          purgeLeaseOwner: 'worker-same',
          purgeAttempts: 2,
        },
      });

      const afterStaleSame = await accountRepo.getUserForPurge(userSame);
      expect(afterStaleSame?.purgeState).toBe('purging');
      expect(afterStaleSame?.purgeLeaseOwner).toBe('worker-same');
      expect(afterStaleSame?.purgeAttempts).toBe(2);
      expect(afterStaleSame?.lastPurgeError).toBeNull();

      // Current attempt 2 from 'worker-same' marks failed -> succeeds and clears lease
      const validFailResult = await accountRepo.markUserPurgeFailed(
        userSame,
        'valid attempt 2 failure',
        {
          expectedLeaseOwner: 'worker-same',
          expectedPurgeAttempts: 2,
        },
      );
      expect(validFailResult).toMatchObject({
        status: 'recorded',
        user: {
          id: userSame,
          purgeState: 'purge_failed',
          purgeLeaseOwner: null,
          purgeLeaseUntil: null,
          purgeAttempts: 2,
          lastPurgeError: 'valid attempt 2 failure',
        },
      });

      // Subsequent retry via markUserPurging succeeds and increments purge_attempts to 3
      const retryClaim = await accountRepo.markUserPurging({
        userId: userSame,
        leaseOwner: 'worker-same',
        leaseSeconds: 60,
      });
      expect(retryClaim?.purgeState).toBe('purging');
      expect(retryClaim?.purgeAttempts).toBe(3);
    });

    it('5. recovers expired account purge leases atomically under concurrent recovery attempts without overwriting active leases', async () => {
      const accountRepo = createPostgresAccountPurgeRepository(workerDb);
      const recoveryRepo = createPostgresAccountPurgeLeaseRecoveryRepository(workerDb);

      const { userId } = await seedAccountUser({
        status: 'pending_deletion',
        purgeState: 'purging',
        leaseOwner: 'worker-crashed',
        leaseOffsetSeconds: -25,
        purgeAttempts: 4,
        lastPurgeError: 'prior network error',
      });

      // Concurrent recovery attempts: exactly one returns the recovered row, the other returns null
      const [rec1, rec2] = await Promise.all([
        recoveryRepo.markExpiredAccountPurgeLeaseFailed({
          userId,
          errorMessage: 'Recovered expired lease',
        }),
        recoveryRepo.markExpiredAccountPurgeLeaseFailed({
          userId,
          errorMessage: 'Recovered expired lease',
        }),
      ]);

      const successes = [rec1, rec2].filter((r) => r !== null);
      const nulls = [rec1, rec2].filter((r) => r === null);
      expect(successes).toHaveLength(1);
      expect(nulls).toHaveLength(1);
      expect(successes[0]?.purgeState).toBe('purge_failed');
      expect(successes[0]?.purgeAttempts).toBe(4);
      expect(successes[0]?.purgeLeaseOwner).toBeNull();
      expect(successes[0]?.purgeLeaseUntil).toBeNull();
      expect(successes[0]?.lastPurgeError).toContain('Recovered expired lease');
      expect(successes[0]?.lastPurgeError).toContain('prior network error');

      // New worker acquires a fresh lease -> recovery must refuse to overwrite the active lease
      const newClaim = await accountRepo.markUserPurging({
        userId,
        leaseOwner: 'worker-fresh',
        leaseSeconds: 90,
      });
      expect(newClaim?.purgeState).toBe('purging');
      expect(newClaim?.purgeAttempts).toBe(5);

      const refusedActive = await recoveryRepo.markExpiredAccountPurgeLeaseFailed({
        userId,
        errorMessage: 'Must not overwrite active lease',
      });
      expect(refusedActive).toBeNull();

      const stillActive = await accountRepo.getUserForPurge(userId);
      expect(stillActive?.purgeState).toBe('purging');
      expect(stillActive?.purgeLeaseOwner).toBe('worker-fresh');
      expect(stillActive?.purgeAttempts).toBe(5);

      // End-to-end recoverInterruptedAccountPurge service call against live PostgreSQL
      const { userId: interruptedUserId } = await seedAccountUser({
        status: 'pending_deletion',
        purgeState: 'purging',
        leaseOwner: 'worker-interrupted',
        leaseOffsetSeconds: -45,
        purgeAttempts: 2,
        lastPurgeError: 'timeout before crash',
      });
      const fileRecoveryRepo = createPostgresFilePurgeLeaseRecoveryRepository(workerDb);
      const serviceRecovered = await recoverInterruptedAccountPurge({
        userId: interruptedUserId,
        accountRepo,
        recoveryRepo,
        fileRecoveryRepo,
        storage: {
          verifyObjectAbsent: async () => true,
        },
      });
      expect(serviceRecovered.outcome).toBe('recovered_to_purge_failed');
      expect(serviceRecovered.user?.purgeState).toBe('purge_failed');
      expect(serviceRecovered.user?.purgeAttempts).toBe(2);
      expect(serviceRecovered.user?.purgeLeaseOwner).toBeNull();
      expect(serviceRecovered.user?.purgeLeaseUntil).toBeNull();
      expect(serviceRecovered.user?.lastPurgeError).toContain('timeout before crash');
    });

    it('6. executes end-to-end Storage-first account purge (including referenced files), writes the external identity outbox row, and supports read-only outbox lookup', async () => {
      const { userId, authId } = await seedAccountUser({
        status: 'pending_deletion',
        purgeState: 'pending_purge',
      });
      const file1Id = crypto.randomUUID();
      const file2Id = crypto.randomUUID();
      const docId = crypto.randomUUID();

      await adminSql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE studexo_migrator`);
        await tx.unsafe(
          `INSERT INTO studexo.stored_files (
             id, owner_user_id, storage_bucket, object_key, original_filename,
             mime_type, byte_size, upload_status, purge_state
           ) VALUES
             ($1::uuid, $3::uuid, 'studexo-documents', $4, 'cv.pdf', 'application/pdf', 2048, 'uploaded', 'none'),
             ($2::uuid, $3::uuid, 'studexo-documents', $5, 'transcript.pdf', 'application/pdf', 4096, 'uploaded', 'none')`,
          [file2Id, file1Id, userId, `${userId}/cv.pdf`, `${userId}/transcript.pdf`],
        );
        await tx.unsafe(
          `INSERT INTO studexo.documents (id, user_id, document_type, title)
           VALUES ($1::uuid, $2::uuid, 'cv', 'My CV')`,
          [docId, userId],
        );
        await tx.unsafe(
          `INSERT INTO studexo.document_versions (id, document_id, user_id, stored_file_id, version_number)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1)`,
          [crypto.randomUUID(), docId, userId, file1Id],
        );
      });

      const accountRepo = createPostgresAccountPurgeRepository(workerDb);
      const fileRepo = createPostgresFilePurgeWorkerRepository(workerDb);
      const recoveryRepo = createPostgresAccountPurgeLeaseRecoveryRepository(workerDb);

      // Verify listUserStoredFiles deterministic ordering by stored_files.id ASC
      const listedFiles = await accountRepo.listUserStoredFiles(userId);
      expect(listedFiles).toHaveLength(2);
      expect(listedFiles.map((f) => f.id)).toEqual([file1Id, file2Id].sort());

      const removedObjects: string[] = [];
      const result = await executeStorageFirstAccountPurge({
        userId,
        leaseOwner: 'worker-e2e',
        leaseSeconds: 90,
        accountRepo,
        fileRepo,
        storage: {
          removeObject: async (bucket, key) => {
            removedObjects.push(`${bucket}/${key}`);
          },
          verifyObjectAbsent: async () => true,
        },
      });

      expect(result.databasePurgeExecuted).toBe(true);
      expect(result.purgedFileIds.sort()).toEqual([file1Id, file2Id].sort());
      expect(removedObjects).toHaveLength(2);

      // User and stored_files are now deleted from PostgreSQL
      expect(await accountRepo.getUserForPurge(userId)).toBeNull();
      expect(await accountRepo.listUserStoredFiles(userId)).toEqual([]);

      // Outbox row was created by studexo.execute_account_purge and is readable via findExternalIdentityOutboxByAuthUserId
      const outboxItem = await recoveryRepo.findExternalIdentityOutboxByAuthUserId(authId);
      expect(outboxItem).not.toBeNull();
      expect(outboxItem?.formerUserId).toBe(userId);
      expect(outboxItem?.supabaseAuthUserId).toBe(authId);
      expect(outboxItem?.status).toBe('pending_purge');
      expect(outboxItem?.attemptCount).toBe(0);

      // Verify recoverInterruptedAccountPurge handles a missing/already-purged user cleanly
      const fileRecoveryRepo = createPostgresFilePurgeLeaseRecoveryRepository(workerDb);
      const missingRecovery = await recoverInterruptedAccountPurge({
        userId,
        accountRepo,
        recoveryRepo,
        fileRecoveryRepo,
        storage: {
          verifyObjectAbsent: async () => true,
        },
      });
      expect(missingRecovery.outcome).toBe('user_already_purged');
    });
  },
);
