import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { documentStatusEnum, fileUploadStatusEnum, purgeStateEnum, studexoSchema } from './enums';
import { users } from './identity';

export const storedFiles = studexoSchema.table(
  'stored_files',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // RESTRICT prevents deleting a user while any stored_files row (or unconfirmed Storage object) remains.
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    storageProvider: varchar('storage_provider', { length: 32 })
      .notNull()
      .default('supabase_storage'),
    storageBucket: varchar('storage_bucket', { length: 120 }).notNull(),
    objectKey: text('object_key').notNull(),
    originalFilename: varchar('original_filename', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 160 }).notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    sha256Checksum: varchar('sha256_checksum', { length: 64 }),
    visibility: varchar('visibility', { length: 16 }).notNull().default('private'),
    uploadStatus: fileUploadStatusEnum('upload_status').notNull().default('pending'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true, mode: 'date' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    purgeState: purgeStateEnum('purge_state').notNull().default('none'),
    purgeRequestedAt: timestamp('purge_requested_at', { withTimezone: true, mode: 'date' }),
    purgeLeaseUntil: timestamp('purge_lease_until', { withTimezone: true, mode: 'date' }),
    purgeAttempts: integer('purge_attempts').notNull().default(0),
    lastPurgeError: text('last_purge_error'),
    purgedAt: timestamp('purged_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('stored_files_id_owner_uq').on(table.id, table.ownerUserId),
    uniqueIndex('stored_files_bucket_key_uidx').on(table.storageBucket, table.objectKey),
    index('stored_files_owner_status_idx').on(table.ownerUserId, table.uploadStatus),
    index('stored_files_purge_state_lease_idx').on(table.purgeState, table.purgeLeaseUntil),
    check('stored_files_visibility_private_chk', sql`visibility = 'private'`),
    check('stored_files_byte_size_nonneg_chk', sql`byte_size >= 0`),
    check('stored_files_purge_attempts_nonneg_chk', sql`purge_attempts >= 0`),
    check(
      'stored_files_deleted_at_consistency_chk',
      sql`upload_status <> 'deleted' OR deleted_at IS NOT NULL`,
    ),
    check(
      'stored_files_purged_at_consistency_chk',
      sql`(purge_state = 'purged' AND purged_at IS NOT NULL) OR (purge_state <> 'purged' AND purged_at IS NULL)`,
    ),
  ],
);

export const documents = studexoSchema.table(
  'documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    documentType: varchar('document_type', { length: 64 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    status: documentStatusEnum('status').notNull().default('active'),
    currentVersionNumber: integer('current_version_number').notNull().default(1),
    description: text('description'),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
    archivedByUserId: uuid('archived_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('documents_id_user_uq').on(table.id, table.userId),
    index('documents_user_type_idx').on(table.userId, table.documentType),
    index('documents_user_status_idx').on(table.userId, table.status),
    check('documents_current_version_positive_chk', sql`current_version_number >= 1`),
    check(
      'documents_archived_at_consistency_chk',
      sql`status <> 'archived' OR archived_at IS NOT NULL`,
    ),
  ],
);

export const documentVersions = studexoSchema.table(
  'document_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    documentId: uuid('document_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    storedFileId: uuid('stored_file_id').notNull(),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    versionNumber: integer('version_number').notNull(),
    changeSummary: text('change_summary'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'document_versions_document_user_fk',
      columns: [table.documentId, table.userId],
      foreignColumns: [documents.id, documents.userId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'document_versions_stored_file_user_fk',
      columns: [table.storedFileId, table.userId],
      foreignColumns: [storedFiles.id, storedFiles.ownerUserId],
    }).onDelete('restrict'),
    unique('document_versions_id_user_uq').on(table.id, table.userId),
    unique('document_versions_id_doc_user_uq').on(table.id, table.documentId, table.userId),
    uniqueIndex('document_versions_doc_version_uidx').on(table.documentId, table.versionNumber),
    index('document_versions_stored_file_id_idx').on(table.storedFileId),
    index('document_versions_user_id_idx').on(table.userId),
    check('document_versions_number_positive_chk', sql`version_number >= 1`),
  ],
);
