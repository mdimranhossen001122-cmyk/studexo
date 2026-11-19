import { and, eq, sql } from 'drizzle-orm';
import type { StudexoDatabase } from '../../db/client';
import { storedFiles } from '../../db/schema/documents';
import { STORED_FILE_LIFECYCLE_COLUMNS } from './postgresFilePurgeRepository';
import type {
  FileDeletionRequestRepository,
  StoredFileLifecycleRecord,
} from './storageAndPurge';

type ProjectedStoredFileRow = {
  id: string;
  ownerUserId: string;
  storageBucket: string;
  objectKey: string;
  uploadStatus: StoredFileLifecycleRecord['uploadStatus'];
  purgeState: StoredFileLifecycleRecord['purgeState'];
  deletedAt: Date | string | null;
  deletedByUserId: string | null;
  purgedAt: Date | string | null;
  purgeAttempts: number | string;
  purgeLeaseUntil: Date | string | null;
  lastPurgeError: string | null;
};

function normalizeNullableDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  return new Date(value);
}

function toStoredFileLifecycleRecord(row: ProjectedStoredFileRow): StoredFileLifecycleRecord {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    storageBucket: row.storageBucket,
    objectKey: row.objectKey,
    uploadStatus: row.uploadStatus,
    purgeState: row.purgeState,
    deletedAt: normalizeNullableDate(row.deletedAt),
    deletedByUserId: row.deletedByUserId ?? null,
    purgedAt: normalizeNullableDate(row.purgedAt),
    purgeAttempts:
      typeof row.purgeAttempts === 'number'
        ? row.purgeAttempts
        : Number(row.purgeAttempts),
    purgeLeaseUntil: normalizeNullableDate(row.purgeLeaseUntil),
    lastPurgeError: row.lastPurgeError ?? null,
  };
}

function extractPostgresError(error: unknown): { code?: string; message: string } {
  if (!error || typeof error !== 'object') {
    return { message: String(error) };
  }

  const record = error as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };

  if (typeof record.code === 'string' && record.code.length > 0) {
    return {
      code: record.code,
      message: typeof record.message === 'string' ? record.message : String(error),
    };
  }

  if (record.cause && typeof record.cause === 'object') {
    const causeRecord = record.cause as {
      code?: unknown;
      message?: unknown;
    };
    if (typeof causeRecord.code === 'string' && causeRecord.code.length > 0) {
      return {
        code: causeRecord.code,
        message:
          typeof causeRecord.message === 'string'
            ? causeRecord.message
            : typeof record.message === 'string'
              ? record.message
              : String(error),
      };
    }
  }

  return {
    message: typeof record.message === 'string' ? record.message : String(error),
  };
}

function isConcurrentOrMissingFileStateError(error: unknown): boolean {
  const { code, message } = extractPostgresError(error);

  if (
    code === '22023' &&
    message.includes('Target stored_files row') &&
    message.includes('does not exist')
  ) {
    return true;
  }

  if (
    code === '23514' &&
    message.includes('is already deleted, purged, or pending purge')
  ) {
    return true;
  }

  return false;
}

/**
 * Concrete PostgreSQL Stage 1 (`studexo_app`) repository for draft stored-file deletion requests.
 *
 * Strictly isolated from `FilePurgeWorkerRepository` and `StorageObjectAdapter`:
 * - Uses explicit 12-column projections (`STORED_FILE_LIFECYCLE_COLUMNS`).
 * - Delegates state mutation and attribution exclusively to the `SECURITY DEFINER` function
 *   `studexo.request_stored_file_deletion(p_file_id, p_actor_user_id)` inside a
 *   `READ COMMITTED` transaction, preserving `studexo_app` least-privilege boundaries
 *   (no direct `UPDATE` on `purge_state`, `deleted_by_user_id`, or `purge_requested_at`).
 * - Returns `null` when the target file no longer exists or has already transitioned out of
 *   `purge_state = 'none'` concurrently (`Option 1A`), while rethrowing reference-blocking
 *   (`23514`), actor-eligibility (`23503` / `23514`), and authorization (`42501`) errors.
 */
export function createPostgresFileDeletionRequestRepository(
  db: StudexoDatabase,
): FileDeletionRequestRepository {
  return {
    async getOwnedFile(
      fileId: string,
      ownerUserId: string,
    ): Promise<StoredFileLifecycleRecord | null> {
      const [row] = await db
        .select(STORED_FILE_LIFECYCLE_COLUMNS)
        .from(storedFiles)
        .where(
          and(
            eq(storedFiles.id, fileId),
            eq(storedFiles.ownerUserId, ownerUserId),
          ),
        )
        .limit(1);

      return row ? toStoredFileLifecycleRecord(row) : null;
    },

    async requestFileDeletion(
      fileId: string,
      actorUserId: string,
    ): Promise<StoredFileLifecycleRecord | null> {
      try {
        return await db.transaction(
          async (tx): Promise<StoredFileLifecycleRecord | null> => {
            const rows = await tx.execute<ProjectedStoredFileRow>(sql`
              SELECT
                sf.id AS "id",
                sf.owner_user_id AS "ownerUserId",
                sf.storage_bucket AS "storageBucket",
                sf.object_key AS "objectKey",
                sf.upload_status AS "uploadStatus",
                sf.purge_state AS "purgeState",
                sf.deleted_at AS "deletedAt",
                sf.deleted_by_user_id AS "deletedByUserId",
                sf.purged_at AS "purgedAt",
                sf.purge_attempts AS "purgeAttempts",
                sf.purge_lease_until AS "purgeLeaseUntil",
                sf.last_purge_error AS "lastPurgeError"
              FROM studexo.request_stored_file_deletion(${fileId}::uuid, ${actorUserId}::uuid) AS sf
            `);

            const updated = rows[0];
            return updated ? toStoredFileLifecycleRecord(updated) : null;
          },
          { isolationLevel: 'read committed' },
        );
      } catch (error) {
        if (isConcurrentOrMissingFileStateError(error)) {
          return null;
        }
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
    },
  };
}
