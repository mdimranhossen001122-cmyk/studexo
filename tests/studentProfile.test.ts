import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { parseEnv } from '../src/server/config/env';
import type { StudexoDatabase } from '../src/server/db/client';
import { closeAllDbs } from '../src/server/db/index';
import * as schema from '../src/server/db/schema/index';
import {
  studentProfiles,
  studentQualifications,
  studentTestScores,
} from '../src/server/db/schema/profiles';
import { DEFAULT_GRADING_SCALES, gradingScales } from '../src/server/db/schema/reference';
import { createLogger } from '../src/server/lib/logger';
import { AppError } from '../src/server/middleware/errorHandler';
import type {
  AuthRepository,
  ProvisionUserParams,
  UserRecordWithIdentities,
} from '../src/server/modules/auth/auth.repository';
import { AuthService } from '../src/server/modules/auth/auth.service';
import { MockTokenVerifier } from '../src/server/modules/auth/tokenVerifier';
import {
  createPostgresStudentProfileRepository,
  deriveStudentProfileLockId,
  PostgresStudentProfileRepository,
  type StoredGradingScaleOption,
  type StoredStudentAdmissionsRow,
  type StoredStudentIeltsRow,
  type StoredStudentQualificationRow,
  type StudentProfileRecord,
  type StudentProfileRepository,
} from '../src/server/modules/studentProfile/studentProfile.repository';
import {
  createStudentProfileService,
  StudentProfileService,
} from '../src/server/modules/studentProfile/studentProfile.service';
import {
  computeStudentProfileCompletion,
  GRADING_SCALE_NUMERIC_MAX,
  studentProfileResponseSchema,
  studentProfileUpdateRequestSchema,
  type StudentProfileUpdateRequest,
} from '../src/shared/schemas/studentProfile.schema';
import type { SupportedAuthProvider } from '../src/shared/types/auth';

class InMemoryAuthRepository implements AuthRepository {
  public readonly usersBySub = new Map<string, UserRecordWithIdentities>();

  public seedUser(record: UserRecordWithIdentities): void {
    this.usersBySub.set(record.user.supabaseAuthUserId.toLowerCase(), record);
  }

  public async findUserBySupabaseAuthId(sub: string): Promise<UserRecordWithIdentities | null> {
    return this.usersBySub.get(sub.trim().toLowerCase()) ?? null;
  }

  public async findUserByProviderIdentity(): Promise<UserRecordWithIdentities | null> {
    return null;
  }

  public async findUserByEmail() {
    return null;
  }

  public async checkIsAuthUserPendingPurge(): Promise<boolean> {
    return false;
  }

  public async provisionUserAtomic(params: ProvisionUserParams): Promise<UserRecordWithIdentities> {
    const record: UserRecordWithIdentities = {
      user: {
        id: crypto.randomUUID(),
        supabaseAuthUserId: params.supabaseAuthUserId,
        primaryEmail: params.primaryEmail.toLowerCase(),
        displayName: params.displayName ?? null,
        role: 'student',
        status: 'active',
        purgeState: 'none',
        deletionRequestedAt: null,
        deletionScheduledFor: null,
      },
      identities: params.identities.map((i) => ({
        provider: i.provider,
        providerSubject: i.providerSubject,
        emailAtProvider: i.emailAtProvider ?? params.primaryEmail,
        emailVerified: i.emailVerified,
      })),
      settings: {
        preferredLocale: params.preferredLocale ?? 'en',
        preferredCurrency: params.preferredCurrency ?? 'USD',
        timezone: params.timezone ?? 'Asia/Dhaka',
        marketingOptIn: false,
      },
    };
    this.seedUser(record);
    return record;
  }

  public async updateIdentityLastSignIn(
    _userId: string,
    _provider: SupportedAuthProvider,
    _providerSubject: string,
  ): Promise<void> {}
}

class InMemoryStudentProfileRepository implements StudentProfileRepository {
  public readonly admissionsByUser = new Map<string, StoredStudentAdmissionsRow>();
  public readonly qualificationsByUser = new Map<string, StoredStudentQualificationRow[]>();
  public readonly ieltsByUser = new Map<string, StoredStudentIeltsRow[]>();
  public simulatedWriteFailureAtStep: 'after_admissions' | 'after_ssc' | null = null;

  private readonly gradingScales: StoredGradingScaleOption[] = DEFAULT_GRADING_SCALES.map((s) => ({
    code: s.code,
    name: s.name,
    countryCode: s.countryCode,
    minValue: s.minValue === null ? null : Number(s.minValue),
    maxValue: s.maxValue === null ? null : Number(s.maxValue),
  }));

  public seedVerifiedQualification(
    userId: string,
    level: 'secondary' | 'higher_secondary',
  ): void {
    const existing = this.qualificationsByUser.get(userId) ?? [];
    existing.push({
      id: crypto.randomUUID(),
      qualificationLevel: level,
      boardOrInstitution: 'Dhaka Board',
      countryCode: 'BD',
      fieldOfStudy: 'Science',
      gradingScaleCode: 'gpa_5',
      scoreValue: 5,
      maxScoreValue: 5,
      completionYear: 2022,
      isCompleted: true,
      verificationMethod: 'document_evidence',
      isVerified: true,
      updatedAt: new Date(),
    });
    this.qualificationsByUser.set(userId, existing);
  }

  public async getStudentProfileByUserId(userId: string): Promise<StudentProfileRecord> {
    const admissions = this.admissionsByUser.get(userId) ?? {
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

    const quals = this.qualificationsByUser.get(userId) ?? [];
    const ssc = quals.find((q) => q.qualificationLevel === 'secondary') ?? null;
    const hsc = quals.find((q) => q.qualificationLevel === 'higher_secondary') ?? null;
    const ielts = (this.ieltsByUser.get(userId) ?? [])[0] ?? null;

    return {
      admissions,
      ssc,
      hsc,
      ielts,
      gradingScales: this.gradingScales,
    };
  }

  public async upsertStudentProfileTransactional(
    userId: string,
    input: StudentProfileUpdateRequest,
    options: { onboardingCompletedAt: Date | null },
  ): Promise<StudentProfileRecord> {
    // Snapshot prior state to emulate database transaction rollback on failure
    const snapshotAdmissions = this.admissionsByUser.get(userId);
    const snapshotQuals = structuredClone(this.qualificationsByUser.get(userId));
    const snapshotIelts = structuredClone(this.ieltsByUser.get(userId));

    try {
      const now = new Date();
      const prevAdmissions = this.admissionsByUser.get(userId);
      this.admissionsByUser.set(userId, {
        countryOfCitizenship: input.admissions.countryOfCitizenship,
        countryOfResidence: input.admissions.countryOfResidence,
        city: input.admissions.city,
        birthYear: input.admissions.birthYear,
        targetStudyLevel: input.admissions.targetStudyLevel,
        targetIntakeTerm: input.admissions.targetIntakeTerm,
        targetCountries: [...input.admissions.targetCountries],
        preferredFieldOfStudy: input.admissions.preferredFieldOfStudy,
        annualBudgetAmount: input.admissions.annualBudgetAmount,
        annualBudgetCurrency: input.admissions.annualBudgetCurrency,
        fundingNeed: input.admissions.fundingNeed,
        onboardingCompletedAt: options.onboardingCompletedAt
          ? (prevAdmissions?.onboardingCompletedAt ?? options.onboardingCompletedAt)
          : null,
        updatedAt: now,
      });

      if (this.simulatedWriteFailureAtStep === 'after_admissions') {
        throw new Error('Simulated mid-transaction failure after admissions');
      }

      const existingQuals = [...(this.qualificationsByUser.get(userId) ?? [])];
      const nextQuals: StoredStudentQualificationRow[] = [];

      const upsertLevel = (
        level: 'secondary' | 'higher_secondary',
        payload: StudentProfileUpdateRequest['ssc'],
      ) => {
        const matches = existingQuals.filter((q) => q.qualificationLevel === level);
        if (matches.some((m) => m.isVerified)) {
          throw new AppError(
            409,
            'CREDENTIAL_VERIFIED_LOCKED',
            `Your ${level === 'secondary' ? 'SSC' : 'HSC'} record has already been verified.`,
          );
        }
        if (!payload) return;
        const primary = matches[0];
        nextQuals.push({
          id: primary?.id ?? crypto.randomUUID(),
          qualificationLevel: level,
          boardOrInstitution: payload.boardOrInstitution,
          countryCode: payload.countryCode,
          fieldOfStudy: payload.fieldOfStudy,
          gradingScaleCode: payload.gradingScaleCode,
          scoreValue: payload.scoreValue,
          maxScoreValue:
            payload.maxScoreValue ?? GRADING_SCALE_NUMERIC_MAX[payload.gradingScaleCode],
          completionYear: payload.completionYear,
          isCompleted: payload.isCompleted,
          verificationMethod: 'self_reported',
          isVerified: false,
          updatedAt: now,
        });
      };

      upsertLevel('secondary', input.ssc);
      if (this.simulatedWriteFailureAtStep === 'after_ssc') {
        throw new Error('Simulated mid-transaction failure after SSC');
      }
      upsertLevel('higher_secondary', input.hsc);
      this.qualificationsByUser.set(userId, nextQuals);

      const existingIelts = [...(this.ieltsByUser.get(userId) ?? [])];
      if (existingIelts.some((i) => i.isVerified)) {
        throw new AppError(
          409,
          'CREDENTIAL_VERIFIED_LOCKED',
          'Your IELTS record has already been verified.',
        );
      }
      if (!input.ielts) {
        this.ieltsByUser.set(userId, []);
      } else {
        const primary = existingIelts[0];
        this.ieltsByUser.set(userId, [
          {
            id: primary?.id ?? crypto.randomUUID(),
            testCode: 'ielts',
            scoreStatus: input.ielts.scoreStatus,
            overallScore:
              input.ielts.scoreStatus === 'reported' ? input.ielts.overallScore : null,
            subscores: input.ielts.scoreStatus === 'reported' ? input.ielts.subscores : null,
            plannedTestDate: input.ielts.plannedTestDate,
            testDate: input.ielts.testDate,
            waiverReason:
              input.ielts.scoreStatus === 'waived' ? input.ielts.waiverReason : null,
            verificationMethod: 'self_reported',
            isVerified: false,
            updatedAt: now,
          },
        ]);
      }

      return this.getStudentProfileByUserId(userId);
    } catch (err) {
      if (snapshotAdmissions) {
        this.admissionsByUser.set(userId, snapshotAdmissions);
      } else {
        this.admissionsByUser.delete(userId);
      }
      if (snapshotQuals) {
        this.qualificationsByUser.set(userId, snapshotQuals);
      } else {
        this.qualificationsByUser.delete(userId);
      }
      if (snapshotIelts) {
        this.ieltsByUser.set(userId, snapshotIelts);
      } else {
        this.ieltsByUser.delete(userId);
      }
      throw err;
    }
  }
}

function buildCompleteProfilePayload(
  overrides: Partial<StudentProfileUpdateRequest> = {},
): StudentProfileUpdateRequest {
  return studentProfileUpdateRequestSchema.parse({
    admissions: {
      countryOfCitizenship: 'bd',
      countryOfResidence: 'bd',
      city: 'Dhaka',
      birthYear: 2005,
      targetStudyLevel: 'undergraduate',
      targetIntakeTerm: 'Fall 2027',
      targetCountries: ['gb', 'ca'],
      preferredFieldOfStudy: 'Computer Science',
      annualBudgetAmount: 22000,
      annualBudgetCurrency: 'usd',
      fundingNeed: 'partial_scholarship_needed',
    },
    ssc: {
      boardOrInstitution: 'Dhaka Board',
      countryCode: 'bd',
      fieldOfStudy: 'Science',
      gradingScaleCode: 'gpa_5',
      scoreValue: 5.0,
      maxScoreValue: 5.0,
      completionYear: 2021,
      isCompleted: true,
    },
    hsc: {
      boardOrInstitution: 'Notre Dame College, Dhaka',
      countryCode: 'bd',
      fieldOfStudy: 'Science',
      gradingScaleCode: 'gpa_5',
      scoreValue: 4.92,
      maxScoreValue: 5.0,
      completionYear: 2023,
      isCompleted: true,
    },
    ielts: {
      scoreStatus: 'reported',
      overallScore: 7.5,
      subscores: {
        listening: 8.0,
        reading: 7.5,
        writing: 7.0,
        speaking: 7.5,
      },
      plannedTestDate: null,
      testDate: '2026-08-15',
      waiverReason: null,
    },
    ...overrides,
  });
}

describe('Phase 8B.6B — Student Admissions Profile, SSC/HSC & IELTS Readiness', () => {
  const STUDENT_A_SUB = '10000000-0000-4000-8000-000000000001';
  const STUDENT_B_SUB = '10000000-0000-4000-8000-000000000002';
  const COUNSELOR_SUB = '10000000-0000-4000-8000-000000000003';
  const ADMIN_SUB = '10000000-0000-4000-8000-000000000004';

  afterEach(async () => {
    await closeAllDbs();
  });

  function createHarness() {
    const spyStream = new PassThrough();
    const logger = createLogger('silent', spyStream);
    const mockVerifier = new MockTokenVerifier();
    const authRepo = new InMemoryAuthRepository();
    const authService = new AuthService(authRepo);
    const profileRepo = new InMemoryStudentProfileRepository();
    const studentProfileService = createStudentProfileService(profileRepo);
    const env = parseEnv({ NODE_ENV: 'test' });

    const seedActor = (sub: string, email: string, role: 'student' | 'counselor' | 'admin') => {
      const id = crypto.randomUUID();
      authRepo.seedUser({
        user: {
          id,
          supabaseAuthUserId: sub,
          primaryEmail: email,
          displayName: `${role.toUpperCase()} User`,
          role,
          status: 'active',
          purgeState: 'none',
          deletionRequestedAt: null,
          deletionScheduledFor: null,
        },
        identities: [
          {
            provider: 'supabase_email',
            providerSubject: sub,
            emailAtProvider: email,
            emailVerified: true,
          },
        ],
      });
      return {
        userId: id,
        token: mockVerifier.mintToken({ sub, email }),
      };
    };

    const studentA = seedActor(STUDENT_A_SUB, 'student.a@studexo.test', 'student');
    const studentB = seedActor(STUDENT_B_SUB, 'student.b@studexo.test', 'student');
    const counselor = seedActor(COUNSELOR_SUB, 'counselor@studexo.test', 'counselor');
    const admin = seedActor(ADMIN_SUB, 'admin@studexo.test', 'admin');

    const { app } = createApp({
      env,
      logger,
      checkDatabaseReadiness: async () => ({ configured: true, connected: true }),
      authDependencies: {
        tokenVerifier: mockVerifier,
        authService,
      },
      studentProfileService,
    });

    return {
      app,
      profileRepo,
      studentA,
      studentB,
      counselor,
      admin,
    };
  }

  describe('1. Authentication, RBAC & Cross-Student Isolation', () => {
    it('returns 401 for unauthenticated GET and PUT /api/student/profile', async () => {
      const { app } = createHarness();

      const getRes = await request(app).get('/api/student/profile');
      expect(getRes.status).toBe(401);
      expect(getRes.headers['www-authenticate']).toBe('Bearer');

      const putRes = await request(app)
        .put('/api/student/profile')
        .send(buildCompleteProfilePayload());
      expect(putRes.status).toBe(401);
      expect(putRes.headers['www-authenticate']).toBe('Bearer');
    });

    it('rejects counselor and admin roles with 403 AUTH_FORBIDDEN on student profile endpoints', async () => {
      const { app, counselor, admin } = createHarness();

      for (const actor of [counselor, admin]) {
        const getRes = await request(app)
          .get('/api/student/profile')
          .set('Authorization', `Bearer ${actor.token}`);
        expect(getRes.status).toBe(403);
        expect(getRes.body.error.code).toBe('AUTH_FORBIDDEN');

        const putRes = await request(app)
          .put('/api/student/profile')
          .set('Authorization', `Bearer ${actor.token}`)
          .send(buildCompleteProfilePayload());
        expect(putRes.status).toBe(403);
        expect(putRes.body.error.code).toBe('AUTH_FORBIDDEN');
      }
    });

    it('isolates profile reads and writes strictly per authenticated student.id', async () => {
      const { app, studentA, studentB } = createHarness();

      const payloadA = buildCompleteProfilePayload();
      const saveA = await request(app)
        .put('/api/student/profile')
        .set('Authorization', `Bearer ${studentA.token}`)
        .send(payloadA);
      expect(saveA.status).toBe(200);
      expect(saveA.body.completion.percentage).toBe(100);

      // Student B still sees empty 0% profile
      const getB = await request(app)
        .get('/api/student/profile')
        .set('Authorization', `Bearer ${studentB.token}`);
      expect(getB.status).toBe(200);
      expect(getB.body.admissions.countryOfCitizenship).toBeNull();
      expect(getB.body.ssc).toBeNull();
      expect(getB.body.hsc).toBeNull();
      expect(getB.body.ielts).toBeNull();
      expect(getB.body.completion.percentage).toBe(0);
    });
  });

  describe('2. Strict Zod Validation & Forged Ownership/Provenance Rejection', () => {
    it('rejects forged ownership, verification, or catalog fields with 400 VALIDATION_ERROR', async () => {
      const { app, studentA, studentB } = createHarness();

      const forgedPayloads: Array<Record<string, unknown>> = [
        { ...buildCompleteProfilePayload(), userId: studentB.userId },
        { ...buildCompleteProfilePayload(), id: crypto.randomUUID() },
        {
          admissions: { countryOfCitizenship: 'BD', userId: studentB.userId },
          ssc: null,
          hsc: null,
          ielts: null,
        },
        {
          admissions: { countryOfCitizenship: 'BD' },
          ssc: {
            boardOrInstitution: 'Dhaka Board',
            countryCode: 'BD',
            gradingScaleCode: 'gpa_5',
            isVerified: true,
          },
          hsc: null,
          ielts: null,
        },
        {
          admissions: { countryOfCitizenship: 'BD' },
          ssc: {
            boardOrInstitution: 'Dhaka Board',
            countryCode: 'BD',
            gradingScaleCode: 'gpa_5',
            verificationMethod: 'admin_verified',
          },
          hsc: null,
          ielts: null,
        },
        {
          admissions: { countryOfCitizenship: 'BD' },
          ssc: {
            boardOrInstitution: 'Dhaka Board',
            countryCode: 'BD',
            gradingScaleCode: 'gpa_5',
            qualificationLevel: 'higher_secondary',
          },
          hsc: null,
          ielts: null,
        },
        {
          admissions: { countryOfCitizenship: 'BD' },
          ssc: null,
          hsc: null,
          ielts: {
            scoreStatus: 'planned',
            testCode: 'toefl_ibt',
          },
        },
        {
          admissions: { countryOfCitizenship: 'BD' },
          ssc: null,
          hsc: null,
          ielts: {
            scoreStatus: 'reported',
            overallScore: 7.5,
            verifiedByUserId: studentB.userId,
          },
        },
      ];

      for (const body of forgedPayloads) {
        const res = await request(app)
          .put('/api/student/profile')
          .set('Authorization', `Bearer ${studentA.token}`)
          .send(body);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('rejects budget amount without currency (400 VALIDATION_ERROR)', async () => {
      const { app, studentA } = createHarness();
      const res = await request(app)
        .put('/api/student/profile')
        .set('Authorization', `Bearer ${studentA.token}`)
        .send({
          admissions: {
            annualBudgetAmount: 15000,
            annualBudgetCurrency: null,
          },
          ssc: null,
          hsc: null,
          ielts: null,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects invalid SSC/HSC scores and scale mismatches (400 VALIDATION_ERROR)', async () => {
      const { app, studentA } = createHarness();

      const badQuals = [
        // Negative score
        {
          boardOrInstitution: 'Dhaka Board',
          countryCode: 'BD',
          gradingScaleCode: 'gpa_5',
          scoreValue: -0.5,
          maxScoreValue: 5,
        },
        // scoreValue exceeds maxScoreValue
        {
          boardOrInstitution: 'Dhaka Board',
          countryCode: 'BD',
          gradingScaleCode: 'gpa_5',
          scoreValue: 5.0,
          maxScoreValue: 4.0,
        },
        // Exceeds gpa_5 ceiling (5.5 > 5)
        {
          boardOrInstitution: 'Dhaka Board',
          countryCode: 'BD',
          gradingScaleCode: 'gpa_5',
          scoreValue: 5.5,
        },
        // Exceeds percentage ceiling (105 > 100)
        {
          boardOrInstitution: 'CBSE',
          countryCode: 'IN',
          gradingScaleCode: 'percentage',
          scoreValue: 105,
        },
        // Max score > scale max for gpa_4
        {
          boardOrInstitution: 'Private Board',
          countryCode: 'BD',
          gradingScaleCode: 'gpa_4',
          scoreValue: 3.8,
          maxScoreValue: 5.0,
        },
      ];

      for (const ssc of badQuals) {
        const res = await request(app)
          .put('/api/student/profile')
          .set('Authorization', `Bearer ${studentA.token}`)
          .send({
            admissions: {},
            ssc,
            hsc: null,
            ielts: null,
          });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('rejects invalid IELTS bands, missing reported score, numeric score on non-reported status, missing waiverReason, and invalid dates', async () => {
      const { app, studentA } = createHarness();

      const badIeltsCases: unknown[] = [
        { scoreStatus: 'reported', overallScore: 9.5 },
        { scoreStatus: 'reported', overallScore: -0.5 },
        { scoreStatus: 'reported', overallScore: 7.3 },
        { scoreStatus: 'reported', overallScore: null },
        { scoreStatus: 'reported', overallScore: 7.0, subscores: { speaking: 7.2 } },
        { scoreStatus: 'planned', overallScore: 7.0 },
        { scoreStatus: 'planned', overallScore: null, subscores: { reading: 6.5 } },
        { scoreStatus: 'waived', waiverReason: '   ' },
        { scoreStatus: 'planned', plannedTestDate: '2026-02-30' },
      ];

      for (const ielts of badIeltsCases) {
        const res = await request(app)
          .put('/api/student/profile')
          .set('Authorization', `Bearer ${studentA.token}`)
          .send({
            admissions: {},
            ssc: null,
            hsc: null,
            ielts,
          });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('3. Round-Trip Persistence, Idempotent In-Place Updates & Verified Lock Guard', () => {
    it('supports initial empty GET (0%), partial PUT, full PUT, and GET round-trip with Cache-Control: no-store', async () => {
      const { app, studentA } = createHarness();

      // Initial GET
      const initialGet = await request(app)
        .get('/api/student/profile')
        .set('Authorization', `Bearer ${studentA.token}`);
      expect(initialGet.status).toBe(200);
      expect(initialGet.headers['cache-control']).toBe('no-store');
      const parsedInit = studentProfileResponseSchema.parse(initialGet.body);
      expect(parsedInit.completion.percentage).toBe(0);
      expect(parsedInit.gradingScales.length).toBeGreaterThanOrEqual(6);

      // Partial PUT (only admissions goals + planned IELTS = 2/4 -> 50%)
      const partialPut = await request(app)
        .put('/api/student/profile')
        .set('Authorization', `Bearer ${studentA.token}`)
        .send({
          admissions: {
            countryOfCitizenship: 'in',
            targetStudyLevel: 'postgraduate_taught',
            targetIntakeTerm: 'Fall 2027',
            targetCountries: ['gb', 'de', 'gb'], // deduplicates + uppercases
            preferredFieldOfStudy: 'Data Science',
            fundingNeed: 'partial_scholarship_needed',
          },
          ssc: null,
          hsc: null,
          ielts: {
            scoreStatus: 'planned',
            plannedTestDate: '2026-12-10',
          },
        });

      expect(partialPut.status).toBe(200);
      expect(partialPut.headers['cache-control']).toBe('no-store');
      expect(partialPut.body.admissions.targetCountries).toEqual(['GB', 'DE']);
      expect(partialPut.body.admissions.onboardingCompletedAt).toBeNull();
      expect(partialPut.body.ielts.verificationMethod).toBe('self_reported');
      expect(partialPut.body.ielts.isVerified).toBe(false);
      expect(partialPut.body.completion.percentage).toBe(50);

      // Full PUT (updates existing rows in place, sets onboardingCompletedAt)
      const fullPut = await request(app)
        .put('/api/student/profile')
        .set('Authorization', `Bearer ${studentA.token}`)
        .send(buildCompleteProfilePayload());

      expect(fullPut.status).toBe(200);
      expect(fullPut.body.completion.percentage).toBe(100);
      expect(fullPut.body.completion.isComplete).toBe(true);
      expect(fullPut.body.admissions.onboardingCompletedAt).not.toBeNull();
      expect(fullPut.body.ssc.verificationMethod).toBe('self_reported');
      expect(fullPut.body.ssc.isVerified).toBe(false);
      expect(fullPut.body.hsc.scoreValue).toBe(4.92);
      expect(fullPut.body.ielts.overallScore).toBe(7.5);
      expect(fullPut.body.ielts.subscores).toEqual({
        listening: 8,
        reading: 7.5,
        writing: 7,
        speaking: 7.5,
      });

      // Subsequent GET reflects exact saved state
      const roundTripGet = await request(app)
        .get('/api/student/profile')
        .set('Authorization', `Bearer ${studentA.token}`);
      expect(roundTripGet.status).toBe(200);
      expect(roundTripGet.body).toEqual(fullPut.body);
    });

    it('protects already-verified credentials with 409 CREDENTIAL_VERIFIED_LOCKED', async () => {
      const { app, profileRepo, studentA } = createHarness();
      profileRepo.seedVerifiedQualification(studentA.userId, 'secondary');

      const res = await request(app)
        .put('/api/student/profile')
        .set('Authorization', `Bearer ${studentA.token}`)
        .send(buildCompleteProfilePayload());

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CREDENTIAL_VERIFIED_LOCKED');
    });
  });

  describe('4. Repository Transaction Safety, Advisory Locking & Rollback Semantics', () => {
    it('derives stable signed 64-bit advisory lock IDs per student userId', () => {
      const lockA = deriveStudentProfileLockId('11111111-1111-4111-8111-111111111111');
      const lockAUpper = deriveStudentProfileLockId('11111111-1111-4111-8111-111111111111'.toUpperCase());
      const lockB = deriveStudentProfileLockId('22222222-2222-4222-8222-222222222222');

      expect(lockA).toBe(lockAUpper);
      expect(lockA).not.toBe(lockB);
      expect(lockA >= -(2n ** 63n) && lockA <= 2n ** 63n - 1n).toBe(true);
    });

    it('PostgresStudentProfileRepository runs all writes inside db.transaction with advisory lock, updates in-place without duplicates, and propagates errors for atomic rollback', async () => {
      const userId = '11111111-1111-4111-8111-111111111111';
      type QualStoreRow = {
        id: string;
        userId: string;
        qualificationLevel: 'secondary' | 'higher_secondary';
        boardOrInstitution: string;
        countryCode: string;
        fieldOfStudy: string | null;
        gradingScaleCode: string;
        scoreValue: string | null;
        maxScoreValue: string | null;
        completionYear: number | null;
        isCompleted: boolean;
        verificationMethod: string;
        isVerified: boolean;
        updatedAt: Date;
      };
      type TestStoreRow = {
        id: string;
        userId: string;
        testCode: string;
        scoreStatus: 'reported' | 'planned' | 'taken_pending_result' | 'not_tested' | 'not_applicable' | 'unknown' | 'waived';
        overallScore: string | null;
        subscores: Record<string, number> | null;
        plannedTestDate: string | null;
        testDate: string | null;
        waiverReason: string | null;
        verificationMethod: string;
        isVerified: boolean;
        updatedAt: Date;
      };

      const committedState = {
        profiles: new Map<string, Record<string, unknown>>(),
        quals: [] as QualStoreRow[],
        tests: [] as TestStoreRow[],
      };

      let workingState = structuredClone(committedState);
      let failOnTable: unknown = null;
      let executedAdvisoryLocks = 0;

      const makeExecutor = (state: typeof committedState) => {
        const readRowsForTable = (table: unknown, filterParams: unknown[]): unknown[] => {
          if (table === studentProfiles) {
            return Array.from(state.profiles.values());
          }
          if (table === studentQualifications) {
            const wantsSecondary = filterParams.includes('secondary');
            const wantsHigher = filterParams.includes('higher_secondary');
            if (wantsSecondary || wantsHigher) {
              return state.quals.filter(
                (q) =>
                  (wantsSecondary && q.qualificationLevel === 'secondary') ||
                  (wantsHigher && q.qualificationLevel === 'higher_secondary'),
              );
            }
            return state.quals;
          }
          if (table === studentTestScores) {
            return state.tests;
          }
          if (table === gradingScales) {
            return [...DEFAULT_GRADING_SCALES];
          }
          return [];
        };

        const pgDialect = new PgDialect();
        const extractParams = (whereArg: unknown): unknown[] => {
          if (!whereArg) return [];
          try {
            return pgDialect.sqlToQuery(whereArg as Parameters<PgDialect['sqlToQuery']>[0]).params;
          } catch {
            return [];
          }
        };

        return {
          execute: async () => {
            executedAdvisoryLocks += 1;
            return [];
          },
          select: () => {
            let currentTable: unknown = null;
            let filterParams: unknown[] = [];
            const chain = {
              from: (table: unknown) => {
                currentTable = table;
                return chain;
              },
              where: (expr: unknown) => {
                filterParams = extractParams(expr);
                return chain;
              },
              orderBy: () => Promise.resolve(readRowsForTable(currentTable, filterParams)),
              limit: () => Promise.resolve(readRowsForTable(currentTable, filterParams).slice(0, 1)),
            };
            return chain;
          },
          insert: (table: unknown) => ({
            values: (vals: Record<string, unknown>) => {
              const run = async () => {
                if (failOnTable === table) {
                  throw new Error('Injected Postgres failure mid-transaction');
                }
                if (table === studentProfiles) {
                  state.profiles.set(String(vals.userId), { ...vals });
                  return [];
                }
                if (table === studentQualifications) {
                  state.quals.push({ ...(vals as unknown as QualStoreRow) });
                  return [];
                }
                if (table === studentTestScores) {
                  state.tests.push({ ...(vals as unknown as TestStoreRow) });
                  return [];
                }
                return [];
              };

              const promise = run();
              return Object.assign(promise, {
                onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => {
                  if (failOnTable === studentProfiles) {
                    throw new Error('Injected Postgres failure on profile upsert');
                  }
                  const existing = state.profiles.get(String(vals.userId)) ?? {};
                  state.profiles.set(String(vals.userId), { ...existing, ...vals, ...set });
                  return [];
                },
              });
            },
          }),
          update: (table: unknown) => ({
            set: (vals: Record<string, unknown>) => ({
              where: async (expr: unknown) => {
                if (failOnTable === table) {
                  throw new Error('Injected Postgres failure on update');
                }
                if (table === studentQualifications) {
                  const params = extractParams(expr);
                  const target = state.quals.find((q) => params.includes(q.id)) ?? state.quals[0];
                  if (target) Object.assign(target, vals);
                }
                if (table === studentTestScores && state.tests[0]) {
                  Object.assign(state.tests[0], vals);
                }
                return [];
              },
            }),
          }),
          delete: (table: unknown) => ({
            where: async (expr: unknown) => {
              const params = extractParams(expr);
              if (table === studentQualifications) {
                const level = params.includes('secondary')
                  ? 'secondary'
                  : params.includes('higher_secondary')
                    ? 'higher_secondary'
                    : null;
                if (level) {
                  const kept = state.quals.filter((q) => q.qualificationLevel !== level);
                  state.quals.splice(0, state.quals.length, ...kept);
                }
              }
              if (table === studentTestScores) {
                state.tests.splice(1);
              }
              return [];
            },
          }),
        };
      };

      const fakeDb = {
        select: makeExecutor(committedState).select,
        transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
          workingState = {
            profiles: new Map(
              Array.from(committedState.profiles.entries()).map(([k, v]) => [k, { ...v }]),
            ),
            quals: committedState.quals.map((q) => ({ ...q })),
            tests: committedState.tests.map((t) => ({
              ...t,
              subscores: t.subscores ? { ...t.subscores } : null,
            })),
          };
          const txExec = makeExecutor(workingState);
          const result = await fn(txExec);
          committedState.profiles = workingState.profiles;
          committedState.quals = workingState.quals;
          committedState.tests = workingState.tests;
          return result;
        },
      } as unknown as StudexoDatabase;

      const repo = new PostgresStudentProfileRepository(fakeDb);

      // 1. Successful first save
      const firstPayload = buildCompleteProfilePayload();
      const firstResult = await repo.upsertStudentProfileTransactional(userId, firstPayload, {
        onboardingCompletedAt: new Date(),
      });
      expect(executedAdvisoryLocks).toBe(1);
      expect(firstResult.admissions.city).toBe('Dhaka');
      expect(committedState.quals).toHaveLength(2);
      expect(committedState.tests).toHaveLength(1);

      // 2. Failing mid-transaction write must roll back completely without modifying committed state
      failOnTable = studentTestScores;
      const modifiedPayload = buildCompleteProfilePayload({
        admissions: {
          ...firstPayload.admissions,
          city: 'Chattogram',
        },
      });
      await expect(
        repo.upsertStudentProfileTransactional(userId, modifiedPayload, {
          onboardingCompletedAt: new Date(),
        }),
      ).rejects.toThrow('Injected Postgres failure');

      // City must remain 'Dhaka' in committed state
      expect(committedState.profiles.get(userId)?.city).toBe('Dhaka');

      // 3. Repeated successful save updates existing rows without creating duplicates
      failOnTable = null;
      await repo.upsertStudentProfileTransactional(userId, modifiedPayload, {
        onboardingCompletedAt: new Date(),
      });
      expect(committedState.profiles.get(userId)?.city).toBe('Chattogram');
      expect(committedState.quals).toHaveLength(2);
      expect(committedState.tests).toHaveLength(1);
    });

    it('rolls back InMemoryStudentProfileRepository cleanly if Service or Repo fails mid-save', async () => {
      const repo = new InMemoryStudentProfileRepository();
      const service = new StudentProfileService(repo);
      const userId = crypto.randomUUID();

      await service.saveProfile(userId, buildCompleteProfilePayload());

      repo.simulatedWriteFailureAtStep = 'after_ssc';
      await expect(
        service.saveProfile(
          userId,
          buildCompleteProfilePayload({
            admissions: {
              ...buildCompleteProfilePayload().admissions,
              city: 'Sylhet',
            },
          }),
        ),
      ).rejects.toThrow('Simulated mid-transaction failure');

      const reloaded = await service.getProfile(userId);
      expect(reloaded.admissions.city).toBe('Dhaka');
    });

    it('computes completion accurately across partial and full states', () => {
      expect(
        computeStudentProfileCompletion({
          admissions: {
            countryOfCitizenship: null,
            targetStudyLevel: null,
            targetIntakeTerm: null,
            targetCountries: [],
            preferredFieldOfStudy: null,
            fundingNeed: null,
          },
          ssc: null,
          hsc: null,
          ielts: null,
        }),
      ).toEqual({
        completedSections: 0,
        totalSections: 4,
        percentage: 0,
        isComplete: false,
        missingItems: [
          'Admissions goals & destination targets',
          'SSC / Secondary qualification',
          'HSC / Higher Secondary qualification',
          'IELTS / English readiness status',
        ],
      });
    });
  });
});

const TEST_POSTGRES_URL = process.env.TEST_POSTGRES_URL?.trim();

describe.skipIf(!TEST_POSTGRES_URL)(
  'Phase 8B.6B — Live Disposable PostgreSQL 17 Student Profile Integration',
  () => {
    let adminSql: Sql;
    let appSql: Sql;
    let appDb: StudexoDatabase;
    let rolePassword: string;

    beforeAll(async () => {
      const rawUrl = TEST_POSTGRES_URL!;
      const parsed = new URL(rawUrl);
      const host = parsed.hostname.toLowerCase();
      if (
        rawUrl.includes('yxhqqdbywxjhcejdmtkq') ||
        host.endsWith('.supabase.co') ||
        host.endsWith('.pooler.supabase.com')
      ) {
        throw new Error('Refusing to run disposable DB test against staging/production host.');
      }

      rolePassword = crypto.randomBytes(16).toString('hex');
      adminSql = postgres(rawUrl, { prepare: false, max: 3 });

      const migrated = await adminSql<{ ok: boolean }[]>`
        SELECT to_regclass('studexo.student_profiles') IS NOT NULL AS ok
      `;
      if (!migrated[0]?.ok) {
        const sqlFiles = [
          '0000_init_studexo_mvp.sql',
          '0001_studexo_integrity_triggers_and_extensions.sql',
          '0002_studexo_user_insert_and_file_rollback_guards.sql',
          '0003_studexo_schema_lockout_and_outbox_guard.sql',
          '0004_fenced_account_purge.sql',
          '0005_fenced_account_purge_equality.sql',
        ];
        await adminSql.unsafe(`
          CREATE SCHEMA IF NOT EXISTS extensions;
          CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
          DO $$
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studexo_migrator') THEN
              CREATE ROLE studexo_migrator LOGIN NOINHERIT;
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studexo_app') THEN
              CREATE ROLE studexo_app LOGIN NOINHERIT PASSWORD '${rolePassword}';
            ELSE
              ALTER ROLE studexo_app WITH LOGIN NOINHERIT PASSWORD '${rolePassword}';
            END IF;
          END $$;
          CREATE SCHEMA IF NOT EXISTS studexo AUTHORIZATION studexo_migrator;
        `);
        await adminSql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE studexo_migrator`);
          for (const fileName of sqlFiles) {
            const raw = fs.readFileSync(path.resolve(process.cwd(), 'drizzle', fileName), 'utf8');
            for (const stmt of raw.split('--> statement-breakpoint')) {
              const trimmed = stmt.trim();
              if (trimmed) await tx.unsafe(trimmed);
            }
          }
        });
      }

      await adminSql.unsafe(`
        GRANT USAGE ON SCHEMA studexo TO studexo_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON
          studexo.student_profiles,
          studexo.student_qualifications,
          studexo.student_test_scores
        TO studexo_app;
        GRANT SELECT ON studexo.grading_scales, studexo.test_catalog TO studexo_app;
      `);

      const appUrl = new URL(rawUrl);
      appUrl.username = 'studexo_app';
      appUrl.password = rolePassword;
      appSql = postgres(appUrl.toString(), { prepare: false, max: 3 });
      appDb = drizzle(appSql, { schema });
    });

    afterAll(async () => {
      await appSql?.end({ timeout: 5 });
      await adminSql?.end({ timeout: 5 });
    });

    it('persists student admissions, SSC, HSC, and IELTS as studexo_app without duplicates', async () => {
      const userId = crypto.randomUUID();
      await adminSql`
        INSERT INTO studexo.users (id, supabase_auth_user_id, primary_email)
        VALUES (${userId}::uuid, ${crypto.randomUUID()}::uuid, ${`pg_profile_${Date.now()}@studexo.test`})
      `;

      const repo = createPostgresStudentProfileRepository(appDb);
      const service = createStudentProfileService(repo);
      const payload = buildCompleteProfilePayload();

      const saved1 = await service.saveProfile(userId, payload);
      expect(saved1.completion.percentage).toBe(100);
      expect(saved1.ssc?.isVerified).toBe(false);
      expect(saved1.ielts?.verificationMethod).toBe('self_reported');

      await service.saveProfile(userId, payload);

      const qualCount = await appSql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM studexo.student_qualifications WHERE user_id = ${userId}::uuid
      `;
      expect(Number(qualCount[0]?.count)).toBe(2);
    });
  },
);
