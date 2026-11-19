import crypto from 'node:crypto';
import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { StudexoDatabase } from '../../db/client';
import { externalIdentityPurgeOutbox } from '../../db/schema/outbox';
import type {
  ExternalIdentityOutboxClaimResult,
  ExternalIdentityOutboxFencing,
  ExternalIdentityOutboxRecord,
  ExternalIdentityOutboxRecoveryRepository,
  ExternalIdentityOutboxRepository,
  ExternalIdentityOutboxWriteResult,
} from './storageAndPurge';

export const MAX_OUTBOX_LEASE_OWNER_LENGTH = 120;
export const MAX_OUTBOX_ERROR_CODE_LENGTH = 64;
const MAX_LEASE_OWNER_PREFIX_LENGTH = 80;

/**
 * Explicit 12-column projection matching `ExternalIdentityOutboxRecord` and strictly
 * contained within `studexo_purge_worker`'s Step 7 `SELECT` grant on
 * `studexo.external_identity_purge_outbox`. Never uses `SELECT *`.
 */
export const EXTERNAL_IDENTITY_OUTBOX_COLUMNS = {
  id: externalIdentityPurgeOutbox.id,
  formerUserId: externalIdentityPurgeOutbox.formerUserId,
  supabaseAuthUserId: externalIdentityPurgeOutbox.supabaseAuthUserId,
  status: externalIdentityPurgeOutbox.status,
  attemptCount: externalIdentityPurgeOutbox.attemptCount,
  maxAttempts: externalIdentityPurgeOutbox.maxAttempts,
  nextAttemptAt: externalIdentityPurgeOutbox.nextAttemptAt,
  leaseOwner: externalIdentityPurgeOutbox.leaseOwner,
  lockedUntil: externalIdentityPurgeOutbox.lockedUntil,
  lastErrorCode: externalIdentityPurgeOutbox.lastErrorCode,
  lastErrorMessage: externalIdentityPurgeOutbox.lastErrorMessage,
  completedAt: externalIdentityPurgeOutbox.completedAt,
} as const;

type ProjectedExternalIdentityOutboxRow = {
  id: string;
  formerUserId: string;
  supabaseAuthUserId: string;
  status: 'none' | ExternalIdentityOutboxRecord['status'];
  attemptCount: number | string;
  maxAttempts: number | string;
  nextAttemptAt: Date | string;
  leaseOwner: string | null;
  lockedUntil: Date | string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  completedAt: Date | string | null;
};

function normalizeRequiredDate(value: Date | string, fieldName: string): Date {
  if (value instanceof Date) {
    return value;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp returned for external_identity_purge_outbox.${fieldName}.`);
  }
  return parsed;
}

function normalizeNullableDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid nullable timestamp returned for external_identity_purge_outbox.');
  }
  return parsed;
}

function normalizeInteger(value: number | string, fieldName: string): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(num)) {
    throw new Error(`Invalid integer returned for external_identity_purge_outbox.${fieldName}.`);
  }
  return num;
}

function toExternalIdentityOutboxRecord(
  row: ProjectedExternalIdentityOutboxRow,
): ExternalIdentityOutboxRecord {
  if (row.status === 'none') {
    throw new Error(
      `Invalid status 'none' on external_identity_purge_outbox row ${row.id}.`,
    );
  }
  return {
    id: row.id,
    formerUserId: row.formerUserId,
    supabaseAuthUserId: row.supabaseAuthUserId,
    status: row.status,
    attemptCount: normalizeInteger(row.attemptCount, 'attempt_count'),
    maxAttempts: normalizeInteger(row.maxAttempts, 'max_attempts'),
    nextAttemptAt: normalizeRequiredDate(row.nextAttemptAt, 'next_attempt_at'),
    leaseOwner: row.leaseOwner ?? null,
    lockedUntil: normalizeNullableDate(row.lockedUntil),
    lastErrorCode: row.lastErrorCode ?? null,
    lastErrorMessage: row.lastErrorMessage ?? null,
    completedAt: normalizeNullableDate(row.completedAt),
  };
}

function assertNonEmptyString(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function assertPositiveSeconds(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a finite positive number.`);
  }
}

function assertValidBatchLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be an integer between 1 and 100.');
  }
}

function assertValidFencing(fencing: ExternalIdentityOutboxFencing): {
  expectedLeaseOwner: string;
  expectedAttemptCount: number;
} {
  if (!fencing || typeof fencing !== 'object') {
    throw new Error('fencing is required.');
  }
  const expectedLeaseOwner = assertNonEmptyString(
    fencing.expectedLeaseOwner,
    'fencing.expectedLeaseOwner',
  );
  if (expectedLeaseOwner.length > MAX_OUTBOX_LEASE_OWNER_LENGTH) {
    throw new Error(
      `fencing.expectedLeaseOwner must not exceed ${MAX_OUTBOX_LEASE_OWNER_LENGTH} characters.`,
    );
  }
  if (
    !Number.isInteger(fencing.expectedAttemptCount) ||
    fencing.expectedAttemptCount < 1
  ) {
    throw new Error('fencing.expectedAttemptCount must be a positive integer.');
  }
  return {
    expectedLeaseOwner,
    expectedAttemptCount: fencing.expectedAttemptCount,
  };
}

export function truncateOutboxErrorCode(
  errorCode: string | null | undefined,
): string | null {
  if (errorCode === null || errorCode === undefined) {
    return null;
  }
  const trimmed = String(errorCode).trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.slice(0, MAX_OUTBOX_ERROR_CODE_LENGTH);
}

/**
 * Generates a fresh, unique per-claim lease token that incorporates the logical worker
 * identity while guaranteeing uniqueness across repeated claims by the same worker and
 * strictly fitting `varchar(120)` (`<= 117` characters).
 */
export function buildUniqueOutboxLeaseToken(leaseOwner: string): string {
  const prefix = assertNonEmptyString(leaseOwner, 'leaseOwner').slice(
    0,
    MAX_LEASE_OWNER_PREFIX_LENGTH,
  );
  return `${prefix}:${crypto.randomUUID()}`;
}

function rethrowPreservingDatabaseError(error: unknown): never {
  if (
    error &&
    typeof error === 'object' &&
    'cause' in error &&
    error.cause &&
    typeof error.cause === 'object' &&
    'code' in error.cause &&
    typeof (error.cause as { code?: unknown }).code === 'string'
  ) {
    throw error.cause;
  }
  throw error;
}

/**
 * Concrete Drizzle PostgreSQL implementation of `ExternalIdentityOutboxRepository` scoped to
 * `studexo_purge_worker`'s least-privilege column grants (`docs/DATABASE_ROLES.md` Step 7).
 */
export function createPostgresExternalIdentityOutboxRepository(
  db: StudexoDatabase,
): ExternalIdentityOutboxRepository {
  return {
    async getOutboxItemById(outboxId) {
      const normalizedId = assertNonEmptyString(outboxId, 'outboxId');
      try {
        const [row] = await db
          .select(EXTERNAL_IDENTITY_OUTBOX_COLUMNS)
          .from(externalIdentityPurgeOutbox)
          .where(eq(externalIdentityPurgeOutbox.id, normalizedId))
          .limit(1);

        return row ? toExternalIdentityOutboxRecord(row) : null;
      } catch (error) {
        rethrowPreservingDatabaseError(error);
      }
    },

    async acquireOutboxLease({
      outboxId,
      leaseOwner,
      leaseSeconds,
      allowExhaustedReconciliation = false,
    }) {
      const normalizedId = assertNonEmptyString(outboxId, 'outboxId');
      assertNonEmptyString(leaseOwner, 'leaseOwner');
      assertPositiveSeconds(leaseSeconds, 'leaseSeconds');

      try {
        return await db.transaction(
          async (tx): Promise<ExternalIdentityOutboxClaimResult> => {
            const [locked] = await tx
              .select({
                ...EXTERNAL_IDENTITY_OUTBOX_COLUMNS,
                isLeaseActive: sql<boolean>`(${externalIdentityPurgeOutbox.status} = 'purging' AND ${externalIdentityPurgeOutbox.lockedUntil} IS NOT NULL AND ${externalIdentityPurgeOutbox.lockedUntil} > pg_catalog.now())`,
                isRetryDue: sql<boolean>`(${externalIdentityPurgeOutbox.nextAttemptAt} <= pg_catalog.now())`,
              })
              .from(externalIdentityPurgeOutbox)
              .where(eq(externalIdentityPurgeOutbox.id, normalizedId))
              .limit(1)
              .for('update');

            if (!locked) {
              return {
                status: 'unavailable',
                reason: 'not_found',
                item: null,
              };
            }

            const lockedRecord = toExternalIdentityOutboxRecord(locked);

            if (lockedRecord.status === 'purged') {
              return {
                status: 'unavailable',
                reason: 'already_purged',
                item: lockedRecord,
              };
            }

            if (locked.isLeaseActive) {
              return {
                status: 'unavailable',
                reason: 'active_lease',
                item: lockedRecord,
              };
            }

            const isExhausted = lockedRecord.attemptCount >= lockedRecord.maxAttempts;

            if (isExhausted) {
              // Exhausted-attempt reconciliation path:
              // Permitted ONLY when explicitly requested (`allowExhaustedReconciliation: true`),
              // the row has already been recovered/transitioned to `status = 'purge_failed'`
              // at `attempt_count = max_attempts`, and `next_attempt_at <= pg_catalog.now()`.
              if (
                !allowExhaustedReconciliation ||
                lockedRecord.status !== 'purge_failed' ||
                lockedRecord.attemptCount !== lockedRecord.maxAttempts
              ) {
                return {
                  status: 'unavailable',
                  reason: 'max_attempts_exhausted',
                  item: lockedRecord,
                };
              }

              if (!locked.isRetryDue) {
                return {
                  status: 'unavailable',
                  reason: 'retry_not_due',
                  item: lockedRecord,
                };
              }

              const uniqueLeaseToken = buildUniqueOutboxLeaseToken(leaseOwner);

              const updatedRows = await tx
                .update(externalIdentityPurgeOutbox)
                .set({
                  status: 'purging',
                  leaseOwner: uniqueLeaseToken,
                  lockedUntil: sql`pg_catalog.now() + pg_catalog.make_interval(secs => ${leaseSeconds})`,
                  completedAt: null,
                  updatedAt: sql`pg_catalog.now()`,
                })
                .where(
                  and(
                    eq(externalIdentityPurgeOutbox.id, normalizedId),
                    eq(externalIdentityPurgeOutbox.status, 'purge_failed'),
                    eq(
                      externalIdentityPurgeOutbox.attemptCount,
                      lockedRecord.maxAttempts,
                    ),
                    sql`${externalIdentityPurgeOutbox.nextAttemptAt} <= pg_catalog.now()`,
                  ),
                )
                .returning(EXTERNAL_IDENTITY_OUTBOX_COLUMNS);

              const updated = updatedRows[0];
              if (!updated) {
                throw new Error(
                  `Expected 1 updated external_identity_purge_outbox row during reconciliation claim for ${normalizedId}, got ${updatedRows.length}.`,
                );
              }

              return {
                status: 'acquired',
                mode: 'reconciliation',
                item: toExternalIdentityOutboxRecord(updated),
              };
            }

            // Normal claim path (`attempt_count < max_attempts`):
            if (!locked.isRetryDue) {
              return {
                status: 'unavailable',
                reason: 'retry_not_due',
                item: lockedRecord,
              };
            }

            const uniqueLeaseToken = buildUniqueOutboxLeaseToken(leaseOwner);

            const updatedRows = await tx
              .update(externalIdentityPurgeOutbox)
              .set({
                status: 'purging',
                attemptCount: sql`${externalIdentityPurgeOutbox.attemptCount} + 1`,
                leaseOwner: uniqueLeaseToken,
                lockedUntil: sql`pg_catalog.now() + pg_catalog.make_interval(secs => ${leaseSeconds})`,
                completedAt: null,
                updatedAt: sql`pg_catalog.now()`,
              })
              .where(
                and(
                  eq(externalIdentityPurgeOutbox.id, normalizedId),
                  ne(externalIdentityPurgeOutbox.status, 'purged'),
                  lt(
                    externalIdentityPurgeOutbox.attemptCount,
                    externalIdentityPurgeOutbox.maxAttempts,
                  ),
                  sql`${externalIdentityPurgeOutbox.nextAttemptAt} <= pg_catalog.now()`,
                  or(
                    inArray(externalIdentityPurgeOutbox.status, [
                      'pending_purge',
                      'purge_failed',
                    ]),
                    and(
                      eq(externalIdentityPurgeOutbox.status, 'purging'),
                      or(
                        isNull(externalIdentityPurgeOutbox.lockedUntil),
                        sql`${externalIdentityPurgeOutbox.lockedUntil} <= pg_catalog.now()`,
                      ),
                    ),
                  ),
                ),
              )
              .returning(EXTERNAL_IDENTITY_OUTBOX_COLUMNS);

            const updated = updatedRows[0];
            if (!updated) {
              throw new Error(
                `Expected 1 updated external_identity_purge_outbox row when acquiring lease for ${normalizedId}, got ${updatedRows.length}.`,
              );
            }

            return {
              status: 'acquired',
              mode: 'normal',
              item: toExternalIdentityOutboxRecord(updated),
            };
          },
          { isolationLevel: 'read committed' },
        );
      } catch (error) {
        rethrowPreservingDatabaseError(error);
      }
    },

    async claimDueOutboxItems({ leaseOwner, leaseSeconds, limit = 10 }) {
      assertNonEmptyString(leaseOwner, 'leaseOwner');
      assertPositiveSeconds(leaseSeconds, 'leaseSeconds');
      assertValidBatchLimit(limit);

      try {
        return await db.transaction(
          async (tx): Promise<ExternalIdentityOutboxRecord[]> => {
            const candidates = await tx
              .select({ id: externalIdentityPurgeOutbox.id })
              .from(externalIdentityPurgeOutbox)
              .where(
                and(
                  ne(externalIdentityPurgeOutbox.status, 'purged'),
                  lt(
                    externalIdentityPurgeOutbox.attemptCount,
                    externalIdentityPurgeOutbox.maxAttempts,
                  ),
                  sql`${externalIdentityPurgeOutbox.nextAttemptAt} <= pg_catalog.now()`,
                  or(
                    inArray(externalIdentityPurgeOutbox.status, [
                      'pending_purge',
                      'purge_failed',
                    ]),
                    and(
                      eq(externalIdentityPurgeOutbox.status, 'purging'),
                      or(
                        isNull(externalIdentityPurgeOutbox.lockedUntil),
                        sql`${externalIdentityPurgeOutbox.lockedUntil} <= pg_catalog.now()`,
                      ),
                    ),
                  ),
                ),
              )
              .orderBy(
                asc(externalIdentityPurgeOutbox.nextAttemptAt),
                asc(externalIdentityPurgeOutbox.id),
              )
              .limit(limit)
              .for('update', { skipLocked: true });

            const claimedItems: ExternalIdentityOutboxRecord[] = [];

            for (const candidate of candidates) {
              const uniqueLeaseToken = buildUniqueOutboxLeaseToken(leaseOwner);
              const updatedRows = await tx
                .update(externalIdentityPurgeOutbox)
                .set({
                  status: 'purging',
                  attemptCount: sql`${externalIdentityPurgeOutbox.attemptCount} + 1`,
                  leaseOwner: uniqueLeaseToken,
                  lockedUntil: sql`pg_catalog.now() + pg_catalog.make_interval(secs => ${leaseSeconds})`,
                  completedAt: null,
                  updatedAt: sql`pg_catalog.now()`,
                })
                .where(
                  and(
                    eq(externalIdentityPurgeOutbox.id, candidate.id),
                    ne(externalIdentityPurgeOutbox.status, 'purged'),
                    lt(
                      externalIdentityPurgeOutbox.attemptCount,
                      externalIdentityPurgeOutbox.maxAttempts,
                    ),
                  ),
                )
                .returning(EXTERNAL_IDENTITY_OUTBOX_COLUMNS);

              const updated = updatedRows[0];
              if (updated) {
                claimedItems.push(toExternalIdentityOutboxRecord(updated));
              }
            }

            return claimedItems;
          },
          { isolationLevel: 'read committed' },
        );
      } catch (error) {
        rethrowPreservingDatabaseError(error);
      }
    },

    async listDueExhaustedOutboxItems({ limit = 10 } = {}) {
      assertValidBatchLimit(limit);

      try {
        const rows = await db
          .select(EXTERNAL_IDENTITY_OUTBOX_COLUMNS)
          .from(externalIdentityPurgeOutbox)
          .where(
            and(
              eq(externalIdentityPurgeOutbox.status, 'purge_failed'),
              eq(
                externalIdentityPurgeOutbox.attemptCount,
                externalIdentityPurgeOutbox.maxAttempts,
              ),
              sql`${externalIdentityPurgeOutbox.nextAttemptAt} <= pg_catalog.now()`,
            ),
          )
          .orderBy(
            asc(externalIdentityPurgeOutbox.nextAttemptAt),
            asc(externalIdentityPurgeOutbox.id),
          )
          .limit(limit);

        return rows.map(toExternalIdentityOutboxRecord);
      } catch (error) {
        rethrowPreservingDatabaseError(error);
      }
    },

    async markOutboxPurged({ outboxId, fencing }) {
      const normalizedId = assertNonEmptyString(outboxId, 'outboxId');
      const { expectedLeaseOwner, expectedAttemptCount } =
        assertValidFencing(fencing);

      try {
        return await db.transaction(
          async (tx): Promise<ExternalIdentityOutboxWriteResult> => {
            const [locked] = await tx
              .select({
                ...EXTERNAL_IDENTITY_OUTBOX_COLUMNS,
                isLeaseActive: sql<boolean>`(${externalIdentityPurgeOutbox.status} = 'purging' AND ${externalIdentityPurgeOutbox.lockedUntil} IS NOT NULL AND ${externalIdentityPurgeOutbox.lockedUntil} > pg_catalog.now())`,
              })
              .from(externalIdentityPurgeOutbox)
              .where(eq(externalIdentityPurgeOutbox.id, normalizedId))
              .limit(1)
              .for('update');

            if (!locked) {
              return {
                status: 'stale_lease',
                item: null,
              };
            }

            const lockedRecord = toExternalIdentityOutboxRecord(locked);

            if (
              lockedRecord.status !== 'purging' ||
              !locked.isLeaseActive ||
              lockedRecord.lockedUntil === null ||
              lockedRecord.leaseOwner !== expectedLeaseOwner ||
              lockedRecord.attemptCount !== expectedAttemptCount
            ) {
              return {
                status: 'stale_lease',
                item: lockedRecord,
              };
            }

            const updatedRows = await tx
              .update(externalIdentityPurgeOutbox)
              .set({
                status: 'purged',
                completedAt: sql`pg_catalog.now()`,
                leaseOwner: null,
                lockedUntil: null,
                lastErrorCode: null,
                lastErrorMessage: null,
                updatedAt: sql`pg_catalog.now()`,
              })
              .where(
                and(
                  eq(externalIdentityPurgeOutbox.id, normalizedId),
                  eq(externalIdentityPurgeOutbox.status, 'purging'),
                  eq(externalIdentityPurgeOutbox.leaseOwner, expectedLeaseOwner),
                  eq(
                    externalIdentityPurgeOutbox.attemptCount,
                    expectedAttemptCount,
                  ),
                  sql`${externalIdentityPurgeOutbox.lockedUntil} IS NOT NULL`,
                  sql`${externalIdentityPurgeOutbox.lockedUntil} > pg_catalog.now()`,
                ),
              )
              .returning(EXTERNAL_IDENTITY_OUTBOX_COLUMNS);

            const updated = updatedRows[0];
            if (!updated) {
              return {
                status: 'stale_lease',
                item: lockedRecord,
              };
            }

            return {
              status: 'updated',
              item: toExternalIdentityOutboxRecord(updated),
            };
          },
          { isolationLevel: 'read committed' },
        );
      } catch (error) {
        rethrowPreservingDatabaseError(error);
      }
    },

    async markOutboxPurgeFailed({
      outboxId,
      retryDelaySeconds,
      errorCode,
      errorMessage,
      fencing,
    }) {
      const normalizedId = assertNonEmptyString(outboxId, 'outboxId');
      assertPositiveSeconds(retryDelaySeconds, 'retryDelaySeconds');
      const normalizedMessage = assertNonEmptyString(errorMessage, 'errorMessage');
      const truncatedCode = truncateOutboxErrorCode(errorCode);
      const { expectedLeaseOwner, expectedAttemptCount } =
        assertValidFencing(fencing);

      try {
        return await db.transaction(
          async (tx): Promise<ExternalIdentityOutboxWriteResult> => {
            const [locked] = await tx
              .select({
                ...EXTERNAL_IDENTITY_OUTBOX_COLUMNS,
                isLeaseActive: sql<boolean>`(${externalIdentityPurgeOutbox.status} = 'purging' AND ${externalIdentityPurgeOutbox.lockedUntil} IS NOT NULL AND ${externalIdentityPurgeOutbox.lockedUntil} > pg_catalog.now())`,
              })
              .from(externalIdentityPurgeOutbox)
              .where(eq(externalIdentityPurgeOutbox.id, normalizedId))
              .limit(1)
              .for('update');

            if (!locked) {
              return {
                status: 'stale_lease',
                item: null,
              };
            }

            const lockedRecord = toExternalIdentityOutboxRecord(locked);

            if (
              lockedRecord.status !== 'purging' ||
              !locked.isLeaseActive ||
              lockedRecord.lockedUntil === null ||
              lockedRecord.leaseOwner !== expectedLeaseOwner ||
              lockedRecord.attemptCount !== expectedAttemptCount
            ) {
              return {
                status: 'stale_lease',
                item: lockedRecord,
              };
            }

            const updatedRows = await tx
              .update(externalIdentityPurgeOutbox)
              .set({
                status: 'purge_failed',
                leaseOwner: null,
                lockedUntil: null,
                completedAt: null,
                nextAttemptAt: sql`pg_catalog.now() + pg_catalog.make_interval(secs => ${retryDelaySeconds})`,
                lastErrorCode: truncatedCode,
                lastErrorMessage: normalizedMessage,
                updatedAt: sql`pg_catalog.now()`,
              })
              .where(
                and(
                  eq(externalIdentityPurgeOutbox.id, normalizedId),
                  eq(externalIdentityPurgeOutbox.status, 'purging'),
                  eq(externalIdentityPurgeOutbox.leaseOwner, expectedLeaseOwner),
                  eq(
                    externalIdentityPurgeOutbox.attemptCount,
                    expectedAttemptCount,
                  ),
                  sql`${externalIdentityPurgeOutbox.lockedUntil} IS NOT NULL`,
                  sql`${externalIdentityPurgeOutbox.lockedUntil} > pg_catalog.now()`,
                ),
              )
              .returning(EXTERNAL_IDENTITY_OUTBOX_COLUMNS);

            const updated = updatedRows[0];
            if (!updated) {
              return {
                status: 'stale_lease',
                item: lockedRecord,
              };
            }

            return {
              status: 'updated',
              item: toExternalIdentityOutboxRecord(updated),
            };
          },
          { isolationLevel: 'read committed' },
        );
      } catch (error) {
        rethrowPreservingDatabaseError(error);
      }
    },
  };
}

/**
 * Concrete Drizzle PostgreSQL implementation of `ExternalIdentityOutboxRecoveryRepository`
 * scoped to `studexo_purge_worker`'s Step 7 privileges.
 *
 * Transitions an expired `status = 'purging'` lease to `status = 'purge_failed'` while:
 * - Verifying `expectedLeaseOwner` and `expectedAttemptCount` against both the `FOR UPDATE`
 *   locked row and the authoritative `UPDATE` predicate so a concurrent lease change is
 *   never overwritten or polluted with stale diagnostics,
 * - Preserving `attempt_count` unchanged (never incrementing or violating `attempt_count <= max_attempts`),
 * - Clearing `lease_owner` and `locked_until`,
 * - Scheduling `next_attempt_at` via `pg_catalog.now() + pg_catalog.make_interval(secs => retryDelaySeconds)`.
 */
export function createPostgresExternalIdentityOutboxRecoveryRepository(
  db: StudexoDatabase,
): ExternalIdentityOutboxRecoveryRepository {
  return {
    async markExpiredOutboxLeaseFailed({
      outboxId,
      expectedLeaseOwner,
      expectedAttemptCount,
      retryDelaySeconds,
      errorCode,
      errorMessage,
    }) {
      const normalizedId = assertNonEmptyString(outboxId, 'outboxId');
      assertPositiveSeconds(retryDelaySeconds, 'retryDelaySeconds');
      const normalizedMessage = assertNonEmptyString(errorMessage, 'errorMessage');
      const truncatedCode = truncateOutboxErrorCode(errorCode);

      if (!Number.isInteger(expectedAttemptCount) || expectedAttemptCount < 0) {
        throw new Error('expectedAttemptCount must be a non-negative integer.');
      }

      let normalizedExpectedLeaseOwner: string | null = null;
      if (expectedLeaseOwner !== null && expectedLeaseOwner !== undefined) {
        if (typeof expectedLeaseOwner !== 'string') {
          throw new Error('expectedLeaseOwner must be a string or null.');
        }
        const trimmedOwner = expectedLeaseOwner.trim();
        if (trimmedOwner.length > MAX_OUTBOX_LEASE_OWNER_LENGTH) {
          throw new Error(
            `expectedLeaseOwner must not exceed ${MAX_OUTBOX_LEASE_OWNER_LENGTH} characters.`,
          );
        }
        normalizedExpectedLeaseOwner = trimmedOwner.length > 0 ? trimmedOwner : null;
      }

      try {
        return await db.transaction(
          async (tx): Promise<ExternalIdentityOutboxWriteResult> => {
            const [locked] = await tx
              .select({
                ...EXTERNAL_IDENTITY_OUTBOX_COLUMNS,
                isLeaseExpired: sql<boolean>`(${externalIdentityPurgeOutbox.status} = 'purging' AND (${externalIdentityPurgeOutbox.lockedUntil} IS NULL OR ${externalIdentityPurgeOutbox.lockedUntil} <= pg_catalog.now()))`,
              })
              .from(externalIdentityPurgeOutbox)
              .where(eq(externalIdentityPurgeOutbox.id, normalizedId))
              .limit(1)
              .for('update');

            if (!locked) {
              return {
                status: 'stale_lease',
                item: null,
              };
            }

            const lockedRecord = toExternalIdentityOutboxRecord(locked);
            const lockedLeaseOwner =
              lockedRecord.leaseOwner && lockedRecord.leaseOwner.trim().length > 0
                ? lockedRecord.leaseOwner.trim()
                : null;

            if (
              lockedRecord.status !== 'purging' ||
              !locked.isLeaseExpired ||
              lockedLeaseOwner !== normalizedExpectedLeaseOwner ||
              lockedRecord.attemptCount !== expectedAttemptCount
            ) {
              return {
                status: 'stale_lease',
                item: lockedRecord,
              };
            }

            const combinedMessage =
              lockedRecord.lastErrorMessage &&
              !normalizedMessage.includes(lockedRecord.lastErrorMessage)
                ? `${normalizedMessage} | previous: ${lockedRecord.lastErrorMessage}`
                : normalizedMessage;

            const resolvedErrorCode =
              truncatedCode ??
              lockedRecord.lastErrorCode ??
              (lockedRecord.attemptCount >= lockedRecord.maxAttempts
                ? 'LEASE_EXPIRED_RECONCILE_REQUIRED'
                : 'LEASE_EXPIRED');

            const leaseOwnerPredicate =
              normalizedExpectedLeaseOwner !== null
                ? eq(externalIdentityPurgeOutbox.leaseOwner, normalizedExpectedLeaseOwner)
                : or(
                    isNull(externalIdentityPurgeOutbox.leaseOwner),
                    sql`pg_catalog.btrim(${externalIdentityPurgeOutbox.leaseOwner}) = ''`,
                  );

            const updatedRows = await tx
              .update(externalIdentityPurgeOutbox)
              .set({
                status: 'purge_failed',
                leaseOwner: null,
                lockedUntil: null,
                completedAt: null,
                nextAttemptAt: sql`pg_catalog.now() + pg_catalog.make_interval(secs => ${retryDelaySeconds})`,
                lastErrorCode: truncateOutboxErrorCode(resolvedErrorCode),
                lastErrorMessage: combinedMessage,
                updatedAt: sql`pg_catalog.now()`,
              })
              .where(
                and(
                  eq(externalIdentityPurgeOutbox.id, normalizedId),
                  eq(externalIdentityPurgeOutbox.status, 'purging'),
                  leaseOwnerPredicate,
                  eq(
                    externalIdentityPurgeOutbox.attemptCount,
                    expectedAttemptCount,
                  ),
                  or(
                    isNull(externalIdentityPurgeOutbox.lockedUntil),
                    sql`${externalIdentityPurgeOutbox.lockedUntil} <= pg_catalog.now()`,
                  ),
                ),
              )
              .returning(EXTERNAL_IDENTITY_OUTBOX_COLUMNS);

            const updated = updatedRows[0];
            if (!updated) {
              return {
                status: 'stale_lease',
                item: lockedRecord,
              };
            }

            return {
              status: 'updated',
              item: toExternalIdentityOutboxRecord(updated),
            };
          },
          { isolationLevel: 'read committed' },
        );
      } catch (error) {
        rethrowPreservingDatabaseError(error);
      }
    },
  };
}
