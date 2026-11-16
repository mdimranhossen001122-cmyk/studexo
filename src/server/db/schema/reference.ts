import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { studexoSchema } from './enums';

export const gradingScales = studexoSchema.table(
  'grading_scales',
  {
    code: varchar('code', { length: 64 }).primaryKey(),
    name: varchar('name', { length: 120 }).notNull(),
    countryCode: varchar('country_code', { length: 2 }),
    minValue: numeric('min_value', { precision: 6, scale: 2 }),
    maxValue: numeric('max_value', { precision: 6, scale: 2 }),
    isHigherBetter: boolean('is_higher_better').notNull().default(true),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('grading_scales_country_active_idx').on(table.countryCode, table.isActive),
    check(
      'grading_scales_range_chk',
      sql`min_value IS NULL OR max_value IS NULL OR max_value >= min_value`,
    ),
  ],
);

export const testCatalog = studexoSchema.table(
  'test_catalog',
  {
    code: varchar('code', { length: 64 }).primaryKey(),
    name: varchar('name', { length: 120 }).notNull(),
    category: varchar('category', { length: 32 }).notNull(),
    hasNumericScore: boolean('has_numeric_score').notNull().default(true),
    minScore: numeric('min_score', { precision: 6, scale: 2 }),
    maxScore: numeric('max_score', { precision: 6, scale: 2 }),
    scoreStep: numeric('score_step', { precision: 4, scale: 2 }),
    defaultValidityMonths: integer('default_validity_months'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('test_catalog_category_active_idx').on(table.category, table.isActive),
    check('test_catalog_category_chk', sql`category IN ('language', 'standardized', 'other')`),
    check(
      'test_catalog_range_chk',
      sql`min_score IS NULL OR max_score IS NULL OR max_score >= min_score`,
    ),
    check(
      'test_catalog_validity_positive_chk',
      sql`default_validity_months IS NULL OR default_validity_months > 0`,
    ),
  ],
);

export const DEFAULT_GRADING_SCALES = [
  { code: 'gpa_5', name: 'Bangladesh GPA (5.00 Scale)', countryCode: 'BD', minValue: '0.00', maxValue: '5.00', isHigherBetter: true },
  { code: 'gpa_4', name: 'GPA (4.00 Scale)', countryCode: null, minValue: '0.00', maxValue: '4.00', isHigherBetter: true },
  { code: 'cgpa_10', name: 'CGPA (10.00 Scale)', countryCode: 'IN', minValue: '0.00', maxValue: '10.00', isHigherBetter: true },
  { code: 'percentage', name: 'Percentage (0-100%)', countryCode: null, minValue: '0.00', maxValue: '100.00', isHigherBetter: true },
  { code: 'uk_honours', name: 'UK Honours Classification', countryCode: 'GB', minValue: null, maxValue: null, isHigherBetter: true },
  { code: 'other', name: 'Other Grading Scale', countryCode: null, minValue: null, maxValue: null, isHigherBetter: true },
] as const;

export const DEFAULT_TEST_CATALOG = [
  { code: 'ielts', name: 'IELTS Academic', category: 'language', hasNumericScore: true, minScore: '0.00', maxScore: '9.00', scoreStep: '0.50', defaultValidityMonths: 24 },
  { code: 'toefl_ibt', name: 'TOEFL iBT', category: 'language', hasNumericScore: true, minScore: '0.00', maxScore: '120.00', scoreStep: '1.00', defaultValidityMonths: 24 },
  { code: 'pte_academic', name: 'PTE Academic', category: 'language', hasNumericScore: true, minScore: '10.00', maxScore: '90.00', scoreStep: '1.00', defaultValidityMonths: 24 },
  { code: 'duolingo', name: 'Duolingo English Test', category: 'language', hasNumericScore: true, minScore: '10.00', maxScore: '160.00', scoreStep: '5.00', defaultValidityMonths: 24 },
  { code: 'moi', name: 'Medium of Instruction (MOI)', category: 'language', hasNumericScore: false, minScore: null, maxScore: null, scoreStep: null, defaultValidityMonths: null },
  { code: 'sat', name: 'SAT', category: 'standardized', hasNumericScore: true, minScore: '400.00', maxScore: '1600.00', scoreStep: '10.00', defaultValidityMonths: 60 },
  { code: 'gre', name: 'GRE General', category: 'standardized', hasNumericScore: true, minScore: '260.00', maxScore: '340.00', scoreStep: '1.00', defaultValidityMonths: 60 },
  { code: 'gmat', name: 'GMAT Focus / Classic', category: 'standardized', hasNumericScore: true, minScore: '205.00', maxScore: '805.00', scoreStep: '10.00', defaultValidityMonths: 60 },
  { code: 'other', name: 'Other Standardized or Language Test', category: 'other', hasNumericScore: true, minScore: null, maxScore: null, scoreStep: null, defaultValidityMonths: null },
] as const;
