import { describe, expect, it, vi } from 'vitest';
import {
  buildRawStudentProfilePayload,
  estimateFormCompletion,
  loadStudentProfileWithAuth,
  runWithTokenRefresh,
  toStudentProfileFormState,
  updateStudentProfileWithAuth,
  validateStudentProfileForm,
} from '@/features/student/studentProfileClient';
import {
  ApiClientError,
  fetchStudentProfile,
  saveStudentProfile,
} from '@/lib/apiClient';
import type { StudentProfileResponse } from '@shared/schemas/studentProfile.schema';

const SAMPLE_PROFILE_RESPONSE: StudentProfileResponse = {
  admissions: {
    countryOfCitizenship: 'BD',
    countryOfResidence: 'BD',
    city: 'Dhaka',
    birthYear: 2005,
    targetStudyLevel: 'undergraduate',
    targetIntakeTerm: 'Fall 2027',
    targetCountries: ['GB', 'CA'],
    preferredFieldOfStudy: 'Computer Science',
    annualBudgetAmount: 25000,
    annualBudgetCurrency: 'USD',
    fundingNeed: 'partial_scholarship_needed',
    onboardingCompletedAt: '2026-11-22T10:00:00.000Z',
    updatedAt: '2026-11-22T10:00:00.000Z',
  },
  ssc: {
    qualificationLevel: 'secondary',
    boardOrInstitution: 'Dhaka Board',
    countryCode: 'BD',
    fieldOfStudy: 'Science',
    gradingScaleCode: 'gpa_5',
    scoreValue: 5,
    maxScoreValue: 5,
    completionYear: 2021,
    isCompleted: true,
    verificationMethod: 'self_reported',
    isVerified: false,
    updatedAt: '2026-11-22T10:00:00.000Z',
  },
  hsc: {
    qualificationLevel: 'higher_secondary',
    boardOrInstitution: 'Notre Dame College',
    countryCode: 'BD',
    fieldOfStudy: 'Science',
    gradingScaleCode: 'gpa_5',
    scoreValue: 4.9,
    maxScoreValue: 5,
    completionYear: 2023,
    isCompleted: true,
    verificationMethod: 'self_reported',
    isVerified: false,
    updatedAt: '2026-11-22T10:00:00.000Z',
  },
  ielts: {
    testCode: 'ielts',
    scoreStatus: 'reported',
    overallScore: 7.5,
    subscores: {
      listening: 8,
      reading: 7.5,
      writing: 7,
      speaking: 7.5,
    },
    plannedTestDate: null,
    testDate: '2026-08-15',
    waiverReason: null,
    verificationMethod: 'self_reported',
    isVerified: false,
    updatedAt: '2026-11-22T10:00:00.000Z',
  },
  completion: {
    completedSections: 4,
    totalSections: 4,
    percentage: 100,
    isComplete: true,
    missingItems: [],
  },
  gradingScales: [
    { code: 'gpa_5', name: 'GPA (5.0 Scale)', countryCode: 'BD', minValue: 0, maxValue: 5 },
    { code: 'percentage', name: 'Percentage (%)', countryCode: null, minValue: 0, maxValue: 100 },
  ],
};

describe('Phase 8B.6B Frontend Student Profile API Client & Form Logic', () => {
  it('rejects empty or invalid tokens cleanly without calling fetch', async () => {
    const fetcher = vi.fn();

    await expect(fetchStudentProfile('  ', fetcher as unknown as typeof fetch)).rejects.toMatchObject({
      status: 401,
      code: 'AUTH_TOKEN_MISSING',
    });

    await expect(
      saveStudentProfile(
        'bad token',
        { admissions: { targetCountries: [] }, ssc: null, hsc: null, ielts: null } as never,
        fetcher as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({
      status: 401,
      code: 'AUTH_TOKEN_MISSING',
    });

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fetches and saves student profile with Bearer header, no-store, and strict Zod validation', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(SAMPLE_PROFILE_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(SAMPLE_PROFILE_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const loaded = await fetchStudentProfile('jwt.header.sig', fetcher as unknown as typeof fetch);
    expect(loaded).toEqual(SAMPLE_PROFILE_RESPONSE);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/student/profile');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      headers: { Authorization: 'Bearer jwt.header.sig' },
    });

    const form = toStudentProfileFormState(loaded);
    const validated = validateStudentProfileForm(form);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const saved = await saveStudentProfile(
      'jwt.header.sig',
      validated.data,
      fetcher as unknown as typeof fetch,
    );
    expect(saved.completion.percentage).toBe(100);
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/student/profile');
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: 'PUT',
      cache: 'no-store',
      headers: {
        Authorization: 'Bearer jwt.header.sig',
        'Content-Type': 'application/json',
      },
    });
  });

  it('recovers from 401 once via getAccessToken({ forceRefresh: true }) and stops on non-401 errors', async () => {
    const getAccessToken = vi
      .fn()
      .mockResolvedValueOnce('stale.jwt.token')
      .mockResolvedValueOnce('fresh.jwt.token');

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 'AUTH_TOKEN_EXPIRED',
              message: 'Token expired',
            },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(SAMPLE_PROFILE_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const result = await loadStudentProfileWithAuth(
      getAccessToken,
      fetcher as unknown as typeof fetch,
    );
    expect(result.admissions.city).toBe('Dhaka');
    expect(getAccessToken).toHaveBeenNthCalledWith(1);
    expect(getAccessToken).toHaveBeenNthCalledWith(2, { forceRefresh: true });

    // 403 / 409 errors do not trigger token refresh
    const lockedGetToken = vi.fn().mockResolvedValue('valid.jwt.token');
    const lockedFetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'CREDENTIAL_VERIFIED_LOCKED',
            message: 'Verified credential locked',
          },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const validated = validateStudentProfileForm(toStudentProfileFormState(SAMPLE_PROFILE_RESPONSE));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    await expect(
      updateStudentProfileWithAuth(
        lockedGetToken,
        validated.data,
        lockedFetcher as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: 'CREDENTIAL_VERIFIED_LOCKED',
    });
    expect(lockedGetToken).toHaveBeenCalledTimes(1);

    // Unauthenticated missing token throws immediately without retry
    await expect(
      runWithTokenRefresh(async () => null, async () => 'never'),
    ).rejects.toBeInstanceOf(ApiClientError);
  });

  it('validates form rules for budget+currency, SSC GPA bounds, IELTS step increments, and completion estimate', () => {
    const baseForm = toStudentProfileFormState(SAMPLE_PROFILE_RESPONSE);

    // Valid complete profile -> 100%
    expect(estimateFormCompletion(baseForm).percentage).toBe(100);

    // Budget without currency -> validation failure
    const missingCurrencyForm = {
      ...baseForm,
      admissions: {
        ...baseForm.admissions,
        annualBudgetAmount: '15000',
        annualBudgetCurrency: '',
      },
    };
    const currencyCheck = validateStudentProfileForm(missingCurrencyForm);
    expect(currencyCheck.ok).toBe(false);
    if (!currencyCheck.ok) {
      expect(currencyCheck.errors.some((e) => e.includes('Currency is required'))).toBe(true);
    }

    // SSC score > scale max -> validation failure
    const badSscForm = {
      ...baseForm,
      ssc: {
        ...baseForm.ssc,
        scoreValue: '5.5',
      },
    };
    const sscCheck = validateStudentProfileForm(badSscForm);
    expect(sscCheck.ok).toBe(false);

    // Non-0.5 IELTS increment -> validation failure
    const badIeltsForm = {
      ...baseForm,
      ielts: {
        ...baseForm.ielts,
        overallScore: '7.2',
      },
    };
    const ieltsCheck = validateStudentProfileForm(badIeltsForm);
    expect(ieltsCheck.ok).toBe(false);

    // Switching IELTS away from 'reported' clears numeric scores in raw payload
    const plannedPayload = buildRawStudentProfilePayload({
      ...baseForm,
      ielts: {
        ...baseForm.ielts,
        scoreStatus: 'planned',
        plannedTestDate: '2027-01-20',
      },
    }) as { ielts: { overallScore: unknown; subscores: unknown } };
    expect(plannedPayload.ielts.overallScore).toBeNull();
    expect(plannedPayload.ielts.subscores).toBeNull();
  });
});
