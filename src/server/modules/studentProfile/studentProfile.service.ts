import {
  computeStudentProfileCompletion,
  studentProfileResponseSchema,
  type StudentProfileResponse,
  type StudentProfileUpdateRequest,
} from '../../../shared/schemas/studentProfile.schema';
import type {
  StudentProfileRecord,
  StudentProfileRepository,
} from './studentProfile.repository';

function toResponseDto(record: StudentProfileRecord): StudentProfileResponse {
  const completion = computeStudentProfileCompletion({
    admissions: record.admissions,
    ssc: record.ssc,
    hsc: record.hsc,
    ielts: record.ielts,
  });

  return studentProfileResponseSchema.parse({
    admissions: {
      countryOfCitizenship: record.admissions.countryOfCitizenship,
      countryOfResidence: record.admissions.countryOfResidence,
      city: record.admissions.city,
      birthYear: record.admissions.birthYear,
      targetStudyLevel: record.admissions.targetStudyLevel,
      targetIntakeTerm: record.admissions.targetIntakeTerm,
      targetCountries: record.admissions.targetCountries,
      preferredFieldOfStudy: record.admissions.preferredFieldOfStudy,
      annualBudgetAmount: record.admissions.annualBudgetAmount,
      annualBudgetCurrency: record.admissions.annualBudgetCurrency,
      fundingNeed: record.admissions.fundingNeed,
      onboardingCompletedAt: record.admissions.onboardingCompletedAt
        ? record.admissions.onboardingCompletedAt.toISOString()
        : null,
      updatedAt: record.admissions.updatedAt
        ? record.admissions.updatedAt.toISOString()
        : null,
    },
    ssc: record.ssc
      ? {
          qualificationLevel: 'secondary',
          boardOrInstitution: record.ssc.boardOrInstitution,
          countryCode: record.ssc.countryCode,
          fieldOfStudy: record.ssc.fieldOfStudy,
          gradingScaleCode: record.ssc.gradingScaleCode,
          scoreValue: record.ssc.scoreValue,
          maxScoreValue: record.ssc.maxScoreValue,
          completionYear: record.ssc.completionYear,
          isCompleted: record.ssc.isCompleted,
          verificationMethod: record.ssc.verificationMethod,
          isVerified: record.ssc.isVerified,
          updatedAt: record.ssc.updatedAt.toISOString(),
        }
      : null,
    hsc: record.hsc
      ? {
          qualificationLevel: 'higher_secondary',
          boardOrInstitution: record.hsc.boardOrInstitution,
          countryCode: record.hsc.countryCode,
          fieldOfStudy: record.hsc.fieldOfStudy,
          gradingScaleCode: record.hsc.gradingScaleCode,
          scoreValue: record.hsc.scoreValue,
          maxScoreValue: record.hsc.maxScoreValue,
          completionYear: record.hsc.completionYear,
          isCompleted: record.hsc.isCompleted,
          verificationMethod: record.hsc.verificationMethod,
          isVerified: record.hsc.isVerified,
          updatedAt: record.hsc.updatedAt.toISOString(),
        }
      : null,
    ielts: record.ielts
      ? {
          testCode: 'ielts',
          scoreStatus: record.ielts.scoreStatus,
          overallScore: record.ielts.overallScore,
          subscores: record.ielts.subscores,
          plannedTestDate: record.ielts.plannedTestDate,
          testDate: record.ielts.testDate,
          waiverReason: record.ielts.waiverReason,
          verificationMethod: record.ielts.verificationMethod,
          isVerified: record.ielts.isVerified,
          updatedAt: record.ielts.updatedAt.toISOString(),
        }
      : null,
    completion,
    gradingScales: record.gradingScales,
  });
}

export class StudentProfileService {
  constructor(private readonly repo: StudentProfileRepository) {}

  public async getProfile(userId: string): Promise<StudentProfileResponse> {
    const record = await this.repo.getStudentProfileByUserId(userId);
    return toResponseDto(record);
  }

  public async saveProfile(
    userId: string,
    input: StudentProfileUpdateRequest,
  ): Promise<StudentProfileResponse> {
    const completion = computeStudentProfileCompletion({
      admissions: input.admissions,
      ssc: input.ssc,
      hsc: input.hsc,
      ielts: input.ielts,
    });

    const record = await this.repo.upsertStudentProfileTransactional(userId, input, {
      onboardingCompletedAt: completion.isComplete ? new Date() : null,
    });

    return toResponseDto(record);
  }
}

export function createStudentProfileService(repo: StudentProfileRepository): StudentProfileService {
  return new StudentProfileService(repo);
}
