import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  eligibilityRuleTypeEnum,
  fundingComponentEnum,
  fundingFrequencyEnum,
  intakeTermEnum,
  scholarshipCoverageEnum,
  scholarshipProviderTypeEnum,
  studexoSchema,
  studyLevelEnum,
  verificationStatusEnum,
} from './enums';
import { institutions } from './institutions';
import { programmes } from './programmes';
import { gradingScales, testCatalog } from './reference';

export const scholarships = studexoSchema.table(
  'scholarships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: varchar('slug', { length: 180 }).notNull(),
    title: varchar('title', { length: 240 }).notNull(),
    providerName: varchar('provider_name', { length: 200 }).notNull(),
    providerType: scholarshipProviderTypeEnum('provider_type').notNull(),
    institutionId: uuid('institution_id').references(() => institutions.id, {
      onDelete: 'set null',
    }),
    hostCountryCode: varchar('host_country_code', { length: 2 }).notNull(),
    studyLevel: studyLevelEnum('study_level').notNull(),
    coverageScope: scholarshipCoverageEnum('coverage_scope').notNull(),
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
    uniqueIndex('scholarships_slug_uidx').on(table.slug),
    index('scholarships_country_level_active_idx').on(
      table.hostCountryCode,
      table.studyLevel,
      table.isActive,
    ),
    index('scholarships_institution_id_idx').on(table.institutionId),
  ],
);

export const scholarshipIntakes = studexoSchema.table(
  'scholarship_intakes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    scholarshipId: uuid('scholarship_id')
      .notNull()
      .references(() => scholarships.id, { onDelete: 'cascade' }),
    cycleLabel: varchar('cycle_label', { length: 64 }).notNull(),
    intakeTerm: intakeTermEnum('intake_term').notNull().default('rolling'),
    intakeYear: integer('intake_year').notNull(),
    applicationOpensAt: timestamp('application_opens_at', {
      withTimezone: true,
      mode: 'date',
    }),
    applicationDeadlineAt: timestamp('application_deadline_at', {
      withTimezone: true,
      mode: 'date',
    }),
    resultExpectedAt: timestamp('result_expected_at', {
      withTimezone: true,
      mode: 'date',
    }),
    isOpen: boolean('is_open').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('scholarship_intakes_id_scholarship_uq').on(table.id, table.scholarshipId),
    uniqueIndex('scholarship_intakes_sch_cycle_uidx').on(table.scholarshipId, table.cycleLabel),
    index('scholarship_intakes_deadline_idx').on(table.applicationDeadlineAt),
    check('scholarship_intakes_year_chk', sql`intake_year >= 2000 AND intake_year <= 2100`),
  ],
);

export const scholarshipProgrammes = studexoSchema.table(
  'scholarship_programmes',
  {
    scholarshipId: uuid('scholarship_id')
      .notNull()
      .references(() => scholarships.id, { onDelete: 'cascade' }),
    programmeId: uuid('programme_id')
      .notNull()
      .references(() => programmes.id, { onDelete: 'cascade' }),
    isPrimary: boolean('is_primary').notNull().default(false),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.scholarshipId, table.programmeId] }),
    index('scholarship_programmes_programme_id_idx').on(table.programmeId),
  ],
);

export const scholarshipEligibilityRules = studexoSchema.table(
  'scholarship_eligibility_rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    scholarshipId: uuid('scholarship_id')
      .notNull()
      .references(() => scholarships.id, { onDelete: 'cascade' }),
    ruleType: eligibilityRuleTypeEnum('rule_type').notNull(),
    eligibleCountries: jsonb('eligible_countries').$type<string[]>().notNull().default([]),
    gradingScaleCode: varchar('grading_scale_code', { length: 64 }).references(
      () => gradingScales.code,
      { onDelete: 'restrict' },
    ),
    testCode: varchar('test_code', { length: 64 }).references(() => testCatalog.code, {
      onDelete: 'restrict',
    }),
    minimumNumericScore: numeric('minimum_numeric_score', { precision: 6, scale: 2 }),
    summary: text('summary').notNull(),
    structuredRule: jsonb('structured_rule').$type<Record<string, unknown>>(),
    isMandatory: boolean('is_mandatory').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('scholarship_eligibility_scholarship_id_idx').on(table.scholarshipId),
    index('scholarship_eligibility_type_idx').on(table.scholarshipId, table.ruleType),
    index('scholarship_eligibility_grading_scale_idx').on(table.gradingScaleCode),
    index('scholarship_eligibility_test_code_idx').on(table.testCode),
    check(
      'scholarship_eligibility_min_score_nonneg_chk',
      sql`minimum_numeric_score IS NULL OR minimum_numeric_score >= 0`,
    ),
  ],
);

export const scholarshipFundingComponents = studexoSchema.table(
  'scholarship_funding_components',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    scholarshipId: uuid('scholarship_id')
      .notNull()
      .references(() => scholarships.id, { onDelete: 'cascade' }),
    componentType: fundingComponentEnum('component_type').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }),
    currencyCode: varchar('currency_code', { length: 3 }),
    percentageCovered: numeric('percentage_covered', { precision: 5, scale: 2 }),
    frequency: fundingFrequencyEnum('frequency').notNull().default('annual'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('scholarship_funding_scholarship_id_idx').on(table.scholarshipId),
    check('scholarship_funding_amount_nonneg_chk', sql`amount IS NULL OR amount >= 0`),
    check(
      'scholarship_funding_pct_range_chk',
      sql`percentage_covered IS NULL OR (percentage_covered >= 0 AND percentage_covered <= 100)`,
    ),
  ],
);
