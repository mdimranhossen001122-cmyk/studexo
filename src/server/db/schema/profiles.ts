import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { documentVersions } from './documents';
import {
  experienceTypeEnum,
  fundingNeedEnum,
  qualificationLevelEnum,
  scoreStatusEnum,
  studexoSchema,
  studyLevelEnum,
  userRoleEnum,
} from './enums';
import { users } from './identity';
import { gradingScales, testCatalog } from './reference';

export const studentProfiles = studexoSchema.table(
  'student_profiles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    countryOfCitizenship: varchar('country_of_citizenship', { length: 2 }),
    countryOfResidence: varchar('country_of_residence', { length: 2 }),
    city: varchar('city', { length: 120 }),
    birthYear: smallint('birth_year'),
    targetStudyLevel: studyLevelEnum('target_study_level'),
    targetIntakeTerm: varchar('target_intake_term', { length: 32 }),
    targetCountries: jsonb('target_countries').$type<string[]>().notNull().default([]),
    preferredFieldOfStudy: varchar('preferred_field_of_study', { length: 160 }),
    annualBudgetAmount: numeric('annual_budget_amount', { precision: 14, scale: 2 }),
    annualBudgetCurrency: varchar('annual_budget_currency', { length: 3 }),
    fundingNeed: fundingNeedEnum('funding_need'),
    onboardingCompletedAt: timestamp('onboarding_completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('student_profiles_user_id_uidx').on(table.userId),
    index('student_profiles_citizenship_idx').on(table.countryOfCitizenship),
    check(
      'student_profiles_birth_year_chk',
      sql`birth_year IS NULL OR (birth_year >= 1000 AND birth_year <= 9999)`,
    ),
    check(
      'student_profiles_budget_nonneg_chk',
      sql`annual_budget_amount IS NULL OR annual_budget_amount >= 0`,
    ),
    check(
      'student_profiles_budget_currency_chk',
      sql`annual_budget_amount IS NULL OR annual_budget_currency IS NOT NULL`,
    ),
  ],
);

const credentialProvenanceColumns = {
  verificationMethod: varchar('verification_method', { length: 32 })
    .notNull()
    .default('self_reported'),
  isVerified: boolean('is_verified').notNull().default(false),
  verifiedByUserId: uuid('verified_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  verifiedByRole: userRoleEnum('verified_by_role'),
  verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
  evidenceDocumentVersionId: uuid('evidence_document_version_id'),
  externalReferenceUrl: text('external_reference_url'),
  verificationValidUntil: timestamp('verification_valid_until', {
    withTimezone: true,
    mode: 'date',
  }),
};

function buildCredentialProvenanceChecks(prefix: string) {
  return [
    check(
      `${prefix}_verification_method_chk`,
      sql`verification_method IN ('self_reported', 'document_evidence', 'official_api', 'counselor_attested', 'admin_verified')`,
    ),
    check(
      `${prefix}_self_reported_not_verified_chk`,
      sql`verification_method <> 'self_reported' OR is_verified = false`,
    ),
    check(
      `${prefix}_verified_at_required_chk`,
      sql`is_verified = false OR verified_at IS NOT NULL`,
    ),
    check(
      `${prefix}_verifier_role_chk`,
      sql`verification_method NOT IN ('document_evidence', 'admin_verified') OR is_verified = false OR verified_by_role IN ('counselor', 'admin')`,
    ),
    check(
      `${prefix}_counselor_role_chk`,
      sql`verification_method <> 'counselor_attested' OR is_verified = false OR verified_by_role = 'counselor'`,
    ),
    check(
      `${prefix}_document_evidence_required_chk`,
      sql`verification_method <> 'document_evidence' OR evidence_document_version_id IS NOT NULL`,
    ),
  ];
}

export const studentQualifications = studexoSchema.table(
  'student_qualifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    qualificationLevel: qualificationLevelEnum('qualification_level').notNull(),
    boardOrInstitution: varchar('board_or_institution', { length: 200 }).notNull(),
    countryCode: varchar('country_code', { length: 2 }).notNull(),
    fieldOfStudy: varchar('field_of_study', { length: 160 }),
    gradingScaleCode: varchar('grading_scale_code', { length: 64 })
      .notNull()
      .references(() => gradingScales.code, { onDelete: 'restrict' }),
    scoreValue: numeric('score_value', { precision: 6, scale: 2 }),
    maxScoreValue: numeric('max_score_value', { precision: 6, scale: 2 }),
    completionYear: integer('completion_year'),
    isCompleted: boolean('is_completed').notNull().default(true),
    ...credentialProvenanceColumns,
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'student_qualifications_evidence_doc_ver_user_fk',
      columns: [table.evidenceDocumentVersionId, table.userId],
      foreignColumns: [documentVersions.id, documentVersions.userId],
    }).onDelete('no action'),
    unique('student_qualifications_id_user_uq').on(table.id, table.userId),
    index('student_qualifications_user_id_idx').on(table.userId),
    index('student_qualifications_user_level_idx').on(table.userId, table.qualificationLevel),
    index('student_qualifications_grading_scale_idx').on(table.gradingScaleCode),
    check('student_qualifications_score_nonneg_chk', sql`score_value IS NULL OR score_value >= 0`),
    check(
      'student_qualifications_max_score_pos_chk',
      sql`max_score_value IS NULL OR max_score_value > 0`,
    ),
    check(
      'student_qualifications_score_bounds_chk',
      sql`score_value IS NULL OR max_score_value IS NULL OR score_value <= max_score_value`,
    ),
    ...buildCredentialProvenanceChecks('student_qualifications'),
  ],
);

export type TestSubscores = Record<string, number>;

export const studentTestScores = studexoSchema.table(
  'student_test_scores',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    testCode: varchar('test_code', { length: 64 })
      .notNull()
      .references(() => testCatalog.code, { onDelete: 'restrict' }),
    scoreStatus: scoreStatusEnum('score_status').notNull().default('reported'),
    overallScore: numeric('overall_score', { precision: 6, scale: 2 }),
    subscores: jsonb('subscores').$type<TestSubscores>(),
    plannedTestDate: date('planned_test_date', { mode: 'string' }),
    testDate: date('test_date', { mode: 'string' }),
    expiresAt: date('expires_at', { mode: 'string' }),
    waiverReason: text('waiver_reason'),
    ...credentialProvenanceColumns,
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'student_test_scores_evidence_doc_ver_user_fk',
      columns: [table.evidenceDocumentVersionId, table.userId],
      foreignColumns: [documentVersions.id, documentVersions.userId],
    }).onDelete('no action'),
    unique('student_test_scores_id_user_uq').on(table.id, table.userId),
    uniqueIndex('student_test_scores_user_test_placeholder_uidx')
      .on(table.userId, table.testCode)
      .where(sql`score_status IN ('not_tested', 'not_applicable', 'unknown')`),
    index('student_test_scores_user_id_idx').on(table.userId),
    index('student_test_scores_user_test_idx').on(table.userId, table.testCode),
    check(
      'student_test_scores_numeric_gate_chk',
      sql`(test_code <> 'moi' AND score_status = 'reported') OR (overall_score IS NULL AND subscores IS NULL)`,
    ),
    check(
      'student_test_scores_overall_nonneg_chk',
      sql`overall_score IS NULL OR overall_score >= 0`,
    ),
    check(
      'student_test_scores_reported_score_chk',
      sql`score_status <> 'reported' OR test_code = 'moi' OR overall_score IS NOT NULL`,
    ),
    check(
      'student_test_scores_waiver_reason_chk',
      sql`score_status <> 'waived' OR waiver_reason IS NOT NULL`,
    ),
    ...buildCredentialProvenanceChecks('student_test_scores'),
  ],
);

export const studentExperiences = studexoSchema.table(
  'student_experiences',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    experienceType: experienceTypeEnum('experience_type').notNull(),
    organizationName: varchar('organization_name', { length: 200 }).notNull(),
    roleTitle: varchar('role_title', { length: 160 }).notNull(),
    countryCode: varchar('country_code', { length: 2 }),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    isCurrent: boolean('is_current').notNull().default(false),
    description: text('description'),
    ...credentialProvenanceColumns,
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'student_experiences_evidence_doc_ver_user_fk',
      columns: [table.evidenceDocumentVersionId, table.userId],
      foreignColumns: [documentVersions.id, documentVersions.userId],
    }).onDelete('no action'),
    unique('student_experiences_id_user_uq').on(table.id, table.userId),
    index('student_experiences_user_type_idx').on(table.userId, table.experienceType),
    check(
      'student_experiences_date_order_chk',
      sql`end_date IS NULL OR start_date IS NULL OR end_date >= start_date`,
    ),
    check(
      'student_experiences_current_end_null_chk',
      sql`is_current = false OR end_date IS NULL`,
    ),
    ...buildCredentialProvenanceChecks('student_experiences'),
  ],
);

export const studentPublicationsAndProjects = studexoSchema.table(
  'student_publications_and_projects',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    itemType: varchar('item_type', { length: 32 }).notNull(),
    title: varchar('title', { length: 240 }).notNull(),
    venueOrPlatform: varchar('venue_or_platform', { length: 200 }),
    publishedOrCompletedAt: date('published_or_completed_at', { mode: 'string' }),
    url: text('url'),
    summary: text('summary'),
    ...credentialProvenanceColumns,
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'student_pub_proj_evidence_doc_ver_user_fk',
      columns: [table.evidenceDocumentVersionId, table.userId],
      foreignColumns: [documentVersions.id, documentVersions.userId],
    }).onDelete('no action'),
    unique('student_pub_proj_id_user_uq').on(table.id, table.userId),
    index('student_pub_proj_user_type_idx').on(table.userId, table.itemType),
    check(
      'student_pub_proj_item_type_chk',
      sql`item_type IN ('publication', 'research_paper', 'project', 'patent', 'award')`,
    ),
    ...buildCredentialProvenanceChecks('student_pub_proj'),
  ],
);
