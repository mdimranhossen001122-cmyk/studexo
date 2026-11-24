import crypto from 'node:crypto';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { AppError } from '../../middleware/errorHandler';
import type { StudexoDatabase } from '../../db/client';
import {
  studentProfiles,
  studentQualifications,
  studentTestScores,
} from '../../db/schema/profiles';
import { DEFAULT_GRADING_SCALES, gradingScales } from '../../db/schema/reference';
import {
  GRADING_SCALE_NUMERIC_MAX,
  type FundingNeed,
  type GradingScaleCode,
  type IeltsScoreStatus,
  type IeltsSubscores,
  type StudentIeltsReadinessInput,
  type StudentProfileUpdateRequest,
  type StudentQualificationInput,
  type TargetStudyLevel,
} from '../../../shared/schemas/studentProfile.schema';

export interface StoredStudentAdmissionsRow {
  countryOfCitizenship: string | null;
  countryOfResidence: string | null;
  city: string | null;
  birthYear: number | null;
  targetStudyLevel: TargetStudyLevel | null;
  targetIntakeTerm: string | null;
  targetCountries: string[];
  preferredFieldOfStudy: string | null;
  annualBudgetAmount: number | null;
  annualBudgetCurrency: string | null;
  fundingNeed: FundingNeed | null;
  onboardingCompletedAt: Date | null;
  updatedAt: Date | null;
}

export interface StoredStudentQualificationRow {
  id: string;
  qualificationLevel: 'secondary' | 'higher_secondary';
  boardOrInstitution: string;
  countryCode: string;
  fieldOfStudy: string | null;
  gradingScaleCode: GradingScaleCode;
  scoreValue: number | null;
  maxScoreValue: number | null;
  completionYear: number | null;
  isCompleted: boolean;
  verificationMethod: string;
  isVerified: boolean;
  updatedAt: Date;
}

export interface StoredStudentIeltsRow {
  id: string;
  testCode: 'ielts';
  scoreStatus: IeltsScoreStatus;
  overallScore: number | null;
  subscores: IeltsSubscores | null;
  plannedTestDate: string | null;
  testDate: string | null;
  waiverReason: string | null;
  verificationMethod: string;
  isVerified: boolean;
  updatedAt: Date;
}

export interface StoredGradingScaleOption {
  code: GradingScaleCode;
  name: string;
  countryCode: string | null;
  minValue: number | null;
  maxValue: number | null;
}

export interface StudentProfileRecord {
  admissions: StoredStudentAdmissionsRow;
  ssc: StoredStudentQualificationRow | null;
  hsc: StoredStudentQualificationRow | null;
  ielts: StoredStudentIeltsRow | null;
  gradingScales: StoredGradingScaleOption[];
}

export interface StudentProfileRepository {
  getStudentProfileByUserId(userId: string): Promise<StudentProfileRecord>;
  upsertStudentProfileTransactional(
    userId: string,
    input: StudentProfileUpdateRequest,
    options: { onboardingCompletedAt: Date | null },
  ): Promise<StudentProfileRecord>;
}

export function deriveStudentProfileLockId(userId: string): bigint {
  const normalizedUserId = userId.trim().toLowerCase();
  const lockInput = `studexo:student_profile:${normalizedUserId}`;
  const md5Hex16 = crypto.createHash('md5').update(lockInput, 'utf8').digest('hex').slice(0, 16);
  return BigInt.asIntN(64, BigInt(`0x${md5Hex16}`));
}

function parseNumericColumn(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumericColumn(value: number | null): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value.toFixed(2);
}

function sanitizeIeltsSubscores(subscores: IeltsSubscores | null | undefined): IeltsSubscores | null {
  if (!subscores) {
    return null;
  }
  const cleaned: IeltsSubscores = {};
  if (subscores.listening !== undefined) cleaned.listening = subscores.listening;
  if (subscores.reading !== undefined) cleaned.reading = subscores.reading;
  if (subscores.writing !== undefined) cleaned.writing = subscores.writing;
  if (subscores.speaking !== undefined) cleaned.speaking = subscores.speaking;
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

function createEmptyAdmissionsRow(): StoredStudentAdmissionsRow {
  return {
    countryOfCitizenship: null,
    countryOfResidence: null,
    city: null,
    birthYear: null,
    targetStudyLevel: null,
    targetIntakeTerm: null,
    targetCountries: [],
    preferredFieldOfStudy: null,
    annualBudgetAmount: null,
    annualBudgetCurrency: null,
    fundingNeed: null,
    onboardingCompletedAt: null,
    updatedAt: null,
  };
}

function mapGradingScaleRows(
  rows: Array<{
    code: string;
    name: string;
    countryCode: string | null;
    minValue: string | null;
    maxValue: string | null;
  }>,
): StoredGradingScaleOption[] {
  const validCodes = new Set<string>(Object.keys(GRADING_SCALE_NUMERIC_MAX));
  const filtered = rows
    .filter((r) => validCodes.has(r.code))
    .map((r) => ({
      code: r.code as GradingScaleCode,
      name: r.name,
      countryCode: r.countryCode,
      minValue: parseNumericColumn(r.minValue),
      maxValue: parseNumericColumn(r.maxValue),
    }));

  if (filtered.length > 0) {
    return filtered;
  }

  return DEFAULT_GRADING_SCALES.map((s) => ({
    code: s.code,
    name: s.name,
    countryCode: s.countryCode,
    minValue: parseNumericColumn(s.minValue),
    maxValue: parseNumericColumn(s.maxValue),
  }));
}

type DbExecutor = Pick<StudexoDatabase, 'select'>;

async function readStudentProfileFromExecutor(
  executor: DbExecutor,
  userId: string,
): Promise<StudentProfileRecord> {
  const [[profileRow], qualificationRows, testScoreRows, scaleRows] = await Promise.all([
    executor
      .select({
        countryOfCitizenship: studentProfiles.countryOfCitizenship,
        countryOfResidence: studentProfiles.countryOfResidence,
        city: studentProfiles.city,
        birthYear: studentProfiles.birthYear,
        targetStudyLevel: studentProfiles.targetStudyLevel,
        targetIntakeTerm: studentProfiles.targetIntakeTerm,
        targetCountries: studentProfiles.targetCountries,
        preferredFieldOfStudy: studentProfiles.preferredFieldOfStudy,
        annualBudgetAmount: studentProfiles.annualBudgetAmount,
        annualBudgetCurrency: studentProfiles.annualBudgetCurrency,
        fundingNeed: studentProfiles.fundingNeed,
        onboardingCompletedAt: studentProfiles.onboardingCompletedAt,
        updatedAt: studentProfiles.updatedAt,
      })
      .from(studentProfiles)
      .where(eq(studentProfiles.userId, userId))
      .limit(1),
    executor
      .select({
        id: studentQualifications.id,
        qualificationLevel: studentQualifications.qualificationLevel,
        boardOrInstitution: studentQualifications.boardOrInstitution,
        countryCode: studentQualifications.countryCode,
        fieldOfStudy: studentQualifications.fieldOfStudy,
        gradingScaleCode: studentQualifications.gradingScaleCode,
        scoreValue: studentQualifications.scoreValue,
        maxScoreValue: studentQualifications.maxScoreValue,
        completionYear: studentQualifications.completionYear,
        isCompleted: studentQualifications.isCompleted,
        verificationMethod: studentQualifications.verificationMethod,
        isVerified: studentQualifications.isVerified,
        updatedAt: studentQualifications.updatedAt,
      })
      .from(studentQualifications)
      .where(
        and(
          eq(studentQualifications.userId, userId),
          inArray(studentQualifications.qualificationLevel, ['secondary', 'higher_secondary']),
        ),
      )
      .orderBy(asc(studentQualifications.createdAt), asc(studentQualifications.id)),
    executor
      .select({
        id: studentTestScores.id,
        testCode: studentTestScores.testCode,
        scoreStatus: studentTestScores.scoreStatus,
        overallScore: studentTestScores.overallScore,
        subscores: studentTestScores.subscores,
        plannedTestDate: studentTestScores.plannedTestDate,
        testDate: studentTestScores.testDate,
        waiverReason: studentTestScores.waiverReason,
        verificationMethod: studentTestScores.verificationMethod,
        isVerified: studentTestScores.isVerified,
        updatedAt: studentTestScores.updatedAt,
      })
      .from(studentTestScores)
      .where(and(eq(studentTestScores.userId, userId), eq(studentTestScores.testCode, 'ielts')))
      .orderBy(asc(studentTestScores.createdAt), asc(studentTestScores.id)),
    executor
      .select({
        code: gradingScales.code,
        name: gradingScales.name,
        countryCode: gradingScales.countryCode,
        minValue: gradingScales.minValue,
        maxValue: gradingScales.maxValue,
      })
      .from(gradingScales)
      .where(eq(gradingScales.isActive, true))
      .orderBy(asc(gradingScales.code)),
  ]);

  const admissions: StoredStudentAdmissionsRow = profileRow
    ? {
        countryOfCitizenship: profileRow.countryOfCitizenship,
        countryOfResidence: profileRow.countryOfResidence,
        city: profileRow.city,
        birthYear: profileRow.birthYear,
        targetStudyLevel: profileRow.targetStudyLevel,
        targetIntakeTerm: profileRow.targetIntakeTerm,
        targetCountries: Array.isArray(profileRow.targetCountries)
          ? profileRow.targetCountries
          : [],
        preferredFieldOfStudy: profileRow.preferredFieldOfStudy,
        annualBudgetAmount: parseNumericColumn(profileRow.annualBudgetAmount),
        annualBudgetCurrency: profileRow.annualBudgetCurrency,
        fundingNeed: profileRow.fundingNeed,
        onboardingCompletedAt: profileRow.onboardingCompletedAt,
        updatedAt: profileRow.updatedAt,
      }
    : createEmptyAdmissionsRow();

  const mapQualification = (
    row: (typeof qualificationRows)[number] | undefined,
  ): StoredStudentQualificationRow | null => {
    if (!row) return null;
    return {
      id: row.id,
      qualificationLevel: row.qualificationLevel as 'secondary' | 'higher_secondary',
      boardOrInstitution: row.boardOrInstitution,
      countryCode: row.countryCode,
      fieldOfStudy: row.fieldOfStudy,
      gradingScaleCode: row.gradingScaleCode as GradingScaleCode,
      scoreValue: parseNumericColumn(row.scoreValue),
      maxScoreValue: parseNumericColumn(row.maxScoreValue),
      completionYear: row.completionYear,
      isCompleted: row.isCompleted,
      verificationMethod: row.verificationMethod,
      isVerified: row.isVerified,
      updatedAt: row.updatedAt,
    };
  };

  const ssc = mapQualification(
    qualificationRows.find((q) => q.qualificationLevel === 'secondary'),
  );
  const hsc = mapQualification(
    qualificationRows.find((q) => q.qualificationLevel === 'higher_secondary'),
  );

  const rawIelts = testScoreRows[0];
  const ielts: StoredStudentIeltsRow | null = rawIelts
    ? {
        id: rawIelts.id,
        testCode: 'ielts',
        scoreStatus: rawIelts.scoreStatus,
        overallScore: parseNumericColumn(rawIelts.overallScore),
        subscores: rawIelts.subscores ? sanitizeIeltsSubscores(rawIelts.subscores) : null,
        plannedTestDate: rawIelts.plannedTestDate,
        testDate: rawIelts.testDate,
        waiverReason: rawIelts.waiverReason,
        verificationMethod: rawIelts.verificationMethod,
        isVerified: rawIelts.isVerified,
        updatedAt: rawIelts.updatedAt,
      }
    : null;

  return {
    admissions,
    ssc,
    hsc,
    ielts,
    gradingScales: mapGradingScaleRows(scaleRows),
  };
}

export class PostgresStudentProfileRepository implements StudentProfileRepository {
  constructor(private readonly db: StudexoDatabase) {}

  public async getStudentProfileByUserId(userId: string): Promise<StudentProfileRecord> {
    return readStudentProfileFromExecutor(this.db, userId);
  }

  public async upsertStudentProfileTransactional(
    userId: string,
    input: StudentProfileUpdateRequest,
    options: { onboardingCompletedAt: Date | null },
  ): Promise<StudentProfileRecord> {
    const lockId = deriveStudentProfileLockId(userId);

    return this.db.transaction(async (tx) => {
      // Serialize concurrent profile saves for the same userId so SSC/HSC/IELTS cannot duplicate
      await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(${lockId.toString()}::bigint)`);

      const now = new Date();

      await tx
        .insert(studentProfiles)
        .values({
          id: crypto.randomUUID(),
          userId,
          countryOfCitizenship: input.admissions.countryOfCitizenship,
          countryOfResidence: input.admissions.countryOfResidence,
          city: input.admissions.city,
          birthYear: input.admissions.birthYear,
          targetStudyLevel: input.admissions.targetStudyLevel,
          targetIntakeTerm: input.admissions.targetIntakeTerm,
          targetCountries: input.admissions.targetCountries,
          preferredFieldOfStudy: input.admissions.preferredFieldOfStudy,
          annualBudgetAmount: formatNumericColumn(input.admissions.annualBudgetAmount),
          annualBudgetCurrency: input.admissions.annualBudgetCurrency,
          fundingNeed: input.admissions.fundingNeed,
          onboardingCompletedAt: options.onboardingCompletedAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: studentProfiles.userId,
          set: {
            countryOfCitizenship: input.admissions.countryOfCitizenship,
            countryOfResidence: input.admissions.countryOfResidence,
            city: input.admissions.city,
            birthYear: input.admissions.birthYear,
            targetStudyLevel: input.admissions.targetStudyLevel,
            targetIntakeTerm: input.admissions.targetIntakeTerm,
            targetCountries: input.admissions.targetCountries,
            preferredFieldOfStudy: input.admissions.preferredFieldOfStudy,
            annualBudgetAmount: formatNumericColumn(input.admissions.annualBudgetAmount),
            annualBudgetCurrency: input.admissions.annualBudgetCurrency,
            fundingNeed: input.admissions.fundingNeed,
            onboardingCompletedAt: options.onboardingCompletedAt
              ? sql`COALESCE(${studentProfiles.onboardingCompletedAt}, ${options.onboardingCompletedAt.toISOString()}::timestamptz)`
              : null,
            updatedAt: now,
          },
        });

      await this.upsertQualificationInTx(tx, userId, 'secondary', input.ssc, now);
      await this.upsertQualificationInTx(tx, userId, 'higher_secondary', input.hsc, now);
      await this.upsertIeltsInTx(tx, userId, input.ielts, now);

      return readStudentProfileFromExecutor(tx, userId);
    });
  }

  private async upsertQualificationInTx(
    tx: Parameters<Parameters<StudexoDatabase['transaction']>[0]>[0],
    userId: string,
    level: 'secondary' | 'higher_secondary',
    input: StudentQualificationInput | null,
    now: Date,
  ): Promise<void> {
    const existingRows = await tx
      .select({
        id: studentQualifications.id,
        isVerified: studentQualifications.isVerified,
      })
      .from(studentQualifications)
      .where(
        and(
          eq(studentQualifications.userId, userId),
          eq(studentQualifications.qualificationLevel, level),
        ),
      )
      .orderBy(asc(studentQualifications.createdAt), asc(studentQualifications.id));

    const verifiedRow = existingRows.find((r) => r.isVerified);
    if (verifiedRow) {
      throw new AppError(
        409,
        'CREDENTIAL_VERIFIED_LOCKED',
        `Your ${level === 'secondary' ? 'SSC' : 'HSC'} record has already been verified and cannot be overwritten directly.`,
      );
    }

    if (input === null) {
      if (existingRows.length > 0) {
        await tx
          .delete(studentQualifications)
          .where(
            and(
              eq(studentQualifications.userId, userId),
              eq(studentQualifications.qualificationLevel, level),
              eq(studentQualifications.isVerified, false),
            ),
          );
      }
      return;
    }

    const effectiveMaxScore =
      input.maxScoreValue ?? GRADING_SCALE_NUMERIC_MAX[input.gradingScaleCode];

    const values = {
      boardOrInstitution: input.boardOrInstitution,
      countryCode: input.countryCode,
      fieldOfStudy: input.fieldOfStudy,
      gradingScaleCode: input.gradingScaleCode,
      scoreValue: formatNumericColumn(input.scoreValue),
      maxScoreValue: formatNumericColumn(effectiveMaxScore),
      completionYear: input.completionYear,
      isCompleted: input.isCompleted,
      verificationMethod: 'self_reported' as const,
      isVerified: false,
      verifiedByUserId: null,
      verifiedByRole: null,
      verifiedAt: null,
      evidenceDocumentVersionId: null,
      externalReferenceUrl: null,
      verificationValidUntil: null,
      updatedAt: now,
    };

    const primaryRow = existingRows[0];
    if (primaryRow) {
      await tx
        .update(studentQualifications)
        .set(values)
        .where(and(eq(studentQualifications.id, primaryRow.id), eq(studentQualifications.userId, userId)));

      if (existingRows.length > 1) {
        await tx
          .delete(studentQualifications)
          .where(
            and(
              eq(studentQualifications.userId, userId),
              eq(studentQualifications.qualificationLevel, level),
              eq(studentQualifications.isVerified, false),
              ne(studentQualifications.id, primaryRow.id),
            ),
          );
      }
      return;
    }

    await tx.insert(studentQualifications).values({
      id: crypto.randomUUID(),
      userId,
      qualificationLevel: level,
      ...values,
    });
  }

  private async upsertIeltsInTx(
    tx: Parameters<Parameters<StudexoDatabase['transaction']>[0]>[0],
    userId: string,
    input: StudentIeltsReadinessInput | null,
    now: Date,
  ): Promise<void> {
    const existingRows = await tx
      .select({
        id: studentTestScores.id,
        isVerified: studentTestScores.isVerified,
      })
      .from(studentTestScores)
      .where(and(eq(studentTestScores.userId, userId), eq(studentTestScores.testCode, 'ielts')))
      .orderBy(asc(studentTestScores.createdAt), asc(studentTestScores.id));

    const verifiedRow = existingRows.find((r) => r.isVerified);
    if (verifiedRow) {
      throw new AppError(
        409,
        'CREDENTIAL_VERIFIED_LOCKED',
        'Your IELTS record has already been verified and cannot be overwritten directly.',
      );
    }

    if (input === null) {
      if (existingRows.length > 0) {
        await tx
          .delete(studentTestScores)
          .where(
            and(
              eq(studentTestScores.userId, userId),
              eq(studentTestScores.testCode, 'ielts'),
              eq(studentTestScores.isVerified, false),
            ),
          );
      }
      return;
    }

    const isReported = input.scoreStatus === 'reported';
    const overallScore = isReported ? formatNumericColumn(input.overallScore) : null;
    const subscores = isReported ? sanitizeIeltsSubscores(input.subscores) : null;

    const values = {
      scoreStatus: input.scoreStatus,
      overallScore,
      subscores,
      plannedTestDate: input.plannedTestDate,
      testDate: input.testDate,
      waiverReason: input.scoreStatus === 'waived' ? input.waiverReason : null,
      verificationMethod: 'self_reported' as const,
      isVerified: false,
      verifiedByUserId: null,
      verifiedByRole: null,
      verifiedAt: null,
      evidenceDocumentVersionId: null,
      externalReferenceUrl: null,
      verificationValidUntil: null,
      updatedAt: now,
    };

    const primaryRow = existingRows[0];
    if (primaryRow) {
      await tx
        .update(studentTestScores)
        .set(values)
        .where(and(eq(studentTestScores.id, primaryRow.id), eq(studentTestScores.userId, userId)));

      if (existingRows.length > 1) {
        await tx
          .delete(studentTestScores)
          .where(
            and(
              eq(studentTestScores.userId, userId),
              eq(studentTestScores.testCode, 'ielts'),
              eq(studentTestScores.isVerified, false),
              ne(studentTestScores.id, primaryRow.id),
            ),
          );
      }
      return;
    }

    await tx.insert(studentTestScores).values({
      id: crypto.randomUUID(),
      userId,
      testCode: 'ielts',
      ...values,
    });
  }
}

export function createPostgresStudentProfileRepository(
  db: StudexoDatabase,
): StudentProfileRepository {
  return new PostgresStudentProfileRepository(db);
}
