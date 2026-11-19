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
import { createPostgresAccountPurgeRepository } from '../src/server/modules/lifecycle/postgresAccountPurgeRepository';
import {
  buildUniqueOutboxLeaseToken,
  createPostgresExternalIdentityOutboxRecoveryRepository,
  createPostgresExternalIdentityOutboxRepository,
  EXTERNAL_IDENTITY_OUTBOX_COLUMNS,
  MAX_OUTBOX_ERROR_CODE_LENGTH,
  MAX_OUTBOX_LEASE_OWNER_LENGTH,
  truncateOutboxErrorCode,
} from '../src/server/modules/lifecycle/postgresExternalIdentityOutboxRepository';
import { createPostgresFilePurgeWorkerRepository } from '../src/server/modules/lifecycle/postgresFilePurgeRepository';
import {
  executeExternalIdentityOutboxPurge,
  executeStorageFirstAccountPurge,
  processExternalIdentityPurgeOutboxItem,
  recoverExpiredExternalIdentityOutboxLease,
  type ExternalIdentityOutboxRecord,
} from '../src/server/modules/lifecycle/storageAndPurge';

const STEP_7_GRANTED_OUTBOX_UPDATE_COLUMNS = new Set([
  'status',
  'attempt_count',
  'next_attempt_at',
  'lease_owner',
  'locked_until',
  'last_error_code',
  'last_error_message',
  'completed_at',
  'updated_at',
]);

interface MockOutboxRow extends ExternalIdentityOutboxRecord {
  updatedAt: Date;
}

interface CapturedOutboxQuery {
  op: 'select' | 'update';
  sql: string;
  params: unknown[];
}

function flattenSqlChunk(chunk: unknown, dialect: PgDialect): string {
  if (chunk === null || chunk === undefined) {
    return '';
  }
  if (typeof chunk === 'string' || typeof chunk === 'number' || typeof chunk === 'boolean') {
    return String(chunk);
  }
  if (typeof chunk === 'object') {
    if ('queryChunks' in (chunk as object)) {
      try {
        return dialect.sqlToQuery(chunk as SQL).sql;
      } catch {
        const subChunks = (chunk as { queryChunks: unknown[] }).queryChunks;
        return subChunks.map((c) => flattenSqlChunk(c, dialect)).join('');
      }
    }
    if ('name' in (chunk as object) && typeof (chunk as { name?: unknown }).name === 'string') {
      return (chunk as { name: string }).name;
    }
    if ('value' in (chunk as object)) {
      const val = (chunk as { value: unknown }).value;
      if (Array.isArray(val)) {
        return val.map((v) => flattenSqlChunk(v, dialect)).join('');
      }
      return String(val);
    }
  }
  return String(chunk);
}

function createMockOutboxRow(
  overrides: Partial<MockOutboxRow> = {},
): MockOutboxRow {
  const now = new Date('2026-11-17T10:00:00.000Z');
  return {
    id: overrides.id ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    formerUserId: overrides.formerUserId ?? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    supabaseAuthUserId:
      overrides.supabaseAuthUserId ?? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    status: overrides.status ?? 'pending_purge',
    attemptCount: overrides.attemptCount ?? 0,
    maxAttempts: overrides.maxAttempts ?? 10,
    nextAttemptAt: overrides.nextAttemptAt ?? new Date(now.getTime() - 1_000),
    leaseOwner: overrides.leaseOwner ?? null,
    lockedUntil: overrides.lockedUntil ?? null,
    lastErrorCode: overrides.lastErrorCode ?? null,
    lastErrorMessage: overrides.lastErrorMessage ?? null,
    completedAt: overrides.completedAt ?? null,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function createOfflineOutboxHarness(options: {
  initialItems?: MockOutboxRow[];
  now?: Date;
  failOnMarkPurgedError?: Error;
}) {
  const dialect = new PgDialect();
  let dbNow = options.now ?? new Date('2026-11-17T10:00:00.000Z');
  const items = new Map<string, MockOutboxRow>();
  for (const item of options.initialItems ?? []) {
    items.set(item.id, { ...item });
  }

  const queries: CapturedOutboxQuery[] = [];
  const isolations: string[] = [];
  let failOnMarkPurgedError = options.failOnMarkPurgedError;

  function buildTx() {
    return {
      select: (projection: Record<string, unknown>) => ({
        from: (_table: unknown) => ({
          where: (whereExpr: SQL) => {
            const compiledWhere = dialect.sqlToQuery(whereExpr);
            const selectedKeys = Object.keys(projection);

            const evaluateSelect = (limitCount: number) => {
              // Batch candidate selection only projects { id }
              if (selectedKeys.length === 1 && selectedKeys[0] === 'id') {
                const due = Array.from(items.values())
                  .filter((row) => {
                    if (row.status === 'purged') return false;
                    if (row.attemptCount >= row.maxAttempts) return false;
                    if (row.nextAttemptAt.getTime() > dbNow.getTime()) return false;
                    if (row.status === 'pending_purge' || row.status === 'purge_failed') {
                      return true;
                    }
                    if (row.status === 'purging') {
                      return (
                        row.lockedUntil === null ||
                        row.lockedUntil.getTime() <= dbNow.getTime()
                      );
                    }
                    return false;
                  })
                  .sort((a, b) => {
                    const diff = a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime();
                    return diff !== 0 ? diff : a.id.localeCompare(b.id);
                  })
                  .slice(0, limitCount);
                return due.map((r) => ({ id: r.id }));
              }

              const targetId = String(compiledWhere.params[0] ?? '');
              const row = items.get(targetId);
              if (!row) {
                return [];
              }

              const isLeaseActive =
                row.status === 'purging' &&
                row.lockedUntil !== null &&
                row.lockedUntil.getTime() > dbNow.getTime();
              const isLeaseExpired =
                row.status === 'purging' &&
                (row.lockedUntil === null || row.lockedUntil.getTime() <= dbNow.getTime());
              const isRetryDue = row.nextAttemptAt.getTime() <= dbNow.getTime();

              return [
                {
                  ...row,
                  ...('isLeaseActive' in projection ? { isLeaseActive } : {}),
                  ...('isLeaseExpired' in projection ? { isLeaseExpired } : {}),
                  ...('isRetryDue' in projection ? { isRetryDue } : {}),
                },
              ];
            };

            return {
              orderBy: (..._orders: unknown[]) => ({
                limit: (limitCount: number) => ({
                  for: async (mode: string, lockOpts?: { skipLocked?: boolean }) => {
                    queries.push({
                      op: 'select',
                      sql: `SELECT ${selectedKeys.join(',')} FROM external_identity_purge_outbox WHERE ${compiledWhere.sql} ORDER BY next_attempt_at, id LIMIT ${limitCount} FOR ${mode.toUpperCase()}${lockOpts?.skipLocked ? ' SKIP LOCKED' : ''}`,
                      params: compiledWhere.params,
                    });
                    return evaluateSelect(limitCount);
                  },
                }),
              }),
              limit: (limitCount: number) => ({
                for: async (mode: string) => {
                  queries.push({
                    op: 'select',
                    sql: `SELECT ${selectedKeys.join(',')} FROM external_identity_purge_outbox WHERE ${compiledWhere.sql} LIMIT ${limitCount} FOR ${mode.toUpperCase()}`,
                    params: compiledWhere.params,
                  });
                  return evaluateSelect(limitCount);
                },
                then: (
                  onfulfilled: (val: unknown[]) => unknown,
                  onrejected?: (err: unknown) => unknown,
                ) => {
                  queries.push({
                    op: 'select',
                    sql: `SELECT ${selectedKeys.join(',')} FROM external_identity_purge_outbox WHERE ${compiledWhere.sql} LIMIT ${limitCount}`,
                    params: compiledWhere.params,
                  });
                  return Promise.resolve(evaluateSelect(limitCount)).then(
                    onfulfilled,
                    onrejected,
                  );
                },
              }),
            };
          },
        }),
      }),
      update: (_table: unknown) => ({
        set: (patch: Record<string, unknown>) => ({
          where: (whereExpr: SQL) => ({
            returning: async (_returningCols: Record<string, unknown>) => {
              const compiledWhere = dialect.sqlToQuery(whereExpr);
              const setFragments: string[] = [];
              for (const [k, v] of Object.entries(patch)) {
                setFragments.push(`${k}=${flattenSqlChunk(v, dialect)}`);
              }
              queries.push({
                op: 'update',
                sql: `UPDATE external_identity_purge_outbox SET ${setFragments.join(', ')} WHERE ${compiledWhere.sql}`,
                params: compiledWhere.params,
              });

              if (patch.status === 'purged' && failOnMarkPurgedError) {
                const err = failOnMarkPurgedError;
                failOnMarkPurgedError = undefined;
                throw err;
              }

              const targetId = String(compiledWhere.params[0] ?? '');
              const existing = items.get(targetId);
              if (!existing) {
                return [];
              }

              const next = { ...existing };

              if (typeof patch.status === 'string') {
                next.status = patch.status as MockOutboxRow['status'];
              }
              if ('attemptCount' in patch) {
                const rawAttempt = flattenSqlChunk(patch.attemptCount, dialect);
                if (rawAttempt.includes('+ 1')) {
                  next.attemptCount = existing.attemptCount + 1;
                } else if (typeof patch.attemptCount === 'number') {
                  next.attemptCount = patch.attemptCount;
                }
              }
              if ('leaseOwner' in patch) {
                next.leaseOwner = (patch.leaseOwner as string | null) ?? null;
              }
              if ('lockedUntil' in patch) {
                if (patch.lockedUntil === null) {
                  next.lockedUntil = null;
                } else {
                  const q = dialect.sqlToQuery(patch.lockedUntil as SQL);
                  const secs = Number(q.params[0] ?? 60);
                  next.lockedUntil = new Date(dbNow.getTime() + secs * 1_000);
                }
              }
              if ('nextAttemptAt' in patch && patch.nextAttemptAt !== undefined) {
                const q = dialect.sqlToQuery(patch.nextAttemptAt as SQL);
                const secs = Number(q.params[0] ?? 60);
                next.nextAttemptAt = new Date(dbNow.getTime() + secs * 1_000);
              }
              if ('lastErrorCode' in patch) {
                next.lastErrorCode = (patch.lastErrorCode as string | null) ?? null;
              }
              if ('lastErrorMessage' in patch) {
                next.lastErrorMessage = (patch.lastErrorMessage as string | null) ?? null;
              }
              if ('completedAt' in patch) {
                next.completedAt = patch.completedAt === null ? null : new Date(dbNow.getTime());
              }
              next.updatedAt = new Date(dbNow.getTime());

              items.set(targetId, next);
              return [{ ...next }];
            },
          }),
        }),
      }),
    };
  }

  const db = {
    ...buildTx(),
    transaction: async <T>(
      fn: (tx: ReturnType<typeof buildTx>) => Promise<T>,
      config?: { isolationLevel?: string },
    ): Promise<T> => {
      isolations.push(config?.isolationLevel ?? 'default');
      return fn(buildTx());
    },
  };

  return {
    db: db as unknown as StudexoDatabase,
    queries,
    isolations,
    getItem: (id: string) => items.get(id) ?? null,
    setNow: (nextNow: Date) => {
      dbNow = nextNow;
    },
    setFailOnMarkPurgedError: (err?: Error) => {
      failOnMarkPurgedError = err;
    },
  };
}

describe('Phase 8B.4C.1 — Durable External Identity Outbox Repository & Orchestration (Offline Unit Suite)', () => {
  it('1. enforces explicit 12-column projections, Step 7 mutable update columns, input validation, and 64-char error code truncation', async () => {
    const projectedCols = Object.values(EXTERNAL_IDENTITY_OUTBOX_COLUMNS).map(
      (col) => col.name,
    );
    expect(projectedCols).toEqual([
      'id',
      'former_user_id',
      'supabase_auth_user_id',
      'status',
      'attempt_count',
      'max_attempts',
      'next_attempt_at',
      'lease_owner',
      'locked_until',
      'last_error_code',
      'last_error_message',
      'completed_at',
    ]);

    // Step 7 never grants UPDATE on id, former_user_id, supabase_auth_user_id, max_attempts, or created_at
    expect(STEP_7_GRANTED_OUTBOX_UPDATE_COLUMNS.has('id')).toBe(false);
    expect(STEP_7_GRANTED_OUTBOX_UPDATE_COLUMNS.has('former_user_id')).toBe(false);
    expect(STEP_7_GRANTED_OUTBOX_UPDATE_COLUMNS.has('supabase_auth_user_id')).toBe(false);
    expect(STEP_7_GRANTED_OUTBOX_UPDATE_COLUMNS.has('max_attempts')).toBe(false);
    expect(STEP_7_GRANTED_OUTBOX_UPDATE_COLUMNS.has('created_at')).toBe(false);

    // 64-character error code truncation
    const longCode = 'E_' + 'X'.repeat(90);
    const truncated = truncateOutboxErrorCode(longCode);
    expect(truncated).toHaveLength(MAX_OUTBOX_ERROR_CODE_LENGTH);
    expect(truncateOutboxErrorCode('   ')).toBeNull();
    expect(truncateOutboxErrorCode(null)).toBeNull();

    // Unique lease token fits varchar(120) and differs on every call even for same worker identity
    const longWorkerName = 'worker-' + 'a'.repeat(110);
    const token1 = buildUniqueOutboxLeaseToken(longWorkerName);
    const token2 = buildUniqueOutboxLeaseToken(longWorkerName);
    expect(token1.length).toBeLessThanOrEqual(MAX_OUTBOX_LEASE_OWNER_LENGTH);
    expect(token2.length).toBeLessThanOrEqual(MAX_OUTBOX_LEASE_OWNER_LENGTH);
    expect(token1).not.toBe(token2);

    const harness = createOfflineOutboxHarness({});
    const repo = createPostgresExternalIdentityOutboxRepository(harness.db);
    const recoveryRepo = createPostgresExternalIdentityOutboxRecoveryRepository(harness.db);

    await expect(
      repo.acquireOutboxLease({ outboxId: '', leaseOwner: 'w', leaseSeconds: 60 }),
    ).rejects.toThrow(/outboxId/);
    await expect(
      repo.acquireOutboxLease({ outboxId: 'id-1', leaseOwner: '  ', leaseSeconds: 60 }),
    ).rejects.toThrow(/leaseOwner/);
    await expect(
      repo.acquireOutboxLease({ outboxId: 'id-1', leaseOwner: 'w', leaseSeconds: 0 }),
    ).rejects.toThrow(/leaseSeconds/);
    await expect(
      repo.claimDueOutboxItems({ leaseOwner: 'w', leaseSeconds: 60, limit: 0 }),
    ).rejects.toThrow(/limit/);
    await expect(
      repo.listDueExhaustedOutboxItems({ limit: 0 }),
    ).rejects.toThrow(/limit/);
    await expect(
      repo.markOutboxPurgeFailed({
        outboxId: 'id-1',
        retryDelaySeconds: -5,
        errorMessage: 'err',
        fencing: { expectedLeaseOwner: 'tok', expectedAttemptCount: 1 },
      }),
    ).rejects.toThrow(/retryDelaySeconds/);
    await expect(
      recoveryRepo.markExpiredOutboxLeaseFailed({
        outboxId: 'id-1',
        expectedLeaseOwner: 'tok',
        expectedAttemptCount: 1,
        retryDelaySeconds: 0,
        errorMessage: 'expired',
      }),
    ).rejects.toThrow(/retryDelaySeconds/);
    await expect(
      recoveryRepo.markExpiredOutboxLeaseFailed({
        outboxId: 'id-1',
        expectedLeaseOwner: 'tok',
        expectedAttemptCount: -1,
        retryDelaySeconds: 30,
        errorMessage: 'expired',
      }),
    ).rejects.toThrow(/expectedAttemptCount/);
  });

  it('2. evaluates claim eligibility (not_found, already_purged, active_lease, retry_not_due, max_attempts_exhausted) and issues unique tokens per claim', async () => {
    const now = new Date('2026-11-17T10:00:00.000Z');
    const dueItem = createMockOutboxRow({
      id: 'item-due',
      status: 'pending_purge',
      attemptCount: 0,
    });
    const purgedItem = createMockOutboxRow({
      id: 'item-purged',
      status: 'purged',
      attemptCount: 1,
      completedAt: new Date(now.getTime() - 5_000),
    });
    const activeLeaseItem = createMockOutboxRow({
      id: 'item-active',
      status: 'purging',
      attemptCount: 1,
      leaseOwner: 'worker-1:token',
      lockedUntil: new Date(now.getTime() + 30_000),
    });
    const notDueItem = createMockOutboxRow({
      id: 'item-not-due',
      status: 'purge_failed',
      attemptCount: 2,
      nextAttemptAt: new Date(now.getTime() + 120_000),
    });
    const exhaustedItem = createMockOutboxRow({
      id: 'item-exhausted',
      status: 'purge_failed',
      attemptCount: 10,
      maxAttempts: 10,
      nextAttemptAt: new Date(now.getTime() - 1_000),
    });

    const harness = createOfflineOutboxHarness({
      now,
      initialItems: [dueItem, purgedItem, activeLeaseItem, notDueItem, exhaustedItem],
    });
    const repo = createPostgresExternalIdentityOutboxRepository(harness.db);

    expect(
      await repo.acquireOutboxLease({
        outboxId: 'missing-id',
        leaseOwner: 'worker-a',
        leaseSeconds: 60,
      }),
    ).toEqual({
      status: 'unavailable',
      reason: 'not_found',
      item: null,
    });

    const purgedRes = await repo.acquireOutboxLease({
      outboxId: purgedItem.id,
      leaseOwner: 'worker-a',
      leaseSeconds: 60,
    });
    expect(purgedRes.status).toBe('unavailable');
    if (purgedRes.status === 'unavailable') {
      expect(purgedRes.reason).toBe('already_purged');
    }

    const activeRes = await repo.acquireOutboxLease({
      outboxId: activeLeaseItem.id,
      leaseOwner: 'worker-a',
      leaseSeconds: 60,
    });
    expect(activeRes.status).toBe('unavailable');
    if (activeRes.status === 'unavailable') {
      expect(activeRes.reason).toBe('active_lease');
    }

    const notDueRes = await repo.acquireOutboxLease({
      outboxId: notDueItem.id,
      leaseOwner: 'worker-a',
      leaseSeconds: 60,
    });
    expect(notDueRes.status).toBe('unavailable');
    if (notDueRes.status === 'unavailable') {
      expect(notDueRes.reason).toBe('retry_not_due');
    }

    // Normal claim on exhausted row is rejected with max_attempts_exhausted
    const exhaustedNormalRes = await repo.acquireOutboxLease({
      outboxId: exhaustedItem.id,
      leaseOwner: 'worker-a',
      leaseSeconds: 60,
    });
    expect(exhaustedNormalRes.status).toBe('unavailable');
    if (exhaustedNormalRes.status === 'unavailable') {
      expect(exhaustedNormalRes.reason).toBe('max_attempts_exhausted');
    }

    // Normal claim on due row increments attemptCount 0 -> 1 and assigns unique token
    const firstClaim = await repo.acquireOutboxLease({
      outboxId: dueItem.id,
      leaseOwner: 'worker-a',
      leaseSeconds: 60,
    });
    expect(firstClaim.status).toBe('acquired');
    if (firstClaim.status !== 'acquired') throw new Error('expected acquired');
    expect(firstClaim.mode).toBe('normal');
    expect(firstClaim.item.attemptCount).toBe(1);
    expect(firstClaim.item.leaseOwner).toMatch(/^worker-a:[0-9a-f-]{36}$/);

    // Advance clock past lease expiry and let the SAME worker identity claim again -> receives a fresh unique token and increments attemptCount 1 -> 2
    harness.setNow(new Date(now.getTime() + 65_000));
    const secondClaim = await repo.acquireOutboxLease({
      outboxId: dueItem.id,
      leaseOwner: 'worker-a',
      leaseSeconds: 60,
    });
    expect(secondClaim.status).toBe('acquired');
    if (secondClaim.status !== 'acquired') throw new Error('expected acquired');
    expect(secondClaim.mode).toBe('normal');
    expect(secondClaim.item.attemptCount).toBe(2);
    expect(secondClaim.item.leaseOwner).toMatch(/^worker-a:[0-9a-f-]{36}$/);
    expect(secondClaim.item.leaseOwner).not.toBe(firstClaim.item.leaseOwner);
  });

  it('3. enforces active-lease and dual fencing (expectedLeaseOwner + expectedAttemptCount + locked_until > now()) on completion, failure, and expired-lease recovery', async () => {
    const now = new Date('2026-11-17T10:00:00.000Z');
    const item = createMockOutboxRow({ id: 'item-fence', attemptCount: 0 });
    const ownerlessPurging = createMockOutboxRow({
      id: 'item-ownerless-purging',
      status: 'purging',
      attemptCount: 2,
      leaseOwner: null,
      lockedUntil: null,
    });
    const harness = createOfflineOutboxHarness({
      now,
      initialItems: [item, ownerlessPurging],
    });
    const repo = createPostgresExternalIdentityOutboxRepository(harness.db);
    const recoveryRepo = createPostgresExternalIdentityOutboxRecoveryRepository(harness.db);

    const claim1 = await repo.acquireOutboxLease({
      outboxId: item.id,
      leaseOwner: 'worker-a',
      leaseSeconds: 30,
    });
    if (claim1.status !== 'acquired') throw new Error('expected acquired');
    const staleFencing = {
      expectedLeaseOwner: claim1.item.leaseOwner!,
      expectedAttemptCount: claim1.item.attemptCount,
    };

    // D1: Advance clock past lease expiry WITHOUT another worker reclaiming or recovering the row.
    // Both markOutboxPurged and markOutboxPurgeFailed must return stale_lease without mutating the record.
    const expiredTime = new Date(now.getTime() + 35_000);
    harness.setNow(expiredTime);

    const expiredUnclaimedPurge = await repo.markOutboxPurged({
      outboxId: item.id,
      fencing: staleFencing,
    });
    expect(expiredUnclaimedPurge.status).toBe('stale_lease');
    expect(harness.getItem(item.id)?.status).toBe('purging');
    expect(harness.getItem(item.id)?.leaseOwner).toBe(staleFencing.expectedLeaseOwner);
    expect(harness.getItem(item.id)?.completedAt).toBeNull();

    const expiredUnclaimedFail = await repo.markOutboxPurgeFailed({
      outboxId: item.id,
      retryDelaySeconds: 60,
      errorCode: 'EXPIRED_ERR',
      errorMessage: 'expired unclaimed worker failure',
      fencing: staleFencing,
    });
    expect(expiredUnclaimedFail.status).toBe('stale_lease');
    expect(harness.getItem(item.id)?.status).toBe('purging');
    expect(harness.getItem(item.id)?.lastErrorCode).toBeNull();
    expect(harness.getItem(item.id)?.lastErrorMessage).toBeNull();

    // Now same worker-a acquires attempt 2
    const claim2 = await repo.acquireOutboxLease({
      outboxId: item.id,
      leaseOwner: 'worker-a',
      leaseSeconds: 30,
    });
    if (claim2.status !== 'acquired') throw new Error('expected acquired');

    // D2: If recovery was initiated with staleFencing (token1, attempt 1) after claim2 took over
    // (even if claim2 also expires!), markExpiredOutboxLeaseFailed rejects the stale recovery and
    // does not overwrite or attach stale diagnostics to claim2.
    const futureExpiredTime = new Date(expiredTime.getTime() + 35_000);
    harness.setNow(futureExpiredTime);
    const staleRecovery = await recoveryRepo.markExpiredOutboxLeaseFailed({
      outboxId: item.id,
      expectedLeaseOwner: staleFencing.expectedLeaseOwner,
      expectedAttemptCount: staleFencing.expectedAttemptCount,
      retryDelaySeconds: 60,
      errorCode: 'STALE_RECOVERY_CODE',
      errorMessage: 'stale recovery diagnostics',
    });
    expect(staleRecovery.status).toBe('stale_lease');
    expect(harness.getItem(item.id)?.leaseOwner).toBe(claim2.item.leaseOwner);
    expect(harness.getItem(item.id)?.lastErrorCode).toBeNull();
    expect(harness.getItem(item.id)?.lastErrorMessage).toBeNull();

    // Rewind clock so claim2 is still within its 30s active lease window
    harness.setNow(new Date(expiredTime.getTime() + 10_000));

    // Stale attempt 1 fails fencing even if it tries to write failure or completion
    const staleFailWrite = await repo.markOutboxPurgeFailed({
      outboxId: item.id,
      retryDelaySeconds: 60,
      errorCode: 'STALE_ERR',
      errorMessage: 'stale worker failure',
      fencing: staleFencing,
    });
    expect(staleFailWrite.status).toBe('stale_lease');

    const stalePurgedWrite = await repo.markOutboxPurged({
      outboxId: item.id,
      fencing: staleFencing,
    });
    expect(stalePurgedWrite.status).toBe('stale_lease');

    // Even if expectedAttemptCount matches (2) but expectedLeaseOwner is wrong, fencing rejects
    const wrongTokenWrite = await repo.markOutboxPurged({
      outboxId: item.id,
      fencing: {
        expectedLeaseOwner: staleFencing.expectedLeaseOwner,
        expectedAttemptCount: claim2.item.attemptCount,
      },
    });
    expect(wrongTokenWrite.status).toBe('stale_lease');

    // Active worker 2 fencing succeeds and SQL includes locked_until > pg_catalog.now()
    const validWrite = await repo.markOutboxPurged({
      outboxId: item.id,
      fencing: {
        expectedLeaseOwner: claim2.item.leaseOwner!,
        expectedAttemptCount: claim2.item.attemptCount,
      },
    });
    expect(validWrite.status).toBe('updated');
    if (validWrite.status === 'updated') {
      expect(validWrite.item.status).toBe('purged');
      expect(validWrite.item.completedAt).toBeInstanceOf(Date);
      expect(validWrite.item.leaseOwner).toBeNull();
      expect(validWrite.item.lockedUntil).toBeNull();
    }
    const lastUpdateQuery = harness.queries
      .filter((q) => q.op === 'update')
      .at(-1);
    expect(lastUpdateQuery?.sql).toContain('"locked_until" IS NOT NULL');
    expect(lastUpdateQuery?.sql).toContain('"locked_until" > pg_catalog.now()');

    // D2: Ownerless purging record (lease_owner IS NULL) is recovered safely without fabricating a fencing token
    const ownerlessRecovered = await recoverExpiredExternalIdentityOutboxLease({
      outboxId: ownerlessPurging.id,
      retryDelaySeconds: 45,
      repo: {
        getOutboxItemById: repo.getOutboxItemById,
        markExpiredOutboxLeaseFailed: recoveryRepo.markExpiredOutboxLeaseFailed,
      },
    });
    expect(ownerlessRecovered.outcome).toBe('recovered_to_purge_failed');
    expect(ownerlessRecovered.item?.status).toBe('purge_failed');
    expect(ownerlessRecovered.item?.attemptCount).toBe(2);
    expect(ownerlessRecovered.item?.lastErrorMessage).toContain('owner=none');
  });

  it('4. supports exhausted-attempt recovery (attempt_count = max_attempts) and reconciliation claims without incrementing attempt_count', async () => {
    const now = new Date('2026-11-17T10:00:00.000Z');
    // Simulate attempt 10/10 where provider succeeded ('deleted'), DB completion threw a transient error, and the lease expired
    const item = createMockOutboxRow({
      id: 'item-reconcile',
      status: 'pending_purge',
      attemptCount: 9,
      maxAttempts: 10,
    });
    const harness = createOfflineOutboxHarness({
      now,
      initialItems: [item],
      failOnMarkPurgedError: new Error('Simulated DB connection drop during markOutboxPurged'),
    });
    const repo = createPostgresExternalIdentityOutboxRepository(harness.db);
    const recoveryRepo = createPostgresExternalIdentityOutboxRecoveryRepository(harness.db);

    let providerCalls = 0;
    const authAdmin = {
      deleteUserById: async () => {
        providerCalls += 1;
        return {
          status: providerCalls === 1 ? ('deleted' as const) : ('already_absent' as const),
        };
      },
    };

    // Attempt 10/10: provider succeeds ('deleted'), but markOutboxPurged fails -> error propagates, not falsely reported as purged
    await expect(
      executeExternalIdentityOutboxPurge({
        outboxId: item.id,
        leaseOwner: 'worker-a',
        leaseSeconds: 30,
        retryDelaySeconds: 45,
        repo,
        authAdmin,
      }),
    ).rejects.toThrow('Simulated DB connection drop during markOutboxPurged');

    const afterDroppedCommit = await repo.getOutboxItemById(item.id);
    expect(afterDroppedCommit?.status).toBe('purging');
    expect(afterDroppedCommit?.attemptCount).toBe(10);

    // Advance time past the 30s lease expiry
    const afterExpiry = new Date(now.getTime() + 35_000);
    harness.setNow(afterExpiry);

    // Recovery transitions purging -> purge_failed at attempt_count = 10 WITHOUT incrementing attempt_count and schedules next_attempt_at (+45s)
    const recovered = await recoverExpiredExternalIdentityOutboxLease({
      outboxId: item.id,
      now: afterExpiry,
      retryDelaySeconds: 45,
      repo: {
        getOutboxItemById: repo.getOutboxItemById,
        markExpiredOutboxLeaseFailed: recoveryRepo.markExpiredOutboxLeaseFailed,
      },
    });
    expect(recovered.outcome).toBe('recovered_to_purge_failed');
    expect(recovered.item?.status).toBe('purge_failed');
    expect(recovered.item?.attemptCount).toBe(10);
    expect(recovered.item?.leaseOwner).toBeNull();
    expect(recovered.item?.lockedUntil).toBeNull();
    expect(recovered.item?.lastErrorCode).toBe('LEASE_EXPIRED_RECONCILE_REQUIRED');

    // Before backoff elapses, even reconciliation claim is rejected with retry_not_due
    const prematureReconcile = await executeExternalIdentityOutboxPurge({
      outboxId: item.id,
      leaseOwner: 'worker-a',
      leaseSeconds: 30,
      retryDelaySeconds: 45,
      allowExhaustedReconciliation: true,
      repo,
      authAdmin,
    });
    expect(prematureReconcile).toMatchObject({
      outcome: 'unavailable',
      reason: 'retry_not_due',
    });

    // Advance time past the 45s retry backoff
    harness.setNow(new Date(afterExpiry.getTime() + 50_000));

    // Normal claim (allowExhaustedReconciliation: false) still refuses with max_attempts_exhausted
    const normalAtMax = await executeExternalIdentityOutboxPurge({
      outboxId: item.id,
      leaseOwner: 'worker-a',
      leaseSeconds: 30,
      retryDelaySeconds: 45,
      repo,
      authAdmin,
    });
    expect(normalAtMax).toMatchObject({
      outcome: 'unavailable',
      reason: 'max_attempts_exhausted',
    });

    // Explicit reconciliation claim succeeds, preserves attempt_count = 10, receives 'already_absent' from provider, and marks row 'purged'
    const reconciled = await executeExternalIdentityOutboxPurge({
      outboxId: item.id,
      leaseOwner: 'worker-a',
      leaseSeconds: 30,
      retryDelaySeconds: 45,
      allowExhaustedReconciliation: true,
      repo,
      authAdmin,
    });
    expect(reconciled.outcome).toBe('purged');
    if (reconciled.outcome === 'purged') {
      expect(reconciled.mode).toBe('reconciliation');
      expect(reconciled.providerStatus).toBe('already_absent');
      expect(reconciled.item.status).toBe('purged');
      expect(reconciled.item.attemptCount).toBe(10);
      expect(reconciled.item.completedAt).toBeInstanceOf(Date);
    }

    // Backward compatibility of existing helper
    const legacyHelperResult = await processExternalIdentityPurgeOutboxItem(
      {
        id: item.id,
        formerUserId: item.formerUserId,
        supabaseAuthUserId: item.supabaseAuthUserId,
        status: 'pending_purge',
        attemptCount: 0,
        maxAttempts: 10,
      },
      { deleteUserById: async () => ({ status: 'already_absent' }) },
    );
    expect(legacyHelperResult).toEqual({ status: 'purged' });
  });
});

interface DeferredBarrier {
  wait: () => Promise<void>;
  release: () => void;
}

function createDeferredBarrier(label: string, timeoutMs = 5_000): DeferredBarrier {
  let resolveFn!: () => void;
  let settled = false;
  const promise = new Promise<void>((resolve) => {
    resolveFn = () => {
      settled = true;
      resolve();
    };
  });

  return {
    wait: async () => {
      if (settled) {
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`Timed out after ${timeoutMs}ms waiting on barrier: ${label}`));
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    },
    release: () => {
      resolveFn();
    },
  };
}

function createForUpdateBarrierDatabase(
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

const TEST_POSTGRES_URL = process.env.TEST_POSTGRES_URL?.trim();

describe.skipIf(!TEST_POSTGRES_URL)(
  'Phase 8B.4C.1 — Live Disposable PostgreSQL 17 External Identity Outbox & Concurrency Acceptance',
  () => {
    let adminSql: Sql;
    let appSql: Sql;
    let workerSql: Sql;
    let workerDb: StudexoDatabase;
    let secondWorkerSql: Sql;
    let secondWorkerDb: StudexoDatabase;
    let testRolePassword: string;

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
            CREATE ROLE studexo_app LOGIN NOINHERIT PASSWORD '${testRolePassword}';
          ELSE
            ALTER ROLE studexo_app WITH LOGIN NOINHERIT PASSWORD '${testRolePassword}';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studexo_purge_worker') THEN
            CREATE ROLE studexo_purge_worker LOGIN NOINHERIT PASSWORD '${testRolePassword}';
          ELSE
            ALTER ROLE studexo_purge_worker WITH LOGIN NOINHERIT PASSWORD '${testRolePassword}';
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
        SELECT to_regclass('studexo.external_identity_purge_outbox') IS NOT NULL AS "alreadyMigrated"
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

      // Apply exact Step 5, Step 6 (studexo_app), and Step 7 (studexo_purge_worker) grants from docs/DATABASE_ROLES.md
      await adminSql.unsafe(`
        REVOKE CREATE ON SCHEMA studexo FROM PUBLIC, studexo_app, studexo_purge_worker, studexo_purge_owner, studexo_catalog_admin;

        REVOKE ALL ON FUNCTION studexo.execute_account_purge(uuid, varchar, integer) FROM PUBLIC, studexo_app;
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

        -- Step 6: exact studexo_app privileges
        GRANT USAGE ON SCHEMA studexo TO studexo_app;
        REVOKE ALL ON studexo.users FROM PUBLIC, studexo_app;
        GRANT SELECT ON studexo.users TO studexo_app;
        GRANT INSERT (
          id,
          supabase_auth_user_id,
          primary_email,
          display_name
        ) ON studexo.users TO studexo_app;
        GRANT UPDATE (
          primary_email,
          display_name,
          status,
          deletion_requested_at,
          deletion_scheduled_for,
          updated_at
        ) ON studexo.users TO studexo_app;

        REVOKE ALL ON studexo.stored_files FROM PUBLIC, studexo_app;
        GRANT SELECT, INSERT ON studexo.stored_files TO studexo_app;
        GRANT UPDATE (
          original_filename,
          mime_type,
          byte_size,
          sha256_checksum,
          upload_status,
          uploaded_at,
          updated_at
        ) ON studexo.stored_files TO studexo_app;
        GRANT EXECUTE ON FUNCTION studexo.request_stored_file_deletion(uuid, uuid) TO studexo_app;
        GRANT EXECUTE ON FUNCTION studexo.is_auth_user_pending_purge(uuid) TO studexo_app;
        REVOKE ALL ON FUNCTION studexo.revert_stored_file_deletion_request(uuid, uuid) FROM PUBLIC, studexo_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON
          studexo.auth_identities,
          studexo.account_settings,
          studexo.student_profiles,
          studexo.student_qualifications,
          studexo.student_test_scores,
          studexo.student_experiences,
          studexo.student_publications_and_projects,
          studexo.documents,
          studexo.document_versions,
          studexo.saved_opportunities,
          studexo.university_applications,
          studexo.scholarship_applications,
          studexo.application_documents,
          studexo.application_checklists,
          studexo.application_notes,
          studexo.planner_tasks,
          studexo.planner_events,
          studexo.notification_preferences,
          studexo.notification_deliveries,
          studexo.ai_conversations,
          studexo.ai_messages,
          studexo.ai_runs,
          studexo.ai_usage_records,
          studexo.ai_run_context_links
        TO studexo_app;
        REVOKE ALL ON studexo.external_identity_purge_outbox FROM PUBLIC, studexo_app;

        -- Step 7: exact studexo_purge_worker privileges
        GRANT USAGE ON SCHEMA studexo TO studexo_purge_worker;
        REVOKE ALL ON studexo.external_identity_purge_outbox FROM PUBLIC, studexo_purge_worker;
        GRANT SELECT (id, supabase_auth_user_id, status, deletion_requested_at, deletion_scheduled_for, purge_state, purge_lease_owner, purge_lease_until, purge_attempts, last_purge_error, purged_at) ON studexo.users TO studexo_purge_worker;
        GRANT UPDATE (purge_state, purge_lease_owner, purge_lease_until, purge_attempts, last_purge_error, purged_at, updated_at) ON studexo.users TO studexo_purge_worker;
        GRANT SELECT (id, owner_user_id, storage_bucket, object_key, upload_status, deleted_at, deleted_by_user_id, purge_state, purge_requested_at, purge_lease_until, purge_attempts, last_purge_error, purged_at) ON studexo.stored_files TO studexo_purge_worker;
        GRANT UPDATE (upload_status, deleted_at, purge_state, purge_requested_at, purge_lease_until, purge_attempts, last_purge_error, purged_at, updated_at) ON studexo.stored_files TO studexo_purge_worker;
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
      testRolePassword = crypto.randomBytes(16).toString('hex');
      adminSql = postgres(TEST_POSTGRES_URL!, { prepare: false, max: 5 });
      await setupSchemaAndRoles();

      const appUrl = new URL(TEST_POSTGRES_URL!);
      appUrl.username = 'studexo_app';
      appUrl.password = testRolePassword;
      appSql = postgres(appUrl.toString(), { prepare: false, max: 3 });

      const workerUrl = new URL(TEST_POSTGRES_URL!);
      workerUrl.username = 'studexo_purge_worker';
      workerUrl.password = testRolePassword;
      workerSql = postgres(workerUrl.toString(), { prepare: false, max: 5 });
      workerDb = drizzle(workerSql, { schema });

      secondWorkerSql = postgres(workerUrl.toString(), { prepare: false, max: 3 });
      secondWorkerDb = drizzle(secondWorkerSql, { schema });
    });

    afterAll(async () => {
      await secondWorkerSql?.end({ timeout: 5 });
      await workerSql?.end({ timeout: 5 });
      await appSql?.end({ timeout: 5 });
      await adminSql?.end({ timeout: 5 });
    });

    async function seedOutboxRow(options?: {
      status?: 'pending_purge' | 'purging' | 'purge_failed' | 'purged';
      attemptCount?: number;
      maxAttempts?: number;
      nextAttemptOffsetSql?: string;
      leaseOwner?: string | null;
      lockedUntilOffsetSql?: string | null;
      completedAtSql?: string | null;
      lastErrorCode?: string | null;
      lastErrorMessage?: string | null;
    }) {
      const id = crypto.randomUUID();
      const formerUserId = crypto.randomUUID();
      const supabaseAuthUserId = crypto.randomUUID();
      const status = options?.status ?? 'pending_purge';
      const attemptCount = options?.attemptCount ?? 0;
      const maxAttempts = options?.maxAttempts ?? 10;
      const nextAttemptExpr = options?.nextAttemptOffsetSql ?? `pg_catalog.now() - interval '1 second'`;
      const leaseOwner = options?.leaseOwner ?? null;
      const lockedUntilExpr =
        options?.lockedUntilOffsetSql !== undefined
          ? options.lockedUntilOffsetSql
          : status === 'purging'
            ? `pg_catalog.now() + interval '60 seconds'`
            : null;
      const completedAtExpr =
        options?.completedAtSql !== undefined
          ? options.completedAtSql
          : status === 'purged'
            ? `pg_catalog.now()`
            : null;

      await adminSql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE studexo_migrator`);
        await tx.unsafe(
          `INSERT INTO studexo.external_identity_purge_outbox (
            id, former_user_id, supabase_auth_user_id, status, attempt_count, max_attempts,
            next_attempt_at, lease_owner, locked_until, last_error_code, last_error_message, completed_at
          ) VALUES (
            '${id}'::uuid,
            '${formerUserId}'::uuid,
            '${supabaseAuthUserId}'::uuid,
            '${status}'::studexo.purge_state,
            ${attemptCount},
            ${maxAttempts},
            ${nextAttemptExpr},
            ${leaseOwner ? `'${leaseOwner.replace(/'/g, "''")}'` : 'NULL'},
            ${lockedUntilExpr ?? 'NULL'},
            ${options?.lastErrorCode ? `'${options.lastErrorCode.replace(/'/g, "''")}'` : 'NULL'},
            ${options?.lastErrorMessage ? `'${options.lastErrorMessage.replace(/'/g, "''")}'` : 'NULL'},
            ${completedAtExpr ?? 'NULL'}
          )`,
        );
      });

      return { id, formerUserId, supabaseAuthUserId };
    }

    it('1. enforces Step 6 and Step 7 least-privilege boundaries on external_identity_purge_outbox and completion/attempt CHECK constraints', async () => {
      const { id, formerUserId, supabaseAuthUserId } = await seedOutboxRow();

      // studexo_app is denied SELECT, INSERT, UPDATE, and DELETE on external_identity_purge_outbox (42501)
      await expect(
        appSql`SELECT id FROM studexo.external_identity_purge_outbox WHERE id = ${id}::uuid`,
      ).rejects.toMatchObject({ code: '42501' });

      await expect(
        appSql`
          INSERT INTO studexo.external_identity_purge_outbox (former_user_id, supabase_auth_user_id)
          VALUES (${formerUserId}::uuid, ${crypto.randomUUID()}::uuid)
        `,
      ).rejects.toMatchObject({ code: '42501' });

      await expect(
        appSql`
          UPDATE studexo.external_identity_purge_outbox
          SET status = 'purged', completed_at = pg_catalog.now()
          WHERE id = ${id}::uuid
        `,
      ).rejects.toMatchObject({ code: '42501' });

      await expect(
        appSql`DELETE FROM studexo.external_identity_purge_outbox WHERE id = ${id}::uuid`,
      ).rejects.toMatchObject({ code: '42501' });

      // studexo_purge_worker is denied INSERT, DELETE, and immutable-column UPDATE (42501)
      await expect(
        workerSql`
          INSERT INTO studexo.external_identity_purge_outbox (former_user_id, supabase_auth_user_id)
          VALUES (${formerUserId}::uuid, ${crypto.randomUUID()}::uuid)
        `,
      ).rejects.toMatchObject({ code: '42501' });

      await expect(
        workerSql`DELETE FROM studexo.external_identity_purge_outbox WHERE id = ${id}::uuid`,
      ).rejects.toMatchObject({ code: '42501' });

      await expect(
        workerSql`
          UPDATE studexo.external_identity_purge_outbox
          SET former_user_id = ${crypto.randomUUID()}::uuid
          WHERE id = ${id}::uuid
        `,
      ).rejects.toMatchObject({ code: '42501' });

      await expect(
        workerSql`
          UPDATE studexo.external_identity_purge_outbox
          SET supabase_auth_user_id = ${crypto.randomUUID()}::uuid
          WHERE id = ${id}::uuid
        `,
      ).rejects.toMatchObject({ code: '42501' });

      await expect(
        workerSql`
          UPDATE studexo.external_identity_purge_outbox
          SET max_attempts = 99
          WHERE id = ${id}::uuid
        `,
      ).rejects.toMatchObject({ code: '42501' });

      await expect(
        workerSql`
          UPDATE studexo.external_identity_purge_outbox
          SET created_at = pg_catalog.now()
          WHERE id = ${id}::uuid
        `,
      ).rejects.toMatchObject({ code: '42501' });

      // Verify CHECK constraint external_identity_purge_outbox_completed_at_chk (23514)
      await expect(
        workerSql`
          UPDATE studexo.external_identity_purge_outbox
          SET status = 'purged', completed_at = NULL
          WHERE id = ${id}::uuid
        `,
      ).rejects.toMatchObject({ code: '23514' });

      await expect(
        workerSql`
          UPDATE studexo.external_identity_purge_outbox
          SET status = 'pending_purge', completed_at = pg_catalog.now()
          WHERE id = ${id}::uuid
        `,
      ).rejects.toMatchObject({ code: '23514' });

      // Confirm row remains intact
      const repo = createPostgresExternalIdentityOutboxRepository(workerDb);
      const unchanged = await repo.getOutboxItemById(id);
      expect(unchanged?.supabaseAuthUserId).toBe(supabaseAuthUserId);
      expect(unchanged?.status).toBe('pending_purge');
      expect(unchanged?.completedAt).toBeNull();
    });

    it('2. serializes concurrent acquireOutboxLease calls on FOR UPDATE (verified via pg_stat_activity & pg_blocking_pids) and supports FOR UPDATE SKIP LOCKED batch claiming', async () => {
      // Clear any earlier pending rows by marking them purged so batch test is deterministic
      await adminSql.unsafe(`
        UPDATE studexo.external_identity_purge_outbox
        SET status = 'purged', completed_at = COALESCE(completed_at, pg_catalog.now())
        WHERE status <> 'purged'
      `);

      const { id: raceId } = await seedOutboxRow();
      const { id: batchId1 } = await seedOutboxRow({
        nextAttemptOffsetSql: `pg_catalog.now() - interval '10 seconds'`,
      });
      const { id: batchId2 } = await seedOutboxRow({
        nextAttemptOffsetSql: `pg_catalog.now() - interval '5 seconds'`,
      });

      const txALockAcquired = createDeferredBarrier(
        'Outbox concurrency: Worker A acquired FOR UPDATE lock',
      );
      const releaseTxACommit = createDeferredBarrier(
        'Outbox concurrency: release Worker A to commit',
      );
      let txAPid = 0;

      const barrierWorkerDb = createForUpdateBarrierDatabase(workerDb, async ({ tx }) => {
        const pidRows = await tx.execute<{ pid: number }>(
          sql`SELECT pg_catalog.pg_backend_pid()::int AS pid`,
        );
        txAPid = Number(pidRows[0]?.pid ?? 0);
        txALockAcquired.release();
        await releaseTxACommit.wait();
      });

      const barrierRepoA = createPostgresExternalIdentityOutboxRepository(barrierWorkerDb);
      const repoB = createPostgresExternalIdentityOutboxRepository(secondWorkerDb);

      let txASettled = false;
      const txAPromise = barrierRepoA
        .acquireOutboxLease({
          outboxId: raceId,
          leaseOwner: 'worker-a',
          leaseSeconds: 60,
        })
        .finally(() => {
          txASettled = true;
        });

      let txBSettled = false;
      let txBPromise: ReturnType<typeof repoB.acquireOutboxLease> | undefined;

      try {
        await txALockAcquired.wait();
        expect(txASettled).toBe(false);
        expect(txAPid).toBeGreaterThan(0);

        // While Worker A holds the FOR UPDATE lock on raceId, Worker B's batch claimDueOutboxItems
        // with FOR UPDATE SKIP LOCKED skips raceId and claims batchId1 and batchId2 with distinct tokens!
        const batchClaimed = await repoB.claimDueOutboxItems({
          leaseOwner: 'batch-worker',
          leaseSeconds: 60,
          limit: 10,
        });
        expect(batchClaimed.map((i) => i.id)).toEqual([batchId1, batchId2]);
        expect(batchClaimed[0]?.leaseOwner).toMatch(/^batch-worker:[0-9a-f-]{36}$/);
        expect(batchClaimed[1]?.leaseOwner).toMatch(/^batch-worker:[0-9a-f-]{36}$/);
        expect(batchClaimed[0]?.leaseOwner).not.toBe(batchClaimed[1]?.leaseOwner);

        // Now Worker B attempts targeted acquireOutboxLease on raceId and blocks on Worker A's FOR UPDATE lock
        txBPromise = repoB
          .acquireOutboxLease({
            outboxId: raceId,
            leaseOwner: 'worker-b',
            leaseSeconds: 60,
          })
          .finally(() => {
            txBSettled = true;
          });

        const observedWait = await waitForPostgresLockWait(adminSql, {
          blockedQueryPattern: 'external_identity_purge_outbox',
          blockerPid: txAPid,
        });
        expect(observedWait.waitEventType).toBe('Lock');
        expect(observedWait.blockingPids).toContain(txAPid);
        expect(txBSettled).toBe(false);
        expect(txASettled).toBe(false);
      } finally {
        releaseTxACommit.release();
      }

      const [resA, resB] = await Promise.all([txAPromise, txBPromise!]);
      expect(resA.status).toBe('acquired');
      expect(resB.status).toBe('unavailable');
      if (resA.status === 'acquired' && resB.status === 'unavailable') {
        expect(resA.mode).toBe('normal');
        expect(resA.item.attemptCount).toBe(1);
        expect(resA.item.leaseOwner).toMatch(/^worker-a:[0-9a-f-]{36}$/);
        expect(resB.reason).toBe('active_lease');
        expect(resB.item?.leaseOwner).toBe(resA.item.leaseOwner);
      }
    });

    it('3. enforces active-lease expiry fencing on unclaimed expired leases (Test A), same/different-worker stale-token fencing, and fenced expired-lease recovery (D2)', async () => {
      const { id } = await seedOutboxRow();
      const repo = createPostgresExternalIdentityOutboxRepository(workerDb);
      const recoveryRepo = createPostgresExternalIdentityOutboxRecoveryRepository(workerDb);

      // Claim 1 by worker-alpha
      const claim1 = await repo.acquireOutboxLease({
        outboxId: id,
        leaseOwner: 'worker-alpha',
        leaseSeconds: 60,
      });
      if (claim1.status !== 'acquired') throw new Error('expected acquired');
      const token1 = claim1.item.leaseOwner!;
      expect(claim1.item.attemptCount).toBe(1);

      // Expire Claim 1 in DB WITHOUT another worker claiming or recovering it (Test A)
      await workerSql`
        UPDATE studexo.external_identity_purge_outbox
        SET locked_until = pg_catalog.now() - interval '5 seconds'
        WHERE id = ${id}::uuid
      `;

      // Test A Step 4-5: Attempt markOutboxPurged using original token1 and attemptCount = 1 on expired unclaimed lease
      const expiredUnclaimedPurged = await repo.markOutboxPurged({
        outboxId: id,
        fencing: { expectedLeaseOwner: token1, expectedAttemptCount: 1 },
      });
      expect(expiredUnclaimedPurged.status).toBe('stale_lease');

      const afterUnclaimedPurgeAttempt = await repo.getOutboxItemById(id);
      expect(afterUnclaimedPurgeAttempt?.status).toBe('purging');
      expect(afterUnclaimedPurgeAttempt?.leaseOwner).toBe(token1);
      expect(afterUnclaimedPurgeAttempt?.attemptCount).toBe(1);
      expect(afterUnclaimedPurgeAttempt?.completedAt).toBeNull();

      // Test A Step 6-7: Repeat using markOutboxPurgeFailed on expired unclaimed lease
      const expiredUnclaimedFailed = await repo.markOutboxPurgeFailed({
        outboxId: id,
        retryDelaySeconds: 30,
        errorCode: 'EXPIRED_UNCLAIMED',
        errorMessage: 'expired unclaimed failure attempt',
        fencing: { expectedLeaseOwner: token1, expectedAttemptCount: 1 },
      });
      expect(expiredUnclaimedFailed.status).toBe('stale_lease');

      const afterUnclaimedFailAttempt = await repo.getOutboxItemById(id);
      expect(afterUnclaimedFailAttempt?.status).toBe('purging');
      expect(afterUnclaimedFailAttempt?.leaseOwner).toBe(token1);
      expect(afterUnclaimedFailAttempt?.attemptCount).toBe(1);
      expect(afterUnclaimedFailAttempt?.lastErrorCode).toBeNull();
      expect(afterUnclaimedFailAttempt?.lastErrorMessage).toBeNull();

      // Claim 2 by the SAME logical worker identity ('worker-alpha') -> gets fresh unique token2 and attemptCount = 2
      const claim2 = await repo.acquireOutboxLease({
        outboxId: id,
        leaseOwner: 'worker-alpha',
        leaseSeconds: 60,
      });
      if (claim2.status !== 'acquired') throw new Error('expected acquired');
      const token2 = claim2.item.leaseOwner!;
      expect(token2).not.toBe(token1);
      expect(claim2.item.attemptCount).toBe(2);

      // D2 recovery race check: simulate recoverExpiredExternalIdentityOutboxLease having inspected
      // Claim 1 (token1, attempt 1) right before Claim 2 (token2, attempt 2) was acquired (and even if Claim 2 also expires!).
      await workerSql`
        UPDATE studexo.external_identity_purge_outbox
        SET locked_until = pg_catalog.now() - interval '5 seconds'
        WHERE id = ${id}::uuid
      `;

      let preliminaryReadCount = 0;
      const racedRecoveryResult = await recoverExpiredExternalIdentityOutboxLease({
        outboxId: id,
        retryDelaySeconds: 30,
        repo: {
          getOutboxItemById: async (targetId) => {
            preliminaryReadCount += 1;
            if (preliminaryReadCount === 1) {
              // Preliminary read returns the snapshot from Claim 1 before Claim 2 replaced it
              return afterUnclaimedFailAttempt;
            }
            return repo.getOutboxItemById(targetId);
          },
          markExpiredOutboxLeaseFailed: recoveryRepo.markExpiredOutboxLeaseFailed,
        },
      });
      expect(racedRecoveryResult.outcome).toBe('stale_lease');
      expect(racedRecoveryResult.item?.leaseOwner).toBe(token2);
      expect(racedRecoveryResult.item?.attemptCount).toBe(2);
      expect(racedRecoveryResult.item?.status).toBe('purging');
      expect(racedRecoveryResult.item?.lastErrorCode).toBeNull();
      expect(racedRecoveryResult.item?.lastErrorMessage).toBeNull();

      // Restore Claim 2's active lease window so we can test active-lease fencing against stale Claim 1
      await workerSql`
        UPDATE studexo.external_identity_purge_outbox
        SET locked_until = pg_catalog.now() + interval '60 seconds'
        WHERE id = ${id}::uuid
      `;

      // Stale Claim 1 (token1, attempt 1) and mismatched (token1, attempt 2) are both rejected
      const staleFail1 = await repo.markOutboxPurgeFailed({
        outboxId: id,
        retryDelaySeconds: 30,
        errorCode: 'STALE',
        errorMessage: 'stale worker-alpha attempt 1',
        fencing: { expectedLeaseOwner: token1, expectedAttemptCount: 1 },
      });
      expect(staleFail1.status).toBe('stale_lease');

      const stalePurge1 = await repo.markOutboxPurged({
        outboxId: id,
        fencing: { expectedLeaseOwner: token1, expectedAttemptCount: 2 },
      });
      expect(stalePurge1.status).toBe('stale_lease');

      // Expire Claim 2 and let a DIFFERENT worker ('worker-beta') acquire Claim 3 (attempt 3)
      await workerSql`
        UPDATE studexo.external_identity_purge_outbox
        SET locked_until = pg_catalog.now() - interval '5 seconds'
        WHERE id = ${id}::uuid
      `;
      const claim3 = await repo.acquireOutboxLease({
        outboxId: id,
        leaseOwner: 'worker-beta',
        leaseSeconds: 60,
      });
      if (claim3.status !== 'acquired') throw new Error('expected acquired');
      expect(claim3.item.attemptCount).toBe(3);

      // Stale Claim 2 (token2, attempt 2) is rejected
      const stalePurge2 = await repo.markOutboxPurged({
        outboxId: id,
        fencing: { expectedLeaseOwner: token2, expectedAttemptCount: 2 },
      });
      expect(stalePurge2.status).toBe('stale_lease');

      // Active Claim 3 (worker-beta) succeeds and marks row purged
      const completed = await repo.markOutboxPurged({
        outboxId: id,
        fencing: {
          expectedLeaseOwner: claim3.item.leaseOwner!,
          expectedAttemptCount: claim3.item.attemptCount,
        },
      });
      expect(completed.status).toBe('updated');
      if (completed.status === 'updated') {
        expect(completed.item.status).toBe('purged');
        expect(completed.item.completedAt).toBeInstanceOf(Date);
      }

      // D2: Verify an anomalous purging row with lease_owner = NULL and locked_until = NULL is recovered safely without fabricating a token
      const { id: ownerlessId } = await seedOutboxRow({
        status: 'purging',
        attemptCount: 1,
        leaseOwner: null,
        lockedUntilOffsetSql: 'NULL',
      });
      const ownerlessRecovery = await recoverExpiredExternalIdentityOutboxLease({
        outboxId: ownerlessId,
        retryDelaySeconds: 30,
        repo: {
          getOutboxItemById: repo.getOutboxItemById,
          markExpiredOutboxLeaseFailed: recoveryRepo.markExpiredOutboxLeaseFailed,
        },
      });
      expect(ownerlessRecovery.outcome).toBe('recovered_to_purge_failed');
      expect(ownerlessRecovery.item?.status).toBe('purge_failed');
      expect(ownerlessRecovery.item?.attemptCount).toBe(1);
      expect(ownerlessRecovery.item?.lastErrorMessage).toContain('owner=none');
    });

    it('4. enforces retry backoff, max_attempts exhaustion, expired final-attempt recovery, stale reconciliation token rejection (Test B), concurrent reconciliation lock-wait serialization (Test C), and recovery after DB completion failure', async () => {
      // Seed row at attempt 9 of 10
      const { id } = await seedOutboxRow({
        status: 'purge_failed',
        attemptCount: 9,
        maxAttempts: 10,
        nextAttemptOffsetSql: `pg_catalog.now() - interval '1 second'`,
      });
      const repo = createPostgresExternalIdentityOutboxRepository(workerDb);
      const recoveryRepo = createPostgresExternalIdentityOutboxRecoveryRepository(workerDb);

      // Attempt 10 (normal claim): provider fails with a >64-char error code -> transitions to purge_failed at attempt_count = 10 with 60s retry backoff and truncated 64-char error code
      const veryLongCode = 'PROVIDER_ERR_' + '9'.repeat(80);
      await expect(
        executeExternalIdentityOutboxPurge({
          outboxId: id,
          leaseOwner: 'worker-alpha',
          leaseSeconds: 60,
          retryDelaySeconds: 60,
          repo,
          authAdmin: {
            deleteUserById: async () => {
              throw Object.assign(new Error('Provider 503 outage on attempt 10'), {
                code: veryLongCode,
              });
            },
          },
        }),
      ).rejects.toThrow('Provider 503 outage on attempt 10');

      const afterAttempt10Fail = await repo.getOutboxItemById(id);
      expect(afterAttempt10Fail?.status).toBe('purge_failed');
      expect(afterAttempt10Fail?.attemptCount).toBe(10);
      expect(afterAttempt10Fail?.lastErrorCode).toHaveLength(64);

      // Normal claim at attempt 10 is rejected with max_attempts_exhausted
      const normalExhausted = await repo.acquireOutboxLease({
        outboxId: id,
        leaseOwner: 'worker-alpha',
        leaseSeconds: 60,
      });
      expect(normalExhausted).toMatchObject({
        status: 'unavailable',
        reason: 'max_attempts_exhausted',
      });

      // Reconciliation claim BEFORE next_attempt_at is due is rejected with retry_not_due
      const prematureReconcile = await repo.acquireOutboxLease({
        outboxId: id,
        leaseOwner: 'worker-alpha',
        leaseSeconds: 60,
        allowExhaustedReconciliation: true,
      });
      expect(prematureReconcile).toMatchObject({
        status: 'unavailable',
        reason: 'retry_not_due',
      });

      // Make next_attempt_at due
      await workerSql`
        UPDATE studexo.external_identity_purge_outbox
        SET next_attempt_at = pg_catalog.now() - interval '1 second'
        WHERE id = ${id}::uuid
      `;

      // Test C: Concurrent reconciliation claims across two independent PostgreSQL sessions
      // Both workers attempt reconciliation claims (`allowExhaustedReconciliation: true`) on the same exhausted `purge_failed` row.
      const reconcileLockAcquired = createDeferredBarrier(
        'Reconciliation concurrency: Worker A acquired FOR UPDATE lock',
      );
      const releaseReconcileCommit = createDeferredBarrier(
        'Reconciliation concurrency: release Worker A to commit',
      );
      let reconcileTxAPid = 0;

      const barrierReconcileDb = createForUpdateBarrierDatabase(workerDb, async ({ tx }) => {
        const pidRows = await tx.execute<{ pid: number }>(
          sql`SELECT pg_catalog.pg_backend_pid()::int AS pid`,
        );
        reconcileTxAPid = Number(pidRows[0]?.pid ?? 0);
        reconcileLockAcquired.release();
        await releaseReconcileCommit.wait();
      });

      const barrierReconcileRepoA =
        createPostgresExternalIdentityOutboxRepository(barrierReconcileDb);
      const reconcileRepoB =
        createPostgresExternalIdentityOutboxRepository(secondWorkerDb);

      let reconcileASettled = false;
      const reconcileAPromise = barrierReconcileRepoA
        .acquireOutboxLease({
          outboxId: id,
          leaseOwner: 'worker-alpha',
          leaseSeconds: 60,
          allowExhaustedReconciliation: true,
        })
        .finally(() => {
          reconcileASettled = true;
        });

      let reconcileBSettled = false;
      let reconcileBPromise: ReturnType<typeof reconcileRepoB.acquireOutboxLease> | undefined;

      try {
        await reconcileLockAcquired.wait();
        expect(reconcileASettled).toBe(false);
        expect(reconcileTxAPid).toBeGreaterThan(0);

        reconcileBPromise = reconcileRepoB
          .acquireOutboxLease({
            outboxId: id,
            leaseOwner: 'worker-beta',
            leaseSeconds: 60,
            allowExhaustedReconciliation: true,
          })
          .finally(() => {
            reconcileBSettled = true;
          });

        const observedReconcileWait = await waitForPostgresLockWait(adminSql, {
          blockedQueryPattern: 'external_identity_purge_outbox',
          blockerPid: reconcileTxAPid,
        });
        console.log(
          '[LIVE-PG17-EVIDENCE] Test C (Concurrent Reconciliation Lock Wait):',
          JSON.stringify({
            blockerPid: reconcileTxAPid,
            blockedPid: observedReconcileWait.blockedPid,
            blockingPids: observedReconcileWait.blockingPids,
            waitEventType: observedReconcileWait.waitEventType,
            waitEvent: observedReconcileWait.waitEvent,
            state: observedReconcileWait.state,
          }),
        );
        expect(observedReconcileWait.waitEventType).toBe('Lock');
        expect(observedReconcileWait.blockingPids).toContain(reconcileTxAPid);
        expect(reconcileBSettled).toBe(false);
        expect(reconcileASettled).toBe(false);
      } finally {
        releaseReconcileCommit.release();
      }

      const [reconcileClaim1, concurrentReconcileB] = await Promise.all([
        reconcileAPromise,
        reconcileBPromise!,
      ]);
      expect(reconcileClaim1.status).toBe('acquired');
      expect(concurrentReconcileB.status).toBe('unavailable');
      if (
        reconcileClaim1.status !== 'acquired' ||
        concurrentReconcileB.status !== 'unavailable'
      ) {
        throw new Error('Expected one acquired reconciliation lease and one active_lease rejection');
      }
      expect(reconcileClaim1.mode).toBe('reconciliation');
      expect(reconcileClaim1.item.attemptCount).toBe(10);
      expect(concurrentReconcileB.reason).toBe('active_lease');
      expect(concurrentReconcileB.item?.attemptCount).toBe(10);
      expect(concurrentReconcileB.item?.leaseOwner).toBe(reconcileClaim1.item.leaseOwner);
      const reconcileToken1 = reconcileClaim1.item.leaseOwner!;

      // Simulate lease expiry during first reconciliation at attempt_count = 10
      await workerSql`
        UPDATE studexo.external_identity_purge_outbox
        SET locked_until = pg_catalog.now() - interval '5 seconds'
        WHERE id = ${id}::uuid
      `;

      // Recovery transitions expired purging -> purge_failed at attempt_count = 10 without incrementing attempt_count
      const recoveredAtMax = await recoverExpiredExternalIdentityOutboxLease({
        outboxId: id,
        retryDelaySeconds: 30,
        repo: {
          getOutboxItemById: repo.getOutboxItemById,
          markExpiredOutboxLeaseFailed: recoveryRepo.markExpiredOutboxLeaseFailed,
        },
      });
      expect(recoveredAtMax.outcome).toBe('recovered_to_purge_failed');
      expect(recoveredAtMax.item?.status).toBe('purge_failed');
      expect(recoveredAtMax.item?.attemptCount).toBe(10);
      expect(recoveredAtMax.item?.leaseOwner).toBeNull();

      // Advance next_attempt_at so second reconciliation is due
      await workerSql`
        UPDATE studexo.external_identity_purge_outbox
        SET next_attempt_at = pg_catalog.now() - interval '1 second'
        WHERE id = ${id}::uuid
      `;

      // Test B: Acquire a second reconciliation lease (`reconcileToken2`) at attempt_count = 10,
      // then verify that attempting completion and failure with `reconcileToken1` and unchanged
      // `expectedAttemptCount = 10` are both rejected and leave the second reconciliation lease intact!
      let providerDeleteCalls = 0;
      const failingMarkPurgedRepo = {
        ...repo,
        markOutboxPurged: async () => {
          throw new Error('Simulated DB error after provider deletion succeeded');
        },
      };

      await expect(
        executeExternalIdentityOutboxPurge({
          outboxId: id,
          leaseOwner: 'worker-alpha',
          leaseSeconds: 60,
          retryDelaySeconds: 30,
          allowExhaustedReconciliation: true,
          repo: failingMarkPurgedRepo,
          authAdmin: {
            deleteUserById: async () => {
              providerDeleteCalls += 1;
              return { status: 'deleted' };
            },
          },
        }),
      ).rejects.toThrow('Simulated DB error after provider deletion succeeded');
      expect(providerDeleteCalls).toBe(1);

      const midFlightRow = await repo.getOutboxItemById(id);
      expect(midFlightRow?.status).toBe('purging');
      expect(midFlightRow?.attemptCount).toBe(10);
      const reconcileToken2 = midFlightRow?.leaseOwner ?? '';
      expect(reconcileToken2).toMatch(/^worker-alpha:[0-9a-f-]{36}$/);
      expect(reconcileToken2).not.toBe(reconcileToken1);

      // Test B Step 6-7: Stale first reconciliation worker attempts completion and failure using reconcileToken1 and expectedAttemptCount = 10
      const staleReconcilePurged = await repo.markOutboxPurged({
        outboxId: id,
        fencing: {
          expectedLeaseOwner: reconcileToken1,
          expectedAttemptCount: 10,
        },
      });
      expect(staleReconcilePurged.status).toBe('stale_lease');

      const staleReconcileFailed = await repo.markOutboxPurgeFailed({
        outboxId: id,
        retryDelaySeconds: 30,
        errorCode: 'STALE_RECONCILE_1',
        errorMessage: 'stale first reconciliation worker failure',
        fencing: {
          expectedLeaseOwner: reconcileToken1,
          expectedAttemptCount: 10,
        },
      });
      expect(staleReconcileFailed.status).toBe('stale_lease');

      const intactSecondReconcileRow = await repo.getOutboxItemById(id);
      expect(intactSecondReconcileRow?.status).toBe('purging');
      expect(intactSecondReconcileRow?.leaseOwner).toBe(reconcileToken2);
      expect(intactSecondReconcileRow?.attemptCount).toBe(10);
      expect(intactSecondReconcileRow?.completedAt).toBeNull();

      // Expire the interrupted second reconciliation lease, recover it, make due, and run third reconciliation
      await workerSql`
        UPDATE studexo.external_identity_purge_outbox
        SET locked_until = pg_catalog.now() - interval '5 seconds'
        WHERE id = ${id}::uuid
      `;
      await recoverExpiredExternalIdentityOutboxLease({
        outboxId: id,
        retryDelaySeconds: 10,
        repo: {
          getOutboxItemById: repo.getOutboxItemById,
          markExpiredOutboxLeaseFailed: recoveryRepo.markExpiredOutboxLeaseFailed,
        },
      });
      await workerSql`
        UPDATE studexo.external_identity_purge_outbox
        SET next_attempt_at = pg_catalog.now() - interval '1 second'
        WHERE id = ${id}::uuid
      `;

      // Third reconciliation calls provider (which now returns 'already_absent') and completes to 'purged'
      const finalReconcile = await executeExternalIdentityOutboxPurge({
        outboxId: id,
        leaseOwner: 'worker-alpha',
        leaseSeconds: 60,
        retryDelaySeconds: 10,
        allowExhaustedReconciliation: true,
        repo,
        authAdmin: {
          deleteUserById: async () => {
            providerDeleteCalls += 1;
            return { status: 'already_absent' };
          },
        },
      });
      expect(providerDeleteCalls).toBe(2);
      expect(finalReconcile.outcome).toBe('purged');
      if (finalReconcile.outcome === 'purged') {
        expect(finalReconcile.mode).toBe('reconciliation');
        expect(finalReconcile.providerStatus).toBe('already_absent');
        expect(finalReconcile.item.status).toBe('purged');
        expect(finalReconcile.item.attemptCount).toBe(10);
        expect(finalReconcile.item.completedAt).toBeInstanceOf(Date);
      }
    });

    it('5. completes end-to-end account purge -> outbox creation -> re-registration blocked -> outbox purged -> re-registration unblocked', async () => {
      const userId = crypto.randomUUID();
      const supabaseAuthUserId = crypto.randomUUID();
      const fileId = crypto.randomUUID();

      await adminSql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE studexo_migrator`);
        await tx`
          INSERT INTO studexo.users (id, supabase_auth_user_id, primary_email, display_name)
          VALUES (
            ${userId}::uuid,
            ${supabaseAuthUserId}::uuid,
            ${`e2e-${userId}@example.com`},
            'E2E Student'
          )
        `;
        await tx.unsafe(`SET LOCAL ROLE studexo_purge_owner`);
        await tx`
          UPDATE studexo.users
          SET status = 'pending_deletion',
              deletion_requested_at = pg_catalog.now() - interval '15 days',
              deletion_scheduled_for = pg_catalog.now() - interval '1 day',
              purge_state = 'pending_purge'
          WHERE id = ${userId}::uuid
        `;
        await tx.unsafe(`SET LOCAL ROLE studexo_migrator`);
        await tx`
          INSERT INTO studexo.stored_files (
            id, owner_user_id, storage_bucket, object_key, original_filename,
            mime_type, byte_size, sha256_checksum, upload_status
          ) VALUES (
            ${fileId}::uuid,
            ${userId}::uuid,
            'student-documents',
            ${`users/${userId}/${fileId}.pdf`},
            'cv.pdf',
            'application/pdf',
            1024,
            ${'c'.repeat(64)},
            'uploaded'
          )
        `;
      });

      const accountRepo = createPostgresAccountPurgeRepository(workerDb);
      const fileRepo = createPostgresFilePurgeWorkerRepository(workerDb);
      const outboxRepo = createPostgresExternalIdentityOutboxRepository(workerDb);

      // Step 1: Execute Storage-first account purge
      const purgeResult = await executeStorageFirstAccountPurge({
        userId,
        leaseOwner: 'account-worker',
        leaseSeconds: 60,
        accountRepo,
        fileRepo,
        storage: {
          removeObject: async () => undefined,
          verifyObjectAbsent: async () => true,
        },
      });
      expect(purgeResult.databasePurgeExecuted).toBe(true);

      // Step 2: Locate the newly created outbox row and confirm re-registration is blocked for studexo_app
      const [outboxRow] = await workerSql<{ id: string; status: string }[]>`
        SELECT id, status
        FROM studexo.external_identity_purge_outbox
        WHERE supabase_auth_user_id = ${supabaseAuthUserId}::uuid
      `;
      expect(outboxRow?.status).toBe('pending_purge');

      const [pendingBefore] = await appSql<{ pending: boolean }[]>`
        SELECT studexo.is_auth_user_pending_purge(${supabaseAuthUserId}::uuid) AS pending
      `;
      expect(pendingBefore?.pending).toBe(true);

      await expect(
        appSql`
          INSERT INTO studexo.users (id, supabase_auth_user_id, primary_email, display_name)
          VALUES (
            ${crypto.randomUUID()}::uuid,
            ${supabaseAuthUserId}::uuid,
            ${`rebind-${userId}@example.com`},
            'Blocked Re-Registration'
          )
        `,
      ).rejects.toMatchObject({ code: '23514' });

      // Step 3: Process outbox item via executeExternalIdentityOutboxPurge as studexo_purge_worker
      const outboxExecResult = await executeExternalIdentityOutboxPurge({
        outboxId: outboxRow!.id,
        leaseOwner: 'outbox-worker',
        leaseSeconds: 60,
        retryDelaySeconds: 60,
        repo: outboxRepo,
        authAdmin: {
          deleteUserById: async (targetAuthId) => {
            expect(targetAuthId).toBe(supabaseAuthUserId);
            return { status: 'deleted' };
          },
        },
      });
      expect(outboxExecResult.outcome).toBe('purged');
      if (outboxExecResult.outcome === 'purged') {
        expect(outboxExecResult.mode).toBe('normal');
        expect(outboxExecResult.providerStatus).toBe('deleted');
        expect(outboxExecResult.item.status).toBe('purged');
        expect(outboxExecResult.item.attemptCount).toBe(1);
        expect(outboxExecResult.item.completedAt).toBeInstanceOf(Date);
      }

      // Step 4: Verify is_auth_user_pending_purge is now false and studexo_app can re-register the identity
      const [pendingAfter] = await appSql<{ pending: boolean }[]>`
        SELECT studexo.is_auth_user_pending_purge(${supabaseAuthUserId}::uuid) AS pending
      `;
      expect(pendingAfter?.pending).toBe(false);

      const newUserId = crypto.randomUUID();
      await appSql`
        INSERT INTO studexo.users (id, supabase_auth_user_id, primary_email, display_name)
        VALUES (
          ${newUserId}::uuid,
          ${supabaseAuthUserId}::uuid,
          ${`rebind-${newUserId}@example.com`},
          'Unblocked Re-Registration'
        )
      `;

      const [reboundUser] = await appSql<{ id: string; status: string }[]>`
        SELECT id, status
        FROM studexo.users
        WHERE id = ${newUserId}::uuid
      `;
      expect(reboundUser).toEqual({ id: newUserId, status: 'active' });
    });
  },
);
