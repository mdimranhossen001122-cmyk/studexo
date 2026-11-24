import { z } from 'zod';

export const TARGET_STUDY_LEVELS = [
  'foundation',
  'undergraduate',
  'postgraduate_taught',
  'postgraduate_research',
  'diploma',
] as const;

export const FUNDING_NEEDS = [
  'self_funded',
  'partial_scholarship_needed',
  'full_scholarship_required',
  'unknown',
] as const;

export const GRADING_SCALE_CODES = [
  'gpa_5',
  'gpa_4',
  'cgpa_10',
  'percentage',
  'uk_honours',
  'other',
] as const;

export const IELTS_SCORE_STATUSES = [
  'reported',
  'planned',
  'taken_pending_result',
  'not_tested',
  'not_applicable',
  'unknown',
  'waived',
] as const;

export type TargetStudyLevel = (typeof TARGET_STUDY_LEVELS)[number];
export type FundingNeed = (typeof FUNDING_NEEDS)[number];
export type GradingScaleCode = (typeof GRADING_SCALE_CODES)[number];
export type IeltsScoreStatus = (typeof IELTS_SCORE_STATUSES)[number];

export const GRADING_SCALE_NUMERIC_MAX: Readonly<Record<GradingScaleCode, number | null>> = {
  gpa_5: 5,
  gpa_4: 4,
  cgpa_10: 10,
  percentage: 100,
  uk_honours: null,
  other: null,
};

function normalizeNullableString(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeNullableUpperString(value: unknown): unknown {
  const normalized = normalizeNullableString(value);
  return typeof normalized === 'string' ? normalized.toUpperCase() : normalized;
}

function normalizeRequiredString(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  return value.trim();
}

function normalizeRequiredUpperString(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  return value.trim().toUpperCase();
}

function normalizeNullableNumber(value: unknown): unknown {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? value : parsed;
  }
  return value;
}

export function isValidIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [yearStr, monthStr, dayStr] = value.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

export function isValidIeltsBand(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 9 &&
    Math.abs(value * 2 - Math.round(value * 2)) < 1e-9
  );
}

const isoCountryRequiredSchema = z.preprocess(
  normalizeRequiredUpperString,
  z.string().regex(/^[A-Z]{2}$/, 'Must be a 2-letter ISO country code (e.g. BD, IN, GB)'),
);

const isoCountryNullableSchema = z.preprocess(
  normalizeNullableUpperString,
  z
    .string()
    .regex(/^[A-Z]{2}$/, 'Must be a 2-letter ISO country code (e.g. BD, IN, GB)')
    .nullable(),
);

const isoCurrencyNullableSchema = z.preprocess(
  normalizeNullableUpperString,
  z
    .string()
    .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code (e.g. USD, BDT, INR)')
    .nullable(),
);

const nullableIsoDateSchema = z.preprocess(
  normalizeNullableString,
  z
    .string()
    .refine(isValidIsoCalendarDate, 'Date must be a valid YYYY-MM-DD calendar date')
    .nullable(),
);

const ieltsBandSchema = z.preprocess(
  normalizeNullableNumber,
  z
    .number({ error: 'IELTS band must be a valid number' })
    .refine(isValidIeltsBand, 'IELTS band must be between 0.0 and 9.0 in 0.5 increments'),
);

const nullableIeltsBandSchema = z.preprocess(
  normalizeNullableNumber,
  z
    .number({ error: 'IELTS band must be a valid number' })
    .refine(isValidIeltsBand, 'IELTS band must be between 0.0 and 9.0 in 0.5 increments')
    .nullable(),
);

export const studentAdmissionsGoalsInputSchema = z
  .object({
    countryOfCitizenship: isoCountryNullableSchema.optional().default(null),
    countryOfResidence: isoCountryNullableSchema.optional().default(null),
    city: z
      .preprocess(
        normalizeNullableString,
        z.string().max(120, 'City must be at most 120 characters').nullable(),
      )
      .optional()
      .default(null),
    birthYear: z
      .preprocess(
        normalizeNullableNumber,
        z
          .number({ error: 'Birth year must be an integer' })
          .int('Birth year must be a whole year')
          .min(1900, 'Birth year must be 1900 or later')
          .max(2100, 'Birth year must be 2100 or earlier')
          .nullable(),
      )
      .optional()
      .default(null),
    targetStudyLevel: z
      .enum(TARGET_STUDY_LEVELS)
      .nullable()
      .optional()
      .default(null),
    targetIntakeTerm: z
      .preprocess(
        normalizeNullableString,
        z.string().max(32, 'Target intake term must be at most 32 characters').nullable(),
      )
      .optional()
      .default(null),
    targetCountries: z
      .array(isoCountryRequiredSchema)
      .max(15, 'Select at most 15 target countries')
      .transform((countries) => Array.from(new Set(countries)))
      .optional()
      .default([]),
    preferredFieldOfStudy: z
      .preprocess(
        normalizeNullableString,
        z
          .string()
          .max(160, 'Preferred field of study must be at most 160 characters')
          .nullable(),
      )
      .optional()
      .default(null),
    annualBudgetAmount: z
      .preprocess(
        normalizeNullableNumber,
        z
          .number({ error: 'Annual budget must be a valid number' })
          .finite('Annual budget must be finite')
          .min(0, 'Annual budget cannot be negative')
          .max(999_999_999_999.99, 'Annual budget exceeds supported maximum')
          .transform((val) => Math.round(val * 100) / 100)
          .nullable(),
      )
      .optional()
      .default(null),
    annualBudgetCurrency: isoCurrencyNullableSchema.optional().default(null),
    fundingNeed: z.enum(FUNDING_NEEDS).nullable().optional().default(null),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.annualBudgetAmount !== null && !data.annualBudgetCurrency) {
      ctx.addIssue({
        code: 'custom',
        path: ['annualBudgetCurrency'],
        message: 'Currency is required when an annual budget amount is provided.',
      });
    }
  });

export type StudentAdmissionsGoalsInput = z.infer<typeof studentAdmissionsGoalsInputSchema>;

export const studentQualificationInputSchema = z
  .object({
    boardOrInstitution: z.preprocess(
      normalizeRequiredString,
      z
        .string()
        .min(1, 'Board or institution name is required')
        .max(200, 'Board or institution must be at most 200 characters'),
    ),
    countryCode: isoCountryRequiredSchema,
    fieldOfStudy: z
      .preprocess(
        normalizeNullableString,
        z.string().max(160, 'Group/stream must be at most 160 characters').nullable(),
      )
      .optional()
      .default(null),
    gradingScaleCode: z.enum(GRADING_SCALE_CODES),
    scoreValue: z
      .preprocess(
        normalizeNullableNumber,
        z
          .number({ error: 'Score/GPA must be a valid number' })
          .finite('Score/GPA must be finite')
          .min(0, 'Score/GPA cannot be negative')
          .max(9999.99, 'Score/GPA exceeds supported precision')
          .transform((val) => Math.round(val * 100) / 100)
          .nullable(),
      )
      .optional()
      .default(null),
    maxScoreValue: z
      .preprocess(
        normalizeNullableNumber,
        z
          .number({ error: 'Maximum score must be a valid number' })
          .finite('Maximum score must be finite')
          .gt(0, 'Maximum score must be greater than 0')
          .max(9999.99, 'Maximum score exceeds supported precision')
          .transform((val) => Math.round(val * 100) / 100)
          .nullable(),
      )
      .optional()
      .default(null),
    completionYear: z
      .preprocess(
        normalizeNullableNumber,
        z
          .number({ error: 'Completion year must be an integer' })
          .int('Completion year must be a whole year')
          .min(1950, 'Completion year must be 1950 or later')
          .max(2050, 'Completion year must be 2050 or earlier')
          .nullable(),
      )
      .optional()
      .default(null),
    isCompleted: z.boolean().optional().default(true),
  })
  .strict()
  .superRefine((data, ctx) => {
    const scaleMax = GRADING_SCALE_NUMERIC_MAX[data.gradingScaleCode];
    if (scaleMax !== null && data.maxScoreValue !== null && data.maxScoreValue > scaleMax) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxScoreValue'],
        message: `Maximum score for ${data.gradingScaleCode} cannot exceed ${scaleMax}.`,
      });
    }

    const effectiveMax = data.maxScoreValue ?? scaleMax;
    if (data.scoreValue !== null && effectiveMax !== null && data.scoreValue > effectiveMax) {
      ctx.addIssue({
        code: 'custom',
        path: ['scoreValue'],
        message: `Score cannot exceed maximum scale value (${effectiveMax}).`,
      });
    }
  });

export type StudentQualificationInput = z.infer<typeof studentQualificationInputSchema>;

export const ieltsSubscoresInputSchema = z
  .object({
    listening: ieltsBandSchema.optional(),
    reading: ieltsBandSchema.optional(),
    writing: ieltsBandSchema.optional(),
    speaking: ieltsBandSchema.optional(),
  })
  .strict();

export type IeltsSubscores = z.infer<typeof ieltsSubscoresInputSchema>;

export const studentIeltsReadinessInputSchema = z
  .object({
    scoreStatus: z.enum(IELTS_SCORE_STATUSES),
    overallScore: nullableIeltsBandSchema.optional().default(null),
    subscores: ieltsSubscoresInputSchema.nullable().optional().default(null),
    plannedTestDate: nullableIsoDateSchema.optional().default(null),
    testDate: nullableIsoDateSchema.optional().default(null),
    waiverReason: z
      .preprocess(
        normalizeNullableString,
        z.string().max(500, 'Waiver reason must be at most 500 characters').nullable(),
      )
      .optional()
      .default(null),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasSubscoreValue =
      data.subscores !== null &&
      data.subscores !== undefined &&
      Object.values(data.subscores).some((val) => val !== undefined);

    if (data.scoreStatus === 'reported') {
      if (data.overallScore === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['overallScore'],
          message: 'Overall IELTS band is required when score status is reported.',
        });
      }
    } else {
      if (data.overallScore !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['overallScore'],
          message: 'Numeric IELTS score cannot be set unless score status is reported.',
        });
      }
      if (hasSubscoreValue) {
        ctx.addIssue({
          code: 'custom',
          path: ['subscores'],
          message: 'IELTS subscores cannot be set unless score status is reported.',
        });
      }
    }

    if (data.scoreStatus === 'waived' && !data.waiverReason) {
      ctx.addIssue({
        code: 'custom',
        path: ['waiverReason'],
        message: 'Waiver reason is required when IELTS status is waived.',
      });
    }
  });

export type StudentIeltsReadinessInput = z.infer<typeof studentIeltsReadinessInputSchema>;

export const studentProfileUpdateRequestSchema = z
  .object({
    admissions: studentAdmissionsGoalsInputSchema,
    ssc: studentQualificationInputSchema.nullable().optional().default(null),
    hsc: studentQualificationInputSchema.nullable().optional().default(null),
    ielts: studentIeltsReadinessInputSchema.nullable().optional().default(null),
  })
  .strict();

export type StudentProfileUpdateRequest = z.infer<typeof studentProfileUpdateRequestSchema>;

export const studentAdmissionsGoalsDtoSchema = z
  .object({
    countryOfCitizenship: z.string().nullable(),
    countryOfResidence: z.string().nullable(),
    city: z.string().nullable(),
    birthYear: z.number().int().nullable(),
    targetStudyLevel: z.enum(TARGET_STUDY_LEVELS).nullable(),
    targetIntakeTerm: z.string().nullable(),
    targetCountries: z.array(z.string()),
    preferredFieldOfStudy: z.string().nullable(),
    annualBudgetAmount: z.number().nullable(),
    annualBudgetCurrency: z.string().nullable(),
    fundingNeed: z.enum(FUNDING_NEEDS).nullable(),
    onboardingCompletedAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
  })
  .strict();

export type StudentAdmissionsGoalsDto = z.infer<typeof studentAdmissionsGoalsDtoSchema>;

export const studentQualificationDtoSchema = z
  .object({
    qualificationLevel: z.enum(['secondary', 'higher_secondary']),
    boardOrInstitution: z.string(),
    countryCode: z.string(),
    fieldOfStudy: z.string().nullable(),
    gradingScaleCode: z.enum(GRADING_SCALE_CODES),
    scoreValue: z.number().nullable(),
    maxScoreValue: z.number().nullable(),
    completionYear: z.number().int().nullable(),
    isCompleted: z.boolean(),
    verificationMethod: z.string(),
    isVerified: z.boolean(),
    updatedAt: z.string(),
  })
  .strict();

export type StudentQualificationDto = z.infer<typeof studentQualificationDtoSchema>;

export const studentIeltsReadinessDtoSchema = z
  .object({
    testCode: z.literal('ielts'),
    scoreStatus: z.enum(IELTS_SCORE_STATUSES),
    overallScore: z.number().nullable(),
    subscores: ieltsSubscoresInputSchema.nullable(),
    plannedTestDate: z.string().nullable(),
    testDate: z.string().nullable(),
    waiverReason: z.string().nullable(),
    verificationMethod: z.string(),
    isVerified: z.boolean(),
    updatedAt: z.string(),
  })
  .strict();

export type StudentIeltsReadinessDto = z.infer<typeof studentIeltsReadinessDtoSchema>;

export const studentProfileCompletionDtoSchema = z
  .object({
    completedSections: z.number().int().min(0),
    totalSections: z.number().int().min(1),
    percentage: z.number().int().min(0).max(100),
    isComplete: z.boolean(),
    missingItems: z.array(z.string()),
  })
  .strict();

export type StudentProfileCompletionDto = z.infer<typeof studentProfileCompletionDtoSchema>;

export const studentGradingScaleOptionSchema = z
  .object({
    code: z.enum(GRADING_SCALE_CODES),
    name: z.string(),
    countryCode: z.string().nullable(),
    minValue: z.number().nullable(),
    maxValue: z.number().nullable(),
  })
  .strict();

export const studentProfileResponseSchema = z
  .object({
    admissions: studentAdmissionsGoalsDtoSchema,
    ssc: studentQualificationDtoSchema.nullable(),
    hsc: studentQualificationDtoSchema.nullable(),
    ielts: studentIeltsReadinessDtoSchema.nullable(),
    completion: studentProfileCompletionDtoSchema,
    gradingScales: z.array(studentGradingScaleOptionSchema),
  })
  .strict();

export type StudentProfileResponse = z.infer<typeof studentProfileResponseSchema>;

export function computeStudentProfileCompletion(input: {
  admissions: Pick<
    StudentAdmissionsGoalsInput,
    | 'countryOfCitizenship'
    | 'targetStudyLevel'
    | 'targetIntakeTerm'
    | 'targetCountries'
    | 'preferredFieldOfStudy'
    | 'fundingNeed'
  >;
  ssc: Pick<StudentQualificationInput, 'boardOrInstitution' | 'scoreValue'> | null;
  hsc: Pick<StudentQualificationInput, 'boardOrInstitution' | 'scoreValue'> | null;
  ielts: Pick<StudentIeltsReadinessInput, 'scoreStatus' | 'overallScore' | 'plannedTestDate' | 'waiverReason'> | null;
}): StudentProfileCompletionDto {
  const missingItems: string[] = [];
  let completedSections = 0;
  const totalSections = 4;

  const hasAdmissionsGoals =
    Boolean(input.admissions.countryOfCitizenship) &&
    Boolean(input.admissions.targetStudyLevel) &&
    Boolean(input.admissions.targetIntakeTerm) &&
    input.admissions.targetCountries.length > 0 &&
    Boolean(input.admissions.preferredFieldOfStudy) &&
    Boolean(input.admissions.fundingNeed);

  if (hasAdmissionsGoals) {
    completedSections += 1;
  } else {
    missingItems.push('Admissions goals & destination targets');
  }

  if (input.ssc && input.ssc.boardOrInstitution.trim().length > 0 && input.ssc.scoreValue !== null) {
    completedSections += 1;
  } else {
    missingItems.push('SSC / Secondary qualification');
  }

  if (input.hsc && input.hsc.boardOrInstitution.trim().length > 0 && input.hsc.scoreValue !== null) {
    completedSections += 1;
  } else {
    missingItems.push('HSC / Higher Secondary qualification');
  }

  const hasIeltsReadiness = Boolean(
    input.ielts &&
      (input.ielts.scoreStatus !== 'reported' || input.ielts.overallScore !== null),
  );
  if (hasIeltsReadiness) {
    completedSections += 1;
  } else {
    missingItems.push('IELTS / English readiness status');
  }

  const percentage = Math.round((completedSections / totalSections) * 100);
  return {
    completedSections,
    totalSections,
    percentage,
    isComplete: completedSections === totalSections,
    missingItems,
  };
}
