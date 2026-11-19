import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { StudexoDatabase } from '../../db/client';
import { storedFiles } from '../../db/schema/documents';
import { users } from '../../db/schema/identity';
import { externalIdentityPurgeOutbox } from '../../db/schema/outbox';
import { STORED_FILE_LIFECYCLE_COLUMNS } from './postgresFilePurgeRepository';
import type {
  AccountPurgeFailureFencing,
  AccountPurgeFailureWriteResult,
  AccountPurgeLeaseRecoveryRepository,
  AccountPurgeRepository,
  ExternalIdentityOutboxItem,
  StoredFileLifecycleRecord,
  UserLifecycleRecord,
} from './storageAndPurge';

/**
 * Explicit 10-column projection matching `UserLifecycleRecord` and strictly contained
 * within `studexo_purge_worker`'s Step 7 column-scoped `SELECT` grant on `studexo.users`.
 * Never selects `primary_email`, `display_name`, `role`, `created_at`, or `updated_at`.
 */
export const USER_LIFECYCLE_COLUMNS = {
  id: users.id,
  supabaseAuthUserId: users.supabaseAuthUserId,
  status: users.status,
  purgeState: users.purgeState,
  deletionRequestedAt: users.deletionRequestedAt,
  deletionScheduledFor: users.deletionScheduledFor,
  purgeLeaseOwner: users.purgeLeaseOwner,
  purgeLeaseUntil: users.purgeLeaseUntil,
  purgeAttempts: users.purgeAttempts,
  lastPurgeError: users.lastPurgeError,
} as const;

/**
 * Explicit 6-column projection matching `ExternalIdentityOutboxItem` for read-only
 * outbox lookup during interrupted account-purge recovery.
 */
export const EXTERNAL_IDENTITY_OUTBOX_LOOKUP_COLUMNS = {
  id: externalIdentityPurgeOutbox.id,
  formerUserId: externalIdentityPurgeOutbox.formerUserId,
  supabaseAuthUserId: externalIdentityPurgeOutbox.supabaseAuthUserId,
  status: externalIdentityPurgeOutbox.status,
  attemptCount: externalIdentityPurgeOutbox.attemptCount,
  maxAttempts: externalIdentityPurgeOutbox.maxAttempts,
} as const;

type ProjectedUserLifecycleRow = {
  id: string;
  supabaseAuthUserId: string | null;
  status: UserLifecycleRecord['status'];
  purgeState: UserLifecycleRecord['purgeState'];
  deletionRequestedAt: Date | null;
  deletionScheduledFor: Date | null;
  purgeLeaseOwner: string | null;
  purgeLeaseUntil: Date | null;
  purgeAttempts: number;
  lastPurgeError: string | null;
};

type ProjectedStoredFileRow = {
  id: string;
  ownerUserId: string;
  storageBucket: string;
  objectKey: string;
  uploadStatus: StoredFileLifecycleRecord['uploadStatus'];
  purgeState: StoredFileLifecycleRecord['purgeState'];
  deletedAt: Date | null;
  deletedByUserId: string | null;
  purgedAt: Date | null;
  purgeAttempts: number;
  purgeLeaseUntil: Date | null;
  lastPurgeError: string | null;
};

type ProjectedExternalIdentityOutboxRow = {
  id: string;
  formerUserId: string;
  supabaseAuthUserId: string;
  status: UserLifecycleRecord['purgeState'];
  attemptCount: number;
  maxAttempts: number;
};

function toUserLifecycleRecord(row: ProjectedUserLifecycleRow): UserLifecycleRecord {
  return {
    id: row.id,
    supabaseAuthUserId: row.supabaseAuthUserId ?? null,
    status: row.status,
    purgeState: row.purgeState,
    deletionRequestedAt: row.deletionRequestedAt ?? null,
    deletionScheduledFor: row.deletionScheduledFor ?? null,
    purgeLeaseOwner: row.purgeLeaseOwner ?? null,
    purgeLeaseUntil: row.purgeLeaseUntil ?? null,
    purgeAttempts: row.purgeAttempts,
    lastPurgeError: row.lastPurgeError ?? null,
  };
}

function toStoredFileLifecycleRecord(row: ProjectedStoredFileRow): StoredFileLifecycleRecord {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    storageBucket: row.storageBucket,
    objectKey: row.objectKey,
    uploadStatus: row.uploadStatus,
    purgeState: row.purgeState,
    deletedAt: row.deletedAt,
    deletedByUserId: row.deletedByUserId,
    purgedAt: row.purgedAt,
    purgeAttempts: row.purgeAttempts,
    purgeLeaseUntil: row.purgeLeaseUntil ?? null,
    lastPurgeError: row.lastPurgeError ?? null,
  };
}

function toExternalIdentityOutboxItem(
  row: ProjectedExternalIdentityOutboxRow,
): ExternalIdentityOutboxItem {
  if (row.status === 'none') {
    throw new Error(
      `Invalid external_identity_purge_outbox status 'none' for outbox item ${row.id}.`,
    );
  }
  return {
    id: row.id,
    formerUserId: row.formerUserId,
    supabaseAuthUserId: row.supabaseAuthUserId,
    status: row.status,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
  };
}

function assertValidLeaseSeconds(leaseSeconds: number): void {
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
    throw new Error('leaseSeconds must be a finite positive number.');
  }
}

function assertValidLeaseOwner(leaseOwner: string): string {
  if (typeof leaseOwner !== 'string') {
    throw new Error('leaseOwner must be a non-empty string.');
  }
  const trimmed = leaseOwner.trim();
  if (trimmed.length === 0 || trimmed.length > 120) {
    throw new Error('leaseOwner must be a non-empty string of at most 120 characters.');
  }
  return trimmed;
}

function assertValidFencing(fencing: AccountPurgeFailureFencing): {
  expectedLeaseOwner: string;
  expectedPurgeAttempts: number;
} {
  if (!fencing || typeof fencing !== 'object') {
    throw new Error('markUserPurgeFailed requires explicit lease fencing.');
  }
  const expectedLeaseOwner = assertValidLeaseOwner(fencing.expectedLeaseOwner);
  const expectedPurgeAttempts = fencing.expectedPurgeAttempts;
  if (!Number.isInteger(expectedPurgeAttempts) || expectedPurgeAttempts < 1) {
    throw new Error('expectedPurgeAttempts must be a positive integer.');
  }
  return { expectedLeaseOwner, expectedPurgeAttempts };
}

/**
 * Concrete Drizzle PostgreSQL implementation of `AccountPurgeRepository` scoped to
 * `studexo_purge_worker`'s least-privilege column grants (`docs/DATABASE_ROLES.md` Step 7).
 */
export function createPostgresAccountPurgeRepository(
  db: StudexoDatabase,
): AccountPurgeRepository {
  return {
    async getUserForPurge(userId) {
      const [row] = await db
        .select(USER_LIFECYCLE_COLUMNS)
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      return row ? toUserLifecycleRecord(row) : null;
    },

    async markUserPurging({ userId, leaseOwner, leaseSeconds }) {
      const normalizedOwner = assertValidLeaseOwner(leaseOwner);
      assertValidLeaseSeconds(leaseSeconds);

      return db.transaction(
        async (tx): Promise<UserLifecycleRecord | null> => {
          const [locked] = await tx
            .select({
              ...USER_LIFECYCLE_COLUMNS,
              isGraceExpired: sql<boolean>`(${users.status} = 'pending_deletion' AND ${users.deletionScheduledFor} IS NOT NULL AND ${users.deletionScheduledFor} <= pg_catalog.now())`,
              isLeaseActive: sql<boolean>`(${users.purgeState} = 'purging' AND ${users.purgeLeaseUntil} IS NOT NULL AND ${users.purgeLeaseUntil} > pg_catalog.now())`,
            })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1)
            .for('update');

          if (!locked) {
            return null;
          }

          if (locked.status !== 'pending_deletion' || !locked.isGraceExpired) {
            return null;
          }

          if (
            locked.purgeState !== 'pending_purge' &&
            locked.purgeState !== 'purge_failed' &&
            locked.purgeState !== 'purging'
          ) {
            return null;
          }

          if (locked.isLeaseActive) {
            return null;
          }

          const updatedRows = await tx
            .update(users)
            .set({
              purgeState: 'purging',
              purgeLeaseOwner: normalizedOwner,
              purgeLeaseUntil: sql`pg_catalog.now() + pg_catalog.make_interval(secs => ${leaseSeconds}::double precision)`,
              purgeAttempts: sql`${users.purgeAttempts} + 1`,
              updatedAt: sql`pg_catalog.now()`,
            })
            .where(
              and(
                eq(users.id, userId),
                eq(users.status, 'pending_deletion'),
                sql`${users.deletionScheduledFor} IS NOT NULL AND ${users.deletionScheduledFor} <= pg_catalog.now()`,
                inArray(users.purgeState, ['pending_purge', 'purge_failed', 'purging']),
                or(
                  sql`${users.purgeState} <> 'purging'`,
                  isNull(users.purgeLeaseUntil),
                  sql`${users.purgeLeaseUntil} <= pg_catalog.now()`,
                ),
              ),
            )
            .returning(USER_LIFECYCLE_COLUMNS);

          const updated = updatedRows[0];
          if (!updated) {
            return null;
          }

          return toUserLifecycleRecord(updated);
        },
        { isolationLevel: 'read committed' },
      );
    },

    async markUserPurgeFailed(userId, errorMessage, fencing): Promise<AccountPurgeFailureWriteResult> {
      const { expectedLeaseOwner, expectedPurgeAttempts } = assertValidFencing(fencing);

      return db.transaction(
        async (tx): Promise<AccountPurgeFailureWriteResult> => {
          const [locked] = await tx
            .select(USER_LIFECYCLE_COLUMNS)
            .from(users)
            .where(eq(users.id, userId))
            .limit(1)
            .for('update');

          if (!locked) {
            return {
              status: 'stale_lease',
              user: null,
            };
          }

          if (
            locked.status !== 'pending_deletion' ||
            locked.purgeState !== 'purging' ||
            locked.purgeLeaseOwner !== expectedLeaseOwner ||
            locked.purgeAttempts !== expectedPurgeAttempts
          ) {
            return {
              status: 'stale_lease',
              user: toUserLifecycleRecord(locked),
            };
          }

          const updatedRows = await tx
            .update(users)
            .set({
              purgeState: 'purge_failed',
              purgeLeaseOwner: null,
              purgeLeaseUntil: null,
              lastPurgeError: errorMessage,
              updatedAt: sql`pg_catalog.now()`,
            })
            .where(
              and(
                eq(users.id, userId),
                eq(users.status, 'pending_deletion'),
                eq(users.purgeState, 'purging'),
                eq(users.purgeLeaseOwner, expectedLeaseOwner),
                eq(users.purgeAttempts, expectedPurgeAttempts),
              ),
            )
            .returning(USER_LIFECYCLE_COLUMNS);

          const updated = updatedRows[0];
          if (updatedRows.length !== 1 || !updated) {
            throw new Error(
              `Expected 1 updated users row when marking ${userId} purge_failed, got ${updatedRows.length}.`,
            );
          }

          return {
            status: 'recorded',
            user: toUserLifecycleRecord(updated),
          };
        },
        { isolationLevel: 'read committed' },
      );
    },

    async listUserStoredFiles(userId) {
      const rows = await db
        .select(STORED_FILE_LIFECYCLE_COLUMNS)
        .from(storedFiles)
        .where(eq(storedFiles.ownerUserId, userId))
        .orderBy(asc(storedFiles.id));

      return rows.map(toStoredFileLifecycleRecord);
    },

    async executeAccountPurgeRpc(userId, fencing) {
      const { expectedLeaseOwner, expectedPurgeAttempts } = assertValidFencing(fencing);
      await db.transaction(
        async (tx) => {
          await tx.execute(
            sql`SELECT studexo.execute_account_purge(${userId}::uuid, ${expectedLeaseOwner}::varchar, ${expectedPurgeAttempts}::integer)`,
          );
        },
        { isolationLevel: 'read committed' },
      );
    },

    async listDueUsersForPurge(limit = 5) {
      const rows = await db
        .select(USER_LIFECYCLE_COLUMNS)
        .from(users)
        .where(
          and(
            eq(users.status, 'pending_deletion'),
            sql`${users.deletionScheduledFor} IS NOT NULL AND ${users.deletionScheduledFor} <= pg_catalog.now()`,
            inArray(users.purgeState, ['pending_purge', 'purge_failed']),
            or(
              isNull(users.purgeLeaseUntil),
              sql`${users.purgeLeaseUntil} <= pg_catalog.now()`,
            ),
          ),
        )
        .orderBy(asc(users.deletionScheduledFor), asc(users.id))
        .limit(limit);

      return rows.map(toUserLifecycleRecord);
    },

    async listExpiredAccountPurges(limit = 5) {
      const rows = await db
        .select(USER_LIFECYCLE_COLUMNS)
        .from(users)
        .where(
          and(
            eq(users.status, 'pending_deletion'),
            eq(users.purgeState, 'purging'),
            sql`${users.purgeLeaseUntil} IS NOT NULL AND ${users.purgeLeaseUntil} <= pg_catalog.now()`,
          ),
        )
        .orderBy(asc(users.purgeLeaseUntil), asc(users.id))
        .limit(limit);

      return rows.map(toUserLifecycleRecord);
    },
  };
}

/**
 * Concrete Drizzle PostgreSQL implementation of `AccountPurgeLeaseRecoveryRepository` scoped to
 * `studexo_purge_worker`'s least-privilege column grants (`docs/DATABASE_ROLES.md` Step 7).
 */
export function createPostgresAccountPurgeLeaseRecoveryRepository(
  db: StudexoDatabase,
): AccountPurgeLeaseRecoveryRepository {
  return {
    async markExpiredAccountPurgeLeaseFailed({ userId, errorMessage }) {
      return db.transaction(
        async (tx): Promise<UserLifecycleRecord | null> => {
          const [locked] = await tx
            .select({
              ...USER_LIFECYCLE_COLUMNS,
              isLeaseExpired: sql<boolean>`(${users.purgeState} = 'purging' AND (${users.purgeLeaseUntil} IS NULL OR ${users.purgeLeaseUntil} <= pg_catalog.now()))`,
            })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1)
            .for('update');

          if (
            !locked ||
            locked.status !== 'pending_deletion' ||
            locked.purgeState !== 'purging' ||
            !locked.isLeaseExpired
          ) {
            return null;
          }

          const combinedError =
            locked.lastPurgeError && !errorMessage.includes(locked.lastPurgeError)
              ? `${errorMessage} | previous: ${locked.lastPurgeError}`
              : errorMessage;

          const updatedRows = await tx
            .update(users)
            .set({
              purgeState: 'purge_failed',
              purgeLeaseOwner: null,
              purgeLeaseUntil: null,
              lastPurgeError: combinedError,
              updatedAt: sql`pg_catalog.now()`,
            })
            .where(
              and(
                eq(users.id, userId),
                eq(users.status, 'pending_deletion'),
                eq(users.purgeState, 'purging'),
                or(
                  isNull(users.purgeLeaseUntil),
                  sql`${users.purgeLeaseUntil} <= pg_catalog.now()`,
                ),
              ),
            )
            .returning(USER_LIFECYCLE_COLUMNS);

          const updated = updatedRows[0];
          if (!updated) {
            return null;
          }

          return toUserLifecycleRecord(updated);
        },
        { isolationLevel: 'read committed' },
      );
    },

    async findExternalIdentityOutboxByAuthUserId(supabaseAuthUserId) {
      const [row] = await db
        .select(EXTERNAL_IDENTITY_OUTBOX_LOOKUP_COLUMNS)
        .from(externalIdentityPurgeOutbox)
        .where(eq(externalIdentityPurgeOutbox.supabaseAuthUserId, supabaseAuthUserId))
        .limit(1);

      return row ? toExternalIdentityOutboxItem(row) : null;
    },
  };
}
