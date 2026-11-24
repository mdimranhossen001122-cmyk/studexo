import { ZodError } from 'zod';
import { isRecoverable401Error } from '@/features/auth/authModel';
import {
  ApiClientError,
  fetchStudentProfile,
  saveStudentProfile,
} from '@/lib/apiClient';
import {
  computeStudentProfileCompletion,
  GRADING_SCALE_NUMERIC_MAX,
  studentProfileUpdateRequestSchema,
  type FundingNeed,
  type GradingScaleCode,
  type IeltsScoreStatus,
  type StudentProfileCompletionDto,
  type StudentProfileResponse,
  type StudentProfileUpdateRequest,
  type TargetStudyLevel,
} from '@shared/schemas/studentProfile.schema';

export interface QualificationFormState {
  enabled: boolean;
  boardOrInstitution: string;
  countryCode: string;
  fieldOfStudy: string;
  gradingScaleCode: GradingScaleCode;
  scoreValue: string;
  maxScoreValue: string;
  completionYear: string;
  isCompleted: boolean;
  verificationMethod: string;
  isVerified: boolean;
}

export interface IeltsFormState {
  enabled: boolean;
  scoreStatus: IeltsScoreStatus;
  overallScore: string;
  listening: string;
  reading: string;
  writing: string;
  speaking: string;
  plannedTestDate: string;
  testDate: string;
  waiverReason: string;
  verificationMethod: string;
  isVerified: boolean;
}

export interface StudentProfileFormState {
  admissions: {
    countryOfCitizenship: string;
    countryOfResidence: string;
    city: string;
    birthYear: string;
    targetStudyLevel: '' | TargetStudyLevel;
    targetIntakeTerm: string;
    targetCountriesInput: string;
    preferredFieldOfStudy: string;
    annualBudgetAmount: string;
    annualBudgetCurrency: string;
    fundingNeed: '' | FundingNeed;
  };
  ssc: QualificationFormState;
  hsc: QualificationFormState;
  ielts: IeltsFormState;
}

export type TokenProvider = (options?: { forceRefresh?: boolean }) => Promise<string | null>;

export async function runWithTokenRefresh<T>(
  getAccessToken: TokenProvider,
  operation: (accessToken: string) => Promise<T>,
): Promise<T> {
  const token = await getAccessToken();
  if (!token) {
    throw new ApiClientError({
      status: 401,
      code: 'AUTH_TOKEN_MISSING',
      message: 'Your session has expired. Sign in again to access your student profile.',
    });
  }

  try {
    return await operation(token);
  } catch (err: unknown) {
    if (!isRecoverable401Error(err)) {
      throw err;
    }

    const refreshedToken = await getAccessToken({ forceRefresh: true });
    if (!refreshedToken) {
      throw err;
    }
    return operation(refreshedToken);
  }
}

export async function loadStudentProfileWithAuth(
  getAccessToken: TokenProvider,
  fetcher?: typeof fetch,
): Promise<StudentProfileResponse> {
  return runWithTokenRefresh(getAccessToken, (token) => fetchStudentProfile(token, fetcher));
}

export async function updateStudentProfileWithAuth(
  getAccessToken: TokenProvider,
  payload: StudentProfileUpdateRequest,
  fetcher?: typeof fetch,
): Promise<StudentProfileResponse> {
  return runWithTokenRefresh(getAccessToken, (token) =>
    saveStudentProfile(token, payload, fetcher),
  );
}

function emptyQualificationFormState(defaultCountry = 'BD'): QualificationFormState {
  return {
    enabled: false,
    boardOrInstitution: '',
    countryCode: defaultCountry,
    fieldOfStudy: '',
    gradingScaleCode: defaultCountry === 'IN' ? 'percentage' : 'gpa_5',
    scoreValue: '',
    maxScoreValue: defaultCountry === 'IN' ? '100' : '5',
    completionYear: '',
    isCompleted: true,
    verificationMethod: 'self_reported',
    isVerified: false,
  };
}

function emptyIeltsFormState(): IeltsFormState {
  return {
    enabled: false,
    scoreStatus: 'planned',
    overallScore: '',
    listening: '',
    reading: '',
    writing: '',
    speaking: '',
    plannedTestDate: '',
    testDate: '',
    waiverReason: '',
    verificationMethod: 'self_reported',
    isVerified: false,
  };
}

export function toStudentProfileFormState(dto: StudentProfileResponse): StudentProfileFormState {
  const defaultCountry = dto.admissions.countryOfCitizenship ?? 'BD';

  const mapQual = (
    q: StudentProfileResponse['ssc'],
  ): QualificationFormState => {
    if (!q) {
      return emptyQualificationFormState(defaultCountry);
    }
    return {
      enabled: true,
      boardOrInstitution: q.boardOrInstitution,
      countryCode: q.countryCode,
      fieldOfStudy: q.fieldOfStudy ?? '',
      gradingScaleCode: q.gradingScaleCode,
      scoreValue: q.scoreValue !== null ? String(q.scoreValue) : '',
      maxScoreValue:
        q.maxScoreValue !== null
          ? String(q.maxScoreValue)
          : GRADING_SCALE_NUMERIC_MAX[q.gradingScaleCode] !== null
            ? String(GRADING_SCALE_NUMERIC_MAX[q.gradingScaleCode])
            : '',
      completionYear: q.completionYear !== null ? String(q.completionYear) : '',
      isCompleted: q.isCompleted,
      verificationMethod: q.verificationMethod,
      isVerified: q.isVerified,
    };
  };

  const ielts = dto.ielts
    ? {
        enabled: true,
        scoreStatus: dto.ielts.scoreStatus,
        overallScore: dto.ielts.overallScore !== null ? String(dto.ielts.overallScore) : '',
        listening:
          dto.ielts.subscores?.listening !== undefined
            ? String(dto.ielts.subscores.listening)
            : '',
        reading:
          dto.ielts.subscores?.reading !== undefined ? String(dto.ielts.subscores.reading) : '',
        writing:
          dto.ielts.subscores?.writing !== undefined ? String(dto.ielts.subscores.writing) : '',
        speaking:
          dto.ielts.subscores?.speaking !== undefined ? String(dto.ielts.subscores.speaking) : '',
        plannedTestDate: dto.ielts.plannedTestDate ?? '',
        testDate: dto.ielts.testDate ?? '',
        waiverReason: dto.ielts.waiverReason ?? '',
        verificationMethod: dto.ielts.verificationMethod,
        isVerified: dto.ielts.isVerified,
      }
    : emptyIeltsFormState();

  return {
    admissions: {
      countryOfCitizenship: dto.admissions.countryOfCitizenship ?? '',
      countryOfResidence: dto.admissions.countryOfResidence ?? '',
      city: dto.admissions.city ?? '',
      birthYear: dto.admissions.birthYear !== null ? String(dto.admissions.birthYear) : '',
      targetStudyLevel: dto.admissions.targetStudyLevel ?? '',
      targetIntakeTerm: dto.admissions.targetIntakeTerm ?? '',
      targetCountriesInput: dto.admissions.targetCountries.join(', '),
      preferredFieldOfStudy: dto.admissions.preferredFieldOfStudy ?? '',
      annualBudgetAmount:
        dto.admissions.annualBudgetAmount !== null
          ? String(dto.admissions.annualBudgetAmount)
          : '',
      annualBudgetCurrency: dto.admissions.annualBudgetCurrency ?? '',
      fundingNeed: dto.admissions.fundingNeed ?? '',
    },
    ssc: mapQual(dto.ssc),
    hsc: mapQual(dto.hsc),
    ielts,
  };
}

function parseTargetCountriesList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
}

function buildQualificationRawPayload(q: QualificationFormState) {
  if (!q.enabled) {
    return null;
  }
  return {
    boardOrInstitution: q.boardOrInstitution,
    countryCode: q.countryCode,
    fieldOfStudy: q.fieldOfStudy || null,
    gradingScaleCode: q.gradingScaleCode,
    scoreValue: q.scoreValue.trim() === '' ? null : q.scoreValue.trim(),
    maxScoreValue: q.maxScoreValue.trim() === '' ? null : q.maxScoreValue.trim(),
    completionYear: q.completionYear.trim() === '' ? null : q.completionYear.trim(),
    isCompleted: q.isCompleted,
  };
}

function buildIeltsRawPayload(ielts: IeltsFormState) {
  if (!ielts.enabled) {
    return null;
  }

  const isReported = ielts.scoreStatus === 'reported';
  const rawSubscores: Record<string, string> = {};
  if (isReported) {
    if (ielts.listening.trim() !== '') rawSubscores.listening = ielts.listening.trim();
    if (ielts.reading.trim() !== '') rawSubscores.reading = ielts.reading.trim();
    if (ielts.writing.trim() !== '') rawSubscores.writing = ielts.writing.trim();
    if (ielts.speaking.trim() !== '') rawSubscores.speaking = ielts.speaking.trim();
  }

  return {
    scoreStatus: ielts.scoreStatus,
    overallScore: isReported && ielts.overallScore.trim() !== '' ? ielts.overallScore.trim() : null,
    subscores: isReported && Object.keys(rawSubscores).length > 0 ? rawSubscores : null,
    plannedTestDate: ielts.plannedTestDate.trim() === '' ? null : ielts.plannedTestDate.trim(),
    testDate: ielts.testDate.trim() === '' ? null : ielts.testDate.trim(),
    waiverReason: ielts.scoreStatus === 'waived' ? ielts.waiverReason.trim() || null : null,
  };
}

export function buildRawStudentProfilePayload(form: StudentProfileFormState): unknown {
  return {
    admissions: {
      countryOfCitizenship: form.admissions.countryOfCitizenship || null,
      countryOfResidence: form.admissions.countryOfResidence || null,
      city: form.admissions.city || null,
      birthYear: form.admissions.birthYear.trim() === '' ? null : form.admissions.birthYear.trim(),
      targetStudyLevel: form.admissions.targetStudyLevel || null,
      targetIntakeTerm: form.admissions.targetIntakeTerm || null,
      targetCountries: parseTargetCountriesList(form.admissions.targetCountriesInput),
      preferredFieldOfStudy: form.admissions.preferredFieldOfStudy || null,
      annualBudgetAmount:
        form.admissions.annualBudgetAmount.trim() === ''
          ? null
          : form.admissions.annualBudgetAmount.trim(),
      annualBudgetCurrency: form.admissions.annualBudgetCurrency || null,
      fundingNeed: form.admissions.fundingNeed || null,
    },
    ssc: buildQualificationRawPayload(form.ssc),
    hsc: buildQualificationRawPayload(form.hsc),
    ielts: buildIeltsRawPayload(form.ielts),
  };
}

export function validateStudentProfileForm(
  form: StudentProfileFormState,
):
  | { ok: true; data: StudentProfileUpdateRequest }
  | { ok: false; errors: string[] } {
  const rawPayload = buildRawStudentProfilePayload(form);
  const parsed = studentProfileUpdateRequestSchema.safeParse(rawPayload);

  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }

  return {
    ok: false,
    errors: formatZodIssues(parsed.error),
  };
}

export function formatZodIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return `${path}${issue.message}`;
  });
}

export function estimateFormCompletion(
  form: StudentProfileFormState,
): StudentProfileCompletionDto {
  const parsed = studentProfileUpdateRequestSchema.safeParse(buildRawStudentProfilePayload(form));
  if (parsed.success) {
    return computeStudentProfileCompletion(parsed.data);
  }

  return computeStudentProfileCompletion({
    admissions: {
      countryOfCitizenship: form.admissions.countryOfCitizenship.trim() || null,
      targetStudyLevel: form.admissions.targetStudyLevel || null,
      targetIntakeTerm: form.admissions.targetIntakeTerm.trim() || null,
      targetCountries: parseTargetCountriesList(form.admissions.targetCountriesInput),
      preferredFieldOfStudy: form.admissions.preferredFieldOfStudy.trim() || null,
      fundingNeed: form.admissions.fundingNeed || null,
    },
    ssc: form.ssc.enabled
      ? {
          boardOrInstitution: form.ssc.boardOrInstitution,
          scoreValue: form.ssc.scoreValue.trim() ? Number(form.ssc.scoreValue) : null,
        }
      : null,
    hsc: form.hsc.enabled
      ? {
          boardOrInstitution: form.hsc.boardOrInstitution,
          scoreValue: form.hsc.scoreValue.trim() ? Number(form.hsc.scoreValue) : null,
        }
      : null,
    ielts: form.ielts.enabled
      ? {
          scoreStatus: form.ielts.scoreStatus,
          overallScore: form.ielts.overallScore.trim()
            ? Number(form.ielts.overallScore)
            : null,
          plannedTestDate: form.ielts.plannedTestDate.trim() || null,
          waiverReason: form.ielts.waiverReason.trim() || null,
        }
      : null,
  });
}
