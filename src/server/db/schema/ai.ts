import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { scholarshipApplications, universityApplications } from './applications';
import { documents, documentVersions } from './documents';
import {
  aiConversationStatusEnum,
  aiMessageRoleEnum,
  aiRunStatusEnum,
  studexoSchema,
} from './enums';
import { users } from './identity';
import { institutions } from './institutions';
import { studentQualifications, studentTestScores } from './profiles';
import { programmes } from './programmes';
import { scholarships } from './scholarships';

export const aiPromptVersions = studexoSchema.table(
  'ai_prompt_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    promptKey: varchar('prompt_key', { length: 120 }).notNull(),
    versionNumber: integer('version_number').notNull(),
    featureKey: varchar('feature_key', { length: 64 }).notNull(),
    modelName: varchar('model_name', { length: 120 }).notNull(),
    systemInstructionSummary: text('system_instruction_summary').notNull(),
    checksum: varchar('checksum', { length: 64 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('ai_prompt_versions_key_ver_uidx').on(table.promptKey, table.versionNumber),
    index('ai_prompt_versions_feature_active_idx').on(table.featureKey, table.isActive),
    check('ai_prompt_versions_number_positive_chk', sql`version_number >= 1`),
  ],
);

export const aiPermissions = studexoSchema.table(
  'ai_permissions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    featureKey: varchar('feature_key', { length: 64 }).notNull(),
    isAllowed: boolean('is_allowed').notNull().default(true),
    dailyRunQuota: integer('daily_run_quota').notNull().default(25),
    grantedByUserId: uuid('granted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('ai_permissions_user_feature_uidx').on(table.userId, table.featureKey),
    check('ai_permissions_quota_nonneg_chk', sql`daily_run_quota >= 0`),
  ],
);

export const aiConversations = studexoSchema.table(
  'ai_conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    featureKey: varchar('feature_key', { length: 64 }).notNull(),
    title: varchar('title', { length: 240 }),
    status: aiConversationStatusEnum('status').notNull().default('active'),
    universityApplicationId: uuid('university_application_id'),
    scholarshipApplicationId: uuid('scholarship_application_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'ai_conversations_uni_app_user_fk',
      columns: [table.universityApplicationId, table.userId],
      foreignColumns: [universityApplications.id, universityApplications.userId],
    }).onDelete('no action'),
    foreignKey({
      name: 'ai_conversations_sch_app_user_fk',
      columns: [table.scholarshipApplicationId, table.userId],
      foreignColumns: [scholarshipApplications.id, scholarshipApplications.userId],
    }).onDelete('no action'),
    unique('ai_conversations_id_user_uq').on(table.id, table.userId),
    index('ai_conversations_user_status_idx').on(table.userId, table.status),
    index('ai_conversations_uni_app_id_idx').on(table.universityApplicationId),
    index('ai_conversations_sch_app_id_idx').on(table.scholarshipApplicationId),
    check(
      'ai_conversations_at_most_one_target_chk',
      sql`((CASE WHEN university_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_application_id IS NOT NULL THEN 1 ELSE 0 END)) <= 1`,
    ),
  ],
);

export const aiMessages = studexoSchema.table(
  'ai_messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: aiMessageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'ai_messages_conversation_user_fk',
      columns: [table.conversationId, table.userId],
      foreignColumns: [aiConversations.id, aiConversations.userId],
    }).onDelete('cascade'),
    index('ai_messages_conversation_created_idx').on(table.conversationId, table.createdAt),
    index('ai_messages_user_id_idx').on(table.userId),
  ],
);

export const aiRuns = studexoSchema.table(
  'ai_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id'),
    promptVersionId: uuid('prompt_version_id').references(() => aiPromptVersions.id, {
      onDelete: 'set null',
    }),
    featureKey: varchar('feature_key', { length: 64 }).notNull(),
    modelName: varchar('model_name', { length: 120 }).notNull(),
    status: aiRunStatusEnum('status').notNull().default('queued'),
    requestId: varchar('request_id', { length: 120 }),
    latencyMs: integer('latency_ms'),
    errorCode: varchar('error_code', { length: 80 }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'ai_runs_conversation_user_fk',
      columns: [table.conversationId, table.userId],
      foreignColumns: [aiConversations.id, aiConversations.userId],
    }).onDelete('no action'),
    unique('ai_runs_id_user_uq').on(table.id, table.userId),
    index('ai_runs_user_created_idx').on(table.userId, table.createdAt),
    index('ai_runs_status_idx').on(table.status),
    index('ai_runs_conversation_id_idx').on(table.conversationId),
    check('ai_runs_latency_nonneg_chk', sql`latency_ms IS NULL OR latency_ms >= 0`),
  ],
);

export const aiUsageRecords = studexoSchema.table(
  'ai_usage_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    aiRunId: uuid('ai_run_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    modelName: varchar('model_name', { length: 120 }).notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    estimatedCostUsd: numeric('estimated_cost_usd', { precision: 12, scale: 6 })
      .notNull()
      .default('0.000000'),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'ai_usage_records_run_user_fk',
      columns: [table.aiRunId, table.userId],
      foreignColumns: [aiRuns.id, aiRuns.userId],
    }).onDelete('cascade'),
    uniqueIndex('ai_usage_records_run_id_uidx').on(table.aiRunId),
    index('ai_usage_records_user_recorded_idx').on(table.userId, table.recordedAt),
    check('ai_usage_records_prompt_tokens_nonneg_chk', sql`prompt_tokens >= 0`),
    check('ai_usage_records_completion_tokens_nonneg_chk', sql`completion_tokens >= 0`),
    check('ai_usage_records_total_tokens_nonneg_chk', sql`total_tokens >= 0`),
  ],
);

export const aiRunContextLinks = studexoSchema.table(
  'ai_run_context_links',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    aiRunId: uuid('ai_run_id').notNull(),
    documentId: uuid('document_id'),
    documentVersionId: uuid('document_version_id'),
    universityApplicationId: uuid('university_application_id'),
    scholarshipApplicationId: uuid('scholarship_application_id'),
    studentQualificationId: uuid('student_qualification_id'),
    studentTestScoreId: uuid('student_test_score_id'),
    institutionId: uuid('institution_id').references(() => institutions.id, {
      onDelete: 'cascade',
    }),
    programmeId: uuid('programme_id').references(() => programmes.id, {
      onDelete: 'cascade',
    }),
    scholarshipId: uuid('scholarship_id').references(() => scholarships.id, {
      onDelete: 'cascade',
    }),
    contextRole: varchar('context_role', { length: 32 }).notNull().default('grounding'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'ai_run_context_links_run_user_fk',
      columns: [table.aiRunId, table.userId],
      foreignColumns: [aiRuns.id, aiRuns.userId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ai_run_context_links_doc_user_fk',
      columns: [table.documentId, table.userId],
      foreignColumns: [documents.id, documents.userId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ai_run_context_links_doc_ver_user_fk',
      columns: [table.documentVersionId, table.userId],
      foreignColumns: [documentVersions.id, documentVersions.userId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ai_run_context_links_uni_app_user_fk',
      columns: [table.universityApplicationId, table.userId],
      foreignColumns: [universityApplications.id, universityApplications.userId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ai_run_context_links_sch_app_user_fk',
      columns: [table.scholarshipApplicationId, table.userId],
      foreignColumns: [scholarshipApplications.id, scholarshipApplications.userId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ai_run_context_links_qual_user_fk',
      columns: [table.studentQualificationId, table.userId],
      foreignColumns: [studentQualifications.id, studentQualifications.userId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ai_run_context_links_test_score_user_fk',
      columns: [table.studentTestScoreId, table.userId],
      foreignColumns: [studentTestScores.id, studentTestScores.userId],
    }).onDelete('cascade'),
    index('ai_run_context_links_run_id_idx').on(table.aiRunId),
    index('ai_run_context_links_user_id_idx').on(table.userId),
    check(
      'ai_run_context_links_role_chk',
      sql`context_role IN ('grounding', 'primary_subject', 'comparison', 'user_attachment')`,
    ),
    check(
      'ai_run_context_links_single_target_chk',
      sql`((CASE WHEN document_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN document_version_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN university_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN student_qualification_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN student_test_score_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN institution_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN programme_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_id IS NOT NULL THEN 1 ELSE 0 END)) = 1`,
    ),
  ],
);
