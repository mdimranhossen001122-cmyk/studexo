import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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
import {
  deliveryModeEnum,
  feeTypeEnum,
  intakeTermEnum,
  requirementTypeEnum,
  studentResidencyCategoryEnum,
  studexoSchema,
  studyLevelEnum,
  verificationStatusEnum,
} from './enums';
import { institutions } from './institutions';
import { gradingScales, testCatalog } from './reference';

export const programmes = studexoSchema.table(
  'programmes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    slug: varchar('slug', { length: 180 }).notNull(),
    title: varchar('title', { length: 240 }).notNull(),
    studyLevel: studyLevelEnum('study_level').notNull(),
    discipline: varchar('discipline', { length: 140 }).notNull(),
    deliveryMode: deliveryModeEnum('delivery_mode').notNull().default('on_campus'),
    durationMonths: integer('duration_months').notNull(),
    languageOfInstruction: varchar('language_of_instruction', { length: 16 })
      .notNull()
      .default('en'),
    officialUrl: text('official_url'),
    verificationStatus: verificationStatusEnum('verification_status')
      .notNull()
      .default('unverified'),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true, mode: 'date' }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('programmes_id_institution_uq').on(table.id, table.institutionId),
    uniqueIndex('programmes_institution_slug_uidx').on(table.institutionId, table.slug),
    index('programmes_level_active_idx').on(table.studyLevel, table.isActive),
    index('programmes_discipline_idx').on(table.discipline),
    check('programmes_duration_pos_chk', sql`duration_months > 0`),
  ],
);

export const programmeIntakes = studexoSchema.table(
  'programme_intakes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    programmeId: uuid('programme_id')
      .notNull()
      .references(() => programmes.id, { onDelete: 'cascade' }),
    intakeTerm: intakeTermEnum('intake_term').notNull(),
    intakeYear: integer('intake_year').notNull(),
    applicationOpensAt: timestamp('application_opens_at', {
      withTimezone: true,
      mode: 'date',
    }),
    applicationDeadlineAt: timestamp('application_deadline_at', {
      withTimezone: true,
      mode: 'date',
    }),
    priorityDeadlineAt: timestamp('priority_deadline_at', {
      withTimezone: true,
      mode: 'date',
    }),
    isOpenForInternational: boolean('is_open_for_international').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('programme_intakes_id_programme_uq').on(table.id, table.programmeId),
    uniqueIndex('programme_intakes_prog_term_year_uidx').on(
      table.programmeId,
      table.intakeTerm,
      table.intakeYear,
    ),
    index('programme_intakes_deadline_idx').on(table.applicationDeadlineAt),
    check('programme_intakes_year_chk', sql`intake_year >= 2000 AND intake_year <= 2100`),
  ],
);

export const programmeFees = studexoSchema.table(
  'programme_fees',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    programmeId: uuid('programme_id')
      .notNull()
      .references(() => programmes.id, { onDelete: 'cascade' }),
    feeType: feeTypeEnum('fee_type').notNull(),
    studentCategory: studentResidencyCategoryEnum('student_category')
      .notNull()
      .default('international'),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull(),
    academicYear: varchar('academic_year', { length: 16 }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('programme_fees_programme_id_idx').on(table.programmeId),
    index('programme_fees_type_cat_idx').on(table.programmeId, table.feeType, table.studentCategory),
    check('programme_fees_amount_nonneg_chk', sql`amount >= 0`),
  ],
);

export const programmeRequirements = studexoSchema.table(
  'programme_requirements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    programmeId: uuid('programme_id')
      .notNull()
      .references(() => programmes.id, { onDelete: 'cascade' }),
    requirementType: requirementTypeEnum('requirement_type').notNull(),
    countryScope: varchar('country_scope', { length: 2 }),
    gradingScaleCode: varchar('grading_scale_code', { length: 64 }).references(
      () => gradingScales.code,
      { onDelete: 'restrict' },
    ),
    testCode: varchar('test_code', { length: 64 }).references(() => testCatalog.code, {
      onDelete: 'restrict',
    }),
    minimumNumericScore: numeric('minimum_numeric_score', { precision: 6, scale: 2 }),
    summary: text('summary').notNull(),
    structuredCriteria: jsonb('structured_criteria').$type<Record<string, unknown>>(),
    isMandatory: boolean('is_mandatory').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('programme_requirements_programme_id_idx').on(table.programmeId),
    index('programme_requirements_country_idx').on(table.programmeId, table.countryScope),
    index('programme_requirements_grading_scale_idx').on(table.gradingScaleCode),
    index('programme_requirements_test_code_idx').on(table.testCode),
    check(
      'programme_requirements_min_score_nonneg_chk',
      sql`minimum_numeric_score IS NULL OR minimum_numeric_score >= 0`,
    ),
  ],
);
