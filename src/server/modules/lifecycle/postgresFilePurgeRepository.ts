import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { StudexoDatabase } from '../../db/client';
import { documentVersions, storedFiles } from '../../db/schema/documents';
import type {
  FilePurgeLeaseRecoveryRepository,
  FilePurgeLeaseResult,
  FilePurgeWorkerRepository,
  StoredFileLifecycleRecord,
} from './storageAndPurge';

/**
 * Explicit 12-column projection matching `StoredFileLifecycleRecord` and strictly contained
 * within `studexo_purge_worker`'s Step 7 column-scoped `SELECT` grant on `studexo.stored_files`.
 */
export const STORED_FILE_LIFECYCLE_COLUMNS = {
  id: storedFiles.id,
  ownerUserId: storedFiles.ownerUserId,
  storageBucket: storedFiles.storageBucket,
  objectKey: storedFiles.objectKey,
  uploadStatus: storedFiles.uploadStatus,
  purgeState: storedFiles.purgeState,
  deletedAt: storedFiles.deletedAt,
  deletedByUserId: storedFiles.deletedByUserId,
  purgedAt: storedFiles.purgedAt,
  purgeAttempts: storedFiles.purgeAttempts,
  purgeLeaseUntil: storedFiles.purgeLeaseUntil,
  lastPurgeError: storedFiles.lastPurgeError,
} as const;

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

function assertValidLeaseSeconds(leaseSeconds: number): void {
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
    throw new Error('leaseSeconds must be a finite positive number.');
  }
}

async function runAtomicPurgeLeaseAcquisition(
  db: StudexoDatabase,
  params: {
    fileId: string;
    ownerUserId: string;
    leaseSeconds: number;
    requireUnreferenced: boolean;
  },
): Promise<FilePurgeLeaseResult> {
  assertValidLeaseSeconds(params.leaseSeconds);

  return db.transaction(
    async (tx): Promise<FilePurgeLeaseResult> => {
      const [locked] = await tx
        .select({
          ...STORED_FILE_LIFECYCLE_COLUMNS,
          isLeaseActive: sql<boolean>`(${storedFiles.purgeState} = 'purging' AND ${storedFiles.purgeLeaseUntil} IS NOT NULL AND ${storedFiles.purgeLeaseUntil} > pg_catalog.now())`,
        })
        .from(storedFiles)
        .where(
          and(
            eq(storedFiles.id, params.fileId),
            eq(storedFiles.ownerUserId, params.ownerUserId),
          ),
        )
        .limit(1)
        .for('update');

      if (!locked) {
        return {
          status: 'unavailable',
          reason: 'not_found',
          file: null,
        };
      }

      const lockedFile = toStoredFileLifecycleRecord(locked);

      if (
        locked.uploadStatus === 'deleted' ||
        locked.purgeState === 'purged' ||
        locked.purgeState === 'none'
      ) {
        return {
          status: 'unavailable',
          reason: 'not_eligible',
          file: lockedFile,
        };
      }

      if (locked.isLeaseActive) {
        return {
          status: 'unavailable',
          reason: 'active_lease',
          file: lockedFile,
        };
      }

      if (params.requireUnreferenced) {
        const [refCountRow] = await tx
          .select({
            count: sql<number>`count(${documentVersions.id})::int`,
          })
          .from(documentVersions)
          .where(
            and(
              eq(documentVersions.storedFileId, params.fileId),
              eq(documentVersions.userId, params.ownerUserId),
            ),
          );

        const blockingReferences = Number(refCountRow?.count ?? 0);
        if (blockingReferences > 0) {
          return {
            status: 'blocked_by_references',
            blockingReferences,
            file: lockedFile,
          };
        }
      }

      const updatedRows = await tx
        .update(storedFiles)
        .set({
          purgeState: 'purging',
          purgeLeaseUntil: sql`pg_catalog.now() + pg_catalog.make_interval(secs => ${params.leaseSeconds}::double precision)`,
          purgeAttempts: sql`${storedFiles.purgeAttempts} + 1`,
          updatedAt: sql`pg_catalog.now()`,
        })
        .where(
          and(
            eq(storedFiles.id, params.fileId),
            eq(storedFiles.ownerUserId, params.ownerUserId),
          ),
        )
        .returning(STORED_FILE_LIFECYCLE_COLUMNS);

      const updated = updatedRows[0];
      if (!updated) {
        throw new Error(
          `Expected 1 updated stored_files row when acquiring purge lease for ${params.fileId}, got ${updatedRows.length}.`,
        );
      }

      return {
        status: 'acquired',
        file: toStoredFileLifecycleRecord(updated),
      };
    },
    { isolationLevel: 'read committed' },
  );
}

/**
 * Concrete Drizzle PostgreSQL implementation of `FilePurgeWorkerRepository` scoped to
 * `studexo_purge_worker`'s least-privilege column grants (`docs/DATABASE_ROLES.md` Step 7).
 */
export function createPostgresFilePurgeWorkerRepository(
  db: StudexoDatabase,
): FilePurgeWorkerRepository {
  return {
    async getFileForPurge(fileId, ownerUserId) {
      const [row] = await db
        .select(STORED_FILE_LIFECYCLE_COLUMNS)
        .from(storedFiles)
        .where(and(eq(storedFiles.id, fileId), eq(storedFiles.ownerUserId, ownerUserId)))
        .limit(1);

      return row ? toStoredFileLifecycleRecord(row) : null;
    },

    async markFilePendingPurge(fileId, ownerUserId, requestedAt) {
      const requestedAtExpr = requestedAt ?? sql`pg_catalog.now()`;
      const [updated] = await db
        .update(storedFiles)
        .set({
          purgeState: 'pending_purge',
          purgeRequestedAt: sql`COALESCE(${storedFiles.purgeRequestedAt}, ${requestedAtExpr})`,
          updatedAt: sql`pg_catalog.now()`,
        })
        .where(
          and(
            eq(storedFiles.id, fileId),
            eq(storedFiles.ownerUserId, ownerUserId),
            inArray(storedFiles.purgeState, ['none', 'pending_purge']),
            ne(storedFiles.uploadStatus, 'deleted'),
          ),
        )
        .returning(STORED_FILE_LIFECYCLE_COLUMNS);

      return updated ? toStoredFileLifecycleRecord(updated) : null;
    },

    async acquireFilePurgeLeaseIfUnreferenced(fileId, ownerUserId, leaseSeconds) {
      return runAtomicPurgeLeaseAcquisition(db, {
        fileId,
        ownerUserId,
        leaseSeconds,
        requireUnreferenced: true,
      });
    },

    async acquireFilePurgeLease(fileId, ownerUserId, leaseSeconds) {
      const result = await runAtomicPurgeLeaseAcquisition(db, {
        fileId,
        ownerUserId,
        leaseSeconds,
        requireUnreferenced: false,
      });
      return result.status === 'acquired' ? result.file : null;
    },

    async markFilePurged(fileId, ownerUserId, completedAt) {
      const completedAtExpr = completedAt ?? sql`pg_catalog.now()`;
      const updatedRows = await db
        .update(storedFiles)
        .set({
          uploadStatus: 'deleted',
          purgeState: 'purged',
          deletedAt: sql`COALESCE(${storedFiles.deletedAt}, ${completedAtExpr})`,
          purgedAt: completedAtExpr,
          purgeLeaseUntil: null,
          updatedAt: sql`pg_catalog.now()`,
        })
        .where(
          and(
            eq(storedFiles.id, fileId),
            eq(storedFiles.ownerUserId, ownerUserId),
            eq(storedFiles.purgeState, 'purging'),
          ),
        )
        .returning({ id: storedFiles.id });

      if (updatedRows.length !== 1) {
        throw new Error(
          `Expected 1 updated stored_files row when marking ${fileId} purged, got ${updatedRows.length}.`,
        );
      }
    },

    async markFilePurgeFailed(fileId, ownerUserId, errorMessage) {
      const updatedRows = await db
        .update(storedFiles)
        .set({
          purgeState: 'purge_failed',
          purgeLeaseUntil: null,
          lastPurgeError: errorMessage,
          updatedAt: sql`pg_catalog.now()`,
        })
        .where(
          and(
            eq(storedFiles.id, fileId),
            eq(storedFiles.ownerUserId, ownerUserId),
            eq(storedFiles.purgeState, 'purging'),
          ),
        )
        .returning({ id: storedFiles.id });

      if (updatedRows.length !== 1) {
        throw new Error(
          `Expected 1 updated stored_files row when marking ${fileId} purge_failed, got ${updatedRows.length}.`,
        );
      }
    },

    async revertPendingPurgeToNone(fileId, ownerUserId) {
      await db.execute(
        sql`SELECT sf.id FROM studexo.revert_stored_file_deletion_request(${fileId}::uuid, ${ownerUserId}::uuid) AS sf`,
      );
    },

    async listDueFilesForPurge(limit = 10) {
      const rows = await db
        .select(STORED_FILE_LIFECYCLE_COLUMNS)
        .from(storedFiles)
        .where(
          and(
            inArray(storedFiles.purgeState, ['pending_purge', 'purge_failed']),
            ne(storedFiles.uploadStatus, 'deleted'),
            or(
              isNull(storedFiles.purgeLeaseUntil),
              sql`${storedFiles.purgeLeaseUntil} <= pg_catalog.now()`,
            ),
          ),
        )
        .orderBy(asc(storedFiles.purgeRequestedAt), asc(storedFiles.id))
        .limit(limit);

      return rows.map(toStoredFileLifecycleRecord);
    },

    async listExpiredPurgeLeases(limit = 10) {
      const rows = await db
        .select(STORED_FILE_LIFECYCLE_COLUMNS)
        .from(storedFiles)
        .where(
          and(
            eq(storedFiles.purgeState, 'purging'),
            sql`${storedFiles.purgeLeaseUntil} IS NOT NULL AND ${storedFiles.purgeLeaseUntil} <= pg_catalog.now()`,
          ),
        )
        .orderBy(asc(storedFiles.purgeLeaseUntil), asc(storedFiles.id))
        .limit(limit);

      return rows.map(toStoredFileLifecycleRecord);
    },
  };
}

/**
 * Concrete Drizzle PostgreSQL implementation of `FilePurgeLeaseRecoveryRepository` scoped to
 * `studexo_purge_worker`'s Step 7 column grants.
 */
export function createPostgresFilePurgeLeaseRecoveryRepository(
  db: StudexoDatabase,
): FilePurgeLeaseRecoveryRepository {
  return {
    async markExpiredPurgeLeaseFailed({ fileId, ownerUserId, errorMessage }) {
      const [updated] = await db
        .update(storedFiles)
        .set({
          purgeState: 'purge_failed',
          purgeLeaseUntil: null,
          lastPurgeError: errorMessage,
          updatedAt: sql`pg_catalog.now()`,
        })
        .where(
          and(
            eq(storedFiles.id, fileId),
            eq(storedFiles.ownerUserId, ownerUserId),
            eq(storedFiles.purgeState, 'purging'),
            or(
              isNull(storedFiles.purgeLeaseUntil),
              sql`${storedFiles.purgeLeaseUntil} <= pg_catalog.now()`,
            ),
          ),
        )
        .returning(STORED_FILE_LIFECYCLE_COLUMNS);

      return updated ? toStoredFileLifecycleRecord(updated) : null;
    },
  };
}
