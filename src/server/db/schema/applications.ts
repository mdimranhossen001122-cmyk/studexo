import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { documents, documentVersions } from './documents';
import {
  applicationDocumentStateEnum,
  applicationStatusEnum,
  studexoSchema,
} from './enums';
import { users } from './identity';
import { institutions } from './institutions';
import { programmeIntakes, programmes } from './programmes';
import { scholarshipIntakes, scholarships } from './scholarships';

export const savedOpportunities = studexoSchema.table(
  'saved_opportunities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    programmeId: uuid('programme_id').references(() => programmes.id, {
      onDelete: 'cascade',
    }),
    scholarshipId: uuid('scholarship_id').references(() => scholarships.id, {
      onDelete: 'cascade',
    }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('saved_opportunities_user_prog_uidx')
      .on(table.userId, table.programmeId)
      .where(sql`programme_id IS NOT NULL`),
    uniqueIndex('saved_opportunities_user_sch_uidx')
      .on(table.userId, table.scholarshipId)
      .where(sql`scholarship_id IS NOT NULL`),
    index('saved_opportunities_user_id_idx').on(table.userId),
    check(
      'saved_opportunities_single_target_chk',
      sql`((CASE WHEN programme_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_id IS NOT NULL THEN 1 ELSE 0 END)) = 1`,
    ),
  ],
);

export const universityApplications = studexoSchema.table(
  'university_applications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    programmeId: uuid('programme_id')
      .notNull()
      .references(() => programmes.id, { onDelete: 'restrict' }),
    programmeIntakeId: uuid('programme_intake_id'),
    status: applicationStatusEnum('status').notNull().default('shortlisted'),
    portalReference: varchar('portal_reference', { length: 120 }),
    targetSubmissionAt: timestamp('target_submission_at', { withTimezone: true, mode: 'date' }),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
    decisionAt: timestamp('decision_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'university_applications_programme_inst_fk',
      columns: [table.programmeId, table.institutionId],
      foreignColumns: [programmes.id, programmes.institutionId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'university_applications_intake_prog_fk',
      columns: [table.programmeIntakeId, table.programmeId],
      foreignColumns: [programmeIntakes.id, programmeIntakes.programmeId],
    }).onDelete('restrict'),
    unique('university_applications_id_user_uq').on(table.id, table.userId),
    uniqueIndex('university_applications_active_prog_intake_uidx')
      .on(table.userId, table.programmeId, table.programmeIntakeId)
      .where(sql`programme_intake_id IS NOT NULL AND status NOT IN ('rejected', 'withdrawn')`),
    uniqueIndex('university_applications_active_prog_no_intake_uidx')
      .on(table.userId, table.programmeId)
      .where(sql`programme_intake_id IS NULL AND status NOT IN ('rejected', 'withdrawn')`),
    index('university_applications_user_status_idx').on(table.userId, table.status),
    index('university_applications_institution_id_idx').on(table.institutionId),
    index('university_applications_programme_id_idx').on(table.programmeId),
    index('university_applications_intake_id_idx').on(table.programmeIntakeId),
  ],
);

export const scholarshipApplications = studexoSchema.table(
  'scholarship_applications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scholarshipId: uuid('scholarship_id')
      .notNull()
      .references(() => scholarships.id, { onDelete: 'restrict' }),
    scholarshipIntakeId: uuid('scholarship_intake_id'),
    universityApplicationId: uuid('university_application_id'),
    status: applicationStatusEnum('status').notNull().default('shortlisted'),
    portalReference: varchar('portal_reference', { length: 120 }),
    targetSubmissionAt: timestamp('target_submission_at', { withTimezone: true, mode: 'date' }),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
    decisionAt: timestamp('decision_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'scholarship_applications_intake_sch_fk',
      columns: [table.scholarshipIntakeId, table.scholarshipId],
      foreignColumns: [scholarshipIntakes.id, scholarshipIntakes.scholarshipId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'scholarship_applications_uni_app_user_fk',
      columns: [table.universityApplicationId, table.userId],
      foreignColumns: [universityApplications.id, universityApplications.userId],
    }).onDelete('no action'),
    unique('scholarship_applications_id_user_uq').on(table.id, table.userId),
    uniqueIndex('scholarship_applications_active_sch_intake_uidx')
      .on(table.userId, table.scholarshipId, table.scholarshipIntakeId)
      .where(sql`scholarship_intake_id IS NOT NULL AND status NOT IN ('rejected', 'withdrawn')`),
    uniqueIndex('scholarship_applications_active_sch_no_intake_uidx')
      .on(table.userId, table.scholarshipId)
      .where(sql`scholarship_intake_id IS NULL AND status NOT IN ('rejected', 'withdrawn')`),
    index('scholarship_applications_user_status_idx').on(table.userId, table.status),
    index('scholarship_applications_scholarship_id_idx').on(table.scholarshipId),
    index('scholarship_applications_intake_id_idx').on(table.scholarshipIntakeId),
    index('scholarship_applications_uni_app_id_idx').on(table.universityApplicationId),
  ],
);

export const applicationDocuments = studexoSchema.table(
  'application_documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    universityApplicationId: uuid('university_application_id'),
    scholarshipApplicationId: uuid('scholarship_application_id'),
    documentId: uuid('document_id').notNull(),
    documentVersionId: uuid('document_version_id').notNull(),
    documentState: applicationDocumentStateEnum('document_state')
      .notNull()
      .default('attached'),
    replacedById: uuid('replaced_by_id'),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true, mode: 'date' }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'application_documents_uni_app_user_fk',
      columns: [table.universityApplicationId, table.userId],
      foreignColumns: [universityApplications.id, universityApplications.userId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'application_documents_sch_app_user_fk',
      columns: [table.scholarshipApplicationId, table.userId],
      foreignColumns: [scholarshipApplications.id, scholarshipApplications.userId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'application_documents_document_user_fk',
      columns: [table.documentId, table.userId],
      foreignColumns: [documents.id, documents.userId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'application_documents_doc_version_doc_user_fk',
      columns: [table.documentVersionId, table.documentId, table.userId],
      foreignColumns: [
        documentVersions.id,
        documentVersions.documentId,
        documentVersions.userId,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'application_documents_replaced_by_user_fk',
      columns: [table.replacedById, table.userId],
      foreignColumns: [table.id, table.userId],
    }).onDelete('no action'),
    unique('application_documents_id_user_uq').on(table.id, table.userId),
    uniqueIndex('application_documents_replaced_by_uidx')
      .on(table.replacedById)
      .where(sql`replaced_by_id IS NOT NULL`),
    uniqueIndex('application_documents_active_uni_doc_uidx')
      .on(table.universityApplicationId, table.documentId)
      .where(
        sql`university_application_id IS NOT NULL AND document_state IN ('attached', 'verified', 'submitted')`,
      ),
    uniqueIndex('application_documents_active_sch_doc_uidx')
      .on(table.scholarshipApplicationId, table.documentId)
      .where(
        sql`scholarship_application_id IS NOT NULL AND document_state IN ('attached', 'verified', 'submitted')`,
      ),
    index('application_documents_user_state_idx').on(table.userId, table.documentState),
    index('application_documents_doc_version_id_idx').on(table.documentVersionId),
    check(
      'application_documents_single_target_chk',
      sql`((CASE WHEN university_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_application_id IS NOT NULL THEN 1 ELSE 0 END)) = 1`,
    ),
    check(
      'application_documents_not_self_replaced_chk',
      sql`replaced_by_id IS NULL OR replaced_by_id <> id`,
    ),
    check(
      'application_documents_replacement_state_chk',
      sql`(document_state <> 'replaced' AND replaced_by_id IS NULL) OR (document_state = 'replaced' AND replaced_by_id IS NOT NULL)`,
    ),
    check(
      'application_documents_submitted_at_chk',
      sql`document_state <> 'submitted' OR submitted_at IS NOT NULL`,
    ),
    check(
      'application_documents_withdrawn_at_chk',
      sql`document_state <> 'withdrawn' OR withdrawn_at IS NOT NULL`,
    ),
  ],
);

export const applicationChecklists = studexoSchema.table(
  'application_checklists',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    universityApplicationId: uuid('university_application_id'),
    scholarshipApplicationId: uuid('scholarship_application_id'),
    title: varchar('title', { length: 240 }).notNull(),
    description: text('description'),
    isCompleted: boolean('is_completed').notNull().default(false),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }),
    sortOrder: integer('sort_order').notNull().default(0),
    linkedDocumentId: uuid('linked_document_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'application_checklists_uni_app_user_fk',
      columns: [table.universityApplicationId, table.userId],
      foreignColumns: [universityApplications.id, universityApplications.userId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'application_checklists_sch_app_user_fk',
      columns: [table.scholarshipApplicationId, table.userId],
      foreignColumns: [scholarshipApplications.id, scholarshipApplications.userId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'application_checklists_linked_doc_user_fk',
      columns: [table.linkedDocumentId, table.userId],
      foreignColumns: [documents.id, documents.userId],
    }).onDelete('no action'),
    index('application_checklists_uni_app_id_idx').on(table.universityApplicationId),
    index('application_checklists_sch_app_id_idx').on(table.scholarshipApplicationId),
    index('application_checklists_user_id_idx').on(table.userId),
    check(
      'application_checklists_single_target_chk',
      sql`((CASE WHEN university_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_application_id IS NOT NULL THEN 1 ELSE 0 END)) = 1`,
    ),
  ],
);

export const applicationNotes = studexoSchema.table(
  'application_notes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    universityApplicationId: uuid('university_application_id'),
    scholarshipApplicationId: uuid('scholarship_application_id'),
    authorUserId: uuid('author_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull(),
    isPinned: boolean('is_pinned').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'application_notes_uni_app_user_fk',
      columns: [table.universityApplicationId, table.userId],
      foreignColumns: [universityApplications.id, universityApplications.userId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'application_notes_sch_app_user_fk',
      columns: [table.scholarshipApplicationId, table.userId],
      foreignColumns: [scholarshipApplications.id, scholarshipApplications.userId],
    }).onDelete('cascade'),
    index('application_notes_uni_app_id_idx').on(table.universityApplicationId),
    index('application_notes_sch_app_id_idx').on(table.scholarshipApplicationId),
    index('application_notes_user_id_idx').on(table.userId),
    check(
      'application_notes_single_target_chk',
      sql`((CASE WHEN university_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_application_id IS NOT NULL THEN 1 ELSE 0 END)) = 1`,
    ),
  ],
);

export const applicationStatusHistory = studexoSchema.table(
  'application_status_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    universityApplicationId: uuid('university_application_id'),
    scholarshipApplicationId: uuid('scholarship_application_id'),
    fromStatus: applicationStatusEnum('from_status'),
    toStatus: applicationStatusEnum('to_status').notNull(),
    changedByUserId: uuid('changed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reason: text('reason'),
    changedAt: timestamp('changed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'application_status_history_uni_app_user_fk',
      columns: [table.universityApplicationId, table.userId],
      foreignColumns: [universityApplications.id, universityApplications.userId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'application_status_history_sch_app_user_fk',
      columns: [table.scholarshipApplicationId, table.userId],
      foreignColumns: [scholarshipApplications.id, scholarshipApplications.userId],
    }).onDelete('cascade'),
    index('application_status_history_user_changed_idx').on(table.userId, table.changedAt),
    index('application_status_history_uni_app_idx').on(
      table.universityApplicationId,
      table.changedAt,
    ),
    index('application_status_history_sch_app_idx').on(
      table.scholarshipApplicationId,
      table.changedAt,
    ),
    check(
      'application_status_history_single_target_chk',
      sql`((CASE WHEN university_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_application_id IS NOT NULL THEN 1 ELSE 0 END)) = 1`,
    ),
  ],
);
