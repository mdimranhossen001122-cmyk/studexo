import { pgSchema } from 'drizzle-orm/pg-core';

/**
 * Dedicated PostgreSQL schema isolating Studexo domain tables and enums
 * from Supabase-managed schemas (auth, storage, realtime, public).
 */
export const studexoSchema = pgSchema('studexo');

// Identity, Access & Lifecycle (5)
export const userRoleEnum = studexoSchema.enum('user_role', ['student', 'counselor', 'admin']);
export const accountStatusEnum = studexoSchema.enum('account_status', [
  'active',
  'suspended',
  'pending_deletion',
]);
export const authProviderEnum = studexoSchema.enum('auth_provider', [
  'supabase_email',
  'google',
  'github',
]);
export const consentTypeEnum = studexoSchema.enum('consent_type', [
  'terms_of_service',
  'privacy_policy',
  'ai_data_processing',
  'marketing_emails',
  'guardian_attestation',
]);
export const purgeStateEnum = studexoSchema.enum('purge_state', [
  'none',
  'pending_purge',
  'purging',
  'purge_failed',
  'purged',
]);

// Academic & Student Profile (5)
export const studyLevelEnum = studexoSchema.enum('study_level', [
  'foundation',
  'undergraduate',
  'postgraduate_taught',
  'postgraduate_research',
  'diploma',
]);
export const fundingNeedEnum = studexoSchema.enum('funding_need', [
  'self_funded',
  'partial_scholarship_needed',
  'full_scholarship_required',
  'unknown',
]);
export const qualificationLevelEnum = studexoSchema.enum('qualification_level', [
  'secondary',
  'higher_secondary',
  'bachelors',
  'masters',
  'diploma',
  'other',
]);
export const scoreStatusEnum = studexoSchema.enum('score_status', [
  'reported',
  'planned',
  'taken_pending_result',
  'not_tested',
  'not_applicable',
  'unknown',
  'waived',
]);
export const experienceTypeEnum = studexoSchema.enum('experience_type', [
  'work',
  'internship',
  'research',
  'volunteer',
  'leadership',
  'extracurricular',
]);

// Institutions, Programmes & Scholarships (11)
export const institutionTypeEnum = studexoSchema.enum('institution_type', [
  'public',
  'private',
  'national',
]);
export const deliveryModeEnum = studexoSchema.enum('delivery_mode', [
  'on_campus',
  'hybrid',
  'online',
]);
export const intakeTermEnum = studexoSchema.enum('intake_term', [
  'fall',
  'spring',
  'summer',
  'winter',
  'rolling',
]);
export const feeTypeEnum = studexoSchema.enum('fee_type', [
  'tuition_annual',
  'tuition_total',
  'application',
  'deposit',
  'living_estimate',
]);
export const studentResidencyCategoryEnum = studexoSchema.enum('student_residency_category', [
  'international',
  'domestic',
  'south_asia_regional',
]);
export const requirementTypeEnum = studexoSchema.enum('requirement_type', [
  'academic_gpa',
  'language_test',
  'standardized_test',
  'portfolio',
  'interview',
  'work_experience',
  'document',
]);
export const scholarshipProviderTypeEnum = studexoSchema.enum('scholarship_provider_type', [
  'government',
  'institution',
  'foundation',
  'multilateral',
]);
export const scholarshipCoverageEnum = studexoSchema.enum('scholarship_coverage', [
  'full_tuition_and_stipend',
  'full_tuition',
  'partial_tuition',
  'stipend_only',
  'fee_waiver',
]);
export const eligibilityRuleTypeEnum = studexoSchema.enum('eligibility_rule_type', [
  'citizenship',
  'residency',
  'academic_score',
  'language_score',
  'financial_need',
  'age_limit',
  'field_of_study',
  'other',
]);
export const fundingComponentEnum = studexoSchema.enum('funding_component', [
  'tuition',
  'monthly_stipend',
  'airfare',
  'accommodation',
  'health_insurance',
  'book_allowance',
  'other',
]);
export const fundingFrequencyEnum = studexoSchema.enum('funding_frequency', [
  'one_time',
  'monthly',
  'annual',
  'per_semester',
]);

// Provenance & Verification (3)
export const verificationStatusEnum = studexoSchema.enum('verification_status', [
  'unverified',
  'pending_review',
  'verified',
  'stale',
  'disputed',
  'superseded',
  'rejected',
]);
export const sourceTypeEnum = studexoSchema.enum('source_type', [
  'official_university',
  'government_portal',
  'scholarship_body',
  'accreditation_agency',
  'other',
]);
export const sourceReliabilityEnum = studexoSchema.enum('source_reliability', [
  'tier_1_official',
  'tier_2_verified_partner',
  'tier_3_secondary',
]);

// Documents, Storage & Application Submissions (3)
export const fileUploadStatusEnum = studexoSchema.enum('file_upload_status', [
  'pending',
  'uploaded',
  'verified',
  'quarantined',
  'deleted',
]);
export const documentStatusEnum = studexoSchema.enum('document_status', [
  'draft',
  'active',
  'archived',
]);
export const applicationDocumentStateEnum = studexoSchema.enum('application_document_state', [
  'attached',
  'verified',
  'submitted',
  'withdrawn',
  'replaced',
]);

// Applications, Planner & Notifications (6)
export const applicationStatusEnum = studexoSchema.enum('application_status', [
  'researching',
  'shortlisted',
  'in_progress',
  'submitted',
  'under_review',
  'offer_conditional',
  'offer_unconditional',
  'waitlisted',
  'rejected',
  'withdrawn',
]);
export const taskStatusEnum = studexoSchema.enum('task_status', [
  'todo',
  'in_progress',
  'blocked',
  'done',
  'cancelled',
]);
export const taskPriorityEnum = studexoSchema.enum('task_priority', [
  'low',
  'medium',
  'high',
  'urgent',
]);
export const plannerEventTypeEnum = studexoSchema.enum('planner_event_type', [
  'deadline',
  'exam',
  'interview',
  'counseling_session',
  'reminder',
  'other',
]);
export const notificationChannelEnum = studexoSchema.enum('notification_channel', [
  'in_app',
  'email',
]);
export const notificationStatusEnum = studexoSchema.enum('notification_status', [
  'queued',
  'sending',
  'sent',
  'failed',
  'cancelled',
]);

// AI Orchestration (3)
export const aiConversationStatusEnum = studexoSchema.enum('ai_conversation_status', [
  'active',
  'archived',
]);
export const aiMessageRoleEnum = studexoSchema.enum('ai_message_role', [
  'user',
  'assistant',
  'system',
]);
export const aiRunStatusEnum = studexoSchema.enum('ai_run_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'rate_limited',
  'cancelled',
]);
