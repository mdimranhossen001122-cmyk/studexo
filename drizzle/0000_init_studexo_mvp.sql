DO $$
DECLARE
  v_schema_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(n.nspowner)
    INTO v_schema_owner
    FROM pg_catalog.pg_namespace n
   WHERE n.nspname = 'studexo';

  IF v_schema_owner IS NULL THEN
    BEGIN
      CREATE SCHEMA "studexo";
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE EXCEPTION
          'Schema "studexo" does not exist and role "%" lacks CREATE privilege on database "%". Execute docs/DATABASE_ROLES.md Step 1 as operations admin before running migration 0000.',
          CURRENT_USER,
          pg_catalog.current_database()
          USING ERRCODE = '42501';
    END;

    SELECT pg_catalog.pg_get_userbyid(n.nspowner)
      INTO v_schema_owner
      FROM pg_catalog.pg_namespace n
     WHERE n.nspname = 'studexo';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'studexo_migrator') THEN
    IF v_schema_owner <> 'studexo_migrator' THEN
      RAISE EXCEPTION
        'Existing schema "studexo" is owned by "%" instead of required migration owner "studexo_migrator".',
        v_schema_owner
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_schema_owner <> CURRENT_USER THEN
    RAISE EXCEPTION
      'Existing schema "studexo" is owned by "%" instead of executing role "%".',
      v_schema_owner,
      CURRENT_USER
      USING ERRCODE = '42501';
  END IF;
END
$$;
--> statement-breakpoint
CREATE TYPE "studexo"."account_status" AS ENUM('active', 'suspended', 'pending_deletion');--> statement-breakpoint
CREATE TYPE "studexo"."ai_conversation_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "studexo"."ai_message_role" AS ENUM('user', 'assistant', 'system');--> statement-breakpoint
CREATE TYPE "studexo"."ai_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'timed_out', 'rate_limited', 'cancelled');--> statement-breakpoint
CREATE TYPE "studexo"."application_document_state" AS ENUM('attached', 'verified', 'submitted', 'withdrawn', 'replaced');--> statement-breakpoint
CREATE TYPE "studexo"."application_status" AS ENUM('researching', 'shortlisted', 'in_progress', 'submitted', 'under_review', 'offer_conditional', 'offer_unconditional', 'waitlisted', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "studexo"."auth_provider" AS ENUM('supabase_email', 'google', 'github');--> statement-breakpoint
CREATE TYPE "studexo"."consent_type" AS ENUM('terms_of_service', 'privacy_policy', 'ai_data_processing', 'marketing_emails', 'guardian_attestation');--> statement-breakpoint
CREATE TYPE "studexo"."delivery_mode" AS ENUM('on_campus', 'hybrid', 'online');--> statement-breakpoint
CREATE TYPE "studexo"."document_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "studexo"."eligibility_rule_type" AS ENUM('citizenship', 'residency', 'academic_score', 'language_score', 'financial_need', 'age_limit', 'field_of_study', 'other');--> statement-breakpoint
CREATE TYPE "studexo"."experience_type" AS ENUM('work', 'internship', 'research', 'volunteer', 'leadership', 'extracurricular');--> statement-breakpoint
CREATE TYPE "studexo"."fee_type" AS ENUM('tuition_annual', 'tuition_total', 'application', 'deposit', 'living_estimate');--> statement-breakpoint
CREATE TYPE "studexo"."file_upload_status" AS ENUM('pending', 'uploaded', 'verified', 'quarantined', 'deleted');--> statement-breakpoint
CREATE TYPE "studexo"."funding_component" AS ENUM('tuition', 'monthly_stipend', 'airfare', 'accommodation', 'health_insurance', 'book_allowance', 'other');--> statement-breakpoint
CREATE TYPE "studexo"."funding_frequency" AS ENUM('one_time', 'monthly', 'annual', 'per_semester');--> statement-breakpoint
CREATE TYPE "studexo"."funding_need" AS ENUM('self_funded', 'partial_scholarship_needed', 'full_scholarship_required', 'unknown');--> statement-breakpoint
CREATE TYPE "studexo"."institution_type" AS ENUM('public', 'private', 'national');--> statement-breakpoint
CREATE TYPE "studexo"."intake_term" AS ENUM('fall', 'spring', 'summer', 'winter', 'rolling');--> statement-breakpoint
CREATE TYPE "studexo"."notification_channel" AS ENUM('in_app', 'email');--> statement-breakpoint
CREATE TYPE "studexo"."notification_status" AS ENUM('queued', 'sending', 'sent', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "studexo"."planner_event_type" AS ENUM('deadline', 'exam', 'interview', 'counseling_session', 'reminder', 'other');--> statement-breakpoint
CREATE TYPE "studexo"."purge_state" AS ENUM('none', 'pending_purge', 'purging', 'purge_failed', 'purged');--> statement-breakpoint
CREATE TYPE "studexo"."qualification_level" AS ENUM('secondary', 'higher_secondary', 'bachelors', 'masters', 'diploma', 'other');--> statement-breakpoint
CREATE TYPE "studexo"."requirement_type" AS ENUM('academic_gpa', 'language_test', 'standardized_test', 'portfolio', 'interview', 'work_experience', 'document');--> statement-breakpoint
CREATE TYPE "studexo"."scholarship_coverage" AS ENUM('full_tuition_and_stipend', 'full_tuition', 'partial_tuition', 'stipend_only', 'fee_waiver');--> statement-breakpoint
CREATE TYPE "studexo"."scholarship_provider_type" AS ENUM('government', 'institution', 'foundation', 'multilateral');--> statement-breakpoint
CREATE TYPE "studexo"."score_status" AS ENUM('reported', 'planned', 'taken_pending_result', 'not_tested', 'not_applicable', 'unknown', 'waived');--> statement-breakpoint
CREATE TYPE "studexo"."source_reliability" AS ENUM('tier_1_official', 'tier_2_verified_partner', 'tier_3_secondary');--> statement-breakpoint
CREATE TYPE "studexo"."source_type" AS ENUM('official_university', 'government_portal', 'scholarship_body', 'accreditation_agency', 'other');--> statement-breakpoint
CREATE TYPE "studexo"."student_residency_category" AS ENUM('international', 'domestic', 'south_asia_regional');--> statement-breakpoint
CREATE TYPE "studexo"."study_level" AS ENUM('foundation', 'undergraduate', 'postgraduate_taught', 'postgraduate_research', 'diploma');--> statement-breakpoint
CREATE TYPE "studexo"."task_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "studexo"."task_status" AS ENUM('todo', 'in_progress', 'blocked', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "studexo"."user_role" AS ENUM('student', 'counselor', 'admin');--> statement-breakpoint
CREATE TYPE "studexo"."verification_status" AS ENUM('unverified', 'pending_review', 'verified', 'stale', 'disputed', 'superseded', 'rejected');--> statement-breakpoint
CREATE TABLE "studexo"."grading_scales" (
	"code" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(120) NOT NULL,
	"country_code" varchar(2),
	"min_value" numeric(6, 2),
	"max_value" numeric(6, 2),
	"is_higher_better" boolean DEFAULT true NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grading_scales_range_chk" CHECK (min_value IS NULL OR max_value IS NULL OR max_value >= min_value)
);
--> statement-breakpoint
CREATE TABLE "studexo"."test_catalog" (
	"code" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(120) NOT NULL,
	"category" varchar(32) NOT NULL,
	"has_numeric_score" boolean DEFAULT true NOT NULL,
	"min_score" numeric(6, 2),
	"max_score" numeric(6, 2),
	"score_step" numeric(4, 2),
	"default_validity_months" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_catalog_category_chk" CHECK (category IN ('language', 'standardized', 'other')),
	CONSTRAINT "test_catalog_range_chk" CHECK (min_score IS NULL OR max_score IS NULL OR max_score >= min_score),
	CONSTRAINT "test_catalog_validity_positive_chk" CHECK (default_validity_months IS NULL OR default_validity_months > 0)
);
--> statement-breakpoint
CREATE TABLE "studexo"."account_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"preferred_locale" varchar(16) DEFAULT 'en' NOT NULL,
	"preferred_currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"timezone" varchar(64) DEFAULT 'Asia/Dhaka' NOT NULL,
	"marketing_opt_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studexo"."auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "studexo"."auth_provider" NOT NULL,
	"provider_subject" varchar(255) NOT NULL,
	"email_at_provider" varchar(320),
	"email_verified" boolean DEFAULT false NOT NULL,
	"last_sign_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studexo"."user_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"consent_type" "studexo"."consent_type" NOT NULL,
	"policy_version" varchar(64) NOT NULL,
	"action" varchar(16) NOT NULL,
	"requirement_level" varchar(16) NOT NULL,
	"source_surface" varchar(64) NOT NULL,
	"ip_hash" varchar(128),
	"user_agent_summary" varchar(255),
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_consents_action_chk" CHECK (action IN ('accepted', 'withdrawn')),
	CONSTRAINT "user_consents_requirement_level_chk" CHECK (requirement_level IN ('required', 'optional', 'conditional'))
);
--> statement-breakpoint
CREATE TABLE "studexo"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supabase_auth_user_id" uuid,
	"primary_email" varchar(320) NOT NULL,
	"display_name" varchar(160),
	"role" "studexo"."user_role" DEFAULT 'student' NOT NULL,
	"status" "studexo"."account_status" DEFAULT 'active' NOT NULL,
	"deletion_requested_at" timestamp with time zone,
	"deletion_scheduled_for" timestamp with time zone,
	"purge_state" "studexo"."purge_state" DEFAULT 'none' NOT NULL,
	"purge_lease_owner" varchar(120),
	"purge_lease_until" timestamp with time zone,
	"purge_attempts" integer DEFAULT 0 NOT NULL,
	"last_purge_error" text,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_purge_attempts_nonneg_chk" CHECK (purge_attempts >= 0),
	CONSTRAINT "users_purge_lease_state_chk" CHECK ((purge_state = 'purging' AND purge_lease_owner IS NOT NULL AND purge_lease_until IS NOT NULL) OR (purge_state <> 'purging' AND purge_lease_owner IS NULL AND purge_lease_until IS NULL)),
	CONSTRAINT "users_deletion_window_chk" CHECK ((deletion_scheduled_for IS NULL AND deletion_requested_at IS NULL) OR (deletion_requested_at IS NOT NULL AND (deletion_scheduled_for IS NULL OR deletion_scheduled_for >= deletion_requested_at))),
	CONSTRAINT "users_pending_deletion_consistency_chk" CHECK (status <> 'pending_deletion' OR (deletion_requested_at IS NOT NULL AND purge_state <> 'none')),
	CONSTRAINT "users_purged_at_consistency_chk" CHECK ((purge_state = 'purged' AND purged_at IS NOT NULL) OR (purge_state <> 'purged' AND purged_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "studexo"."student_experiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"experience_type" "studexo"."experience_type" NOT NULL,
	"organization_name" varchar(200) NOT NULL,
	"role_title" varchar(160) NOT NULL,
	"country_code" varchar(2),
	"start_date" date,
	"end_date" date,
	"is_current" boolean DEFAULT false NOT NULL,
	"description" text,
	"verification_method" varchar(32) DEFAULT 'self_reported' NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"verified_by_user_id" uuid,
	"verified_by_role" "studexo"."user_role",
	"verified_at" timestamp with time zone,
	"evidence_document_version_id" uuid,
	"external_reference_url" text,
	"verification_valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_experiences_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "student_experiences_date_order_chk" CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
	CONSTRAINT "student_experiences_current_end_null_chk" CHECK (is_current = false OR end_date IS NULL),
	CONSTRAINT "student_experiences_verification_method_chk" CHECK (verification_method IN ('self_reported', 'document_evidence', 'official_api', 'counselor_attested', 'admin_verified')),
	CONSTRAINT "student_experiences_self_reported_not_verified_chk" CHECK (verification_method <> 'self_reported' OR is_verified = false),
	CONSTRAINT "student_experiences_verified_at_required_chk" CHECK (is_verified = false OR verified_at IS NOT NULL),
	CONSTRAINT "student_experiences_verifier_role_chk" CHECK (verification_method NOT IN ('document_evidence', 'admin_verified') OR is_verified = false OR verified_by_role IN ('counselor', 'admin')),
	CONSTRAINT "student_experiences_counselor_role_chk" CHECK (verification_method <> 'counselor_attested' OR is_verified = false OR verified_by_role = 'counselor'),
	CONSTRAINT "student_experiences_document_evidence_required_chk" CHECK (verification_method <> 'document_evidence' OR evidence_document_version_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "studexo"."student_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"country_of_citizenship" varchar(2),
	"country_of_residence" varchar(2),
	"city" varchar(120),
	"birth_year" smallint,
	"target_study_level" "studexo"."study_level",
	"target_intake_term" varchar(32),
	"target_countries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preferred_field_of_study" varchar(160),
	"annual_budget_amount" numeric(14, 2),
	"annual_budget_currency" varchar(3),
	"funding_need" "studexo"."funding_need",
	"onboarding_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_profiles_birth_year_chk" CHECK (birth_year IS NULL OR (birth_year >= 1000 AND birth_year <= 9999)),
	CONSTRAINT "student_profiles_budget_nonneg_chk" CHECK (annual_budget_amount IS NULL OR annual_budget_amount >= 0),
	CONSTRAINT "student_profiles_budget_currency_chk" CHECK (annual_budget_amount IS NULL OR annual_budget_currency IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "studexo"."student_publications_and_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_type" varchar(32) NOT NULL,
	"title" varchar(240) NOT NULL,
	"venue_or_platform" varchar(200),
	"published_or_completed_at" date,
	"url" text,
	"summary" text,
	"verification_method" varchar(32) DEFAULT 'self_reported' NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"verified_by_user_id" uuid,
	"verified_by_role" "studexo"."user_role",
	"verified_at" timestamp with time zone,
	"evidence_document_version_id" uuid,
	"external_reference_url" text,
	"verification_valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_pub_proj_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "student_pub_proj_item_type_chk" CHECK (item_type IN ('publication', 'research_paper', 'project', 'patent', 'award')),
	CONSTRAINT "student_pub_proj_verification_method_chk" CHECK (verification_method IN ('self_reported', 'document_evidence', 'official_api', 'counselor_attested', 'admin_verified')),
	CONSTRAINT "student_pub_proj_self_reported_not_verified_chk" CHECK (verification_method <> 'self_reported' OR is_verified = false),
	CONSTRAINT "student_pub_proj_verified_at_required_chk" CHECK (is_verified = false OR verified_at IS NOT NULL),
	CONSTRAINT "student_pub_proj_verifier_role_chk" CHECK (verification_method NOT IN ('document_evidence', 'admin_verified') OR is_verified = false OR verified_by_role IN ('counselor', 'admin')),
	CONSTRAINT "student_pub_proj_counselor_role_chk" CHECK (verification_method <> 'counselor_attested' OR is_verified = false OR verified_by_role = 'counselor'),
	CONSTRAINT "student_pub_proj_document_evidence_required_chk" CHECK (verification_method <> 'document_evidence' OR evidence_document_version_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "studexo"."student_qualifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"qualification_level" "studexo"."qualification_level" NOT NULL,
	"board_or_institution" varchar(200) NOT NULL,
	"country_code" varchar(2) NOT NULL,
	"field_of_study" varchar(160),
	"grading_scale_code" varchar(64) NOT NULL,
	"score_value" numeric(6, 2),
	"max_score_value" numeric(6, 2),
	"completion_year" integer,
	"is_completed" boolean DEFAULT true NOT NULL,
	"verification_method" varchar(32) DEFAULT 'self_reported' NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"verified_by_user_id" uuid,
	"verified_by_role" "studexo"."user_role",
	"verified_at" timestamp with time zone,
	"evidence_document_version_id" uuid,
	"external_reference_url" text,
	"verification_valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_qualifications_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "student_qualifications_score_nonneg_chk" CHECK (score_value IS NULL OR score_value >= 0),
	CONSTRAINT "student_qualifications_max_score_pos_chk" CHECK (max_score_value IS NULL OR max_score_value > 0),
	CONSTRAINT "student_qualifications_score_bounds_chk" CHECK (score_value IS NULL OR max_score_value IS NULL OR score_value <= max_score_value),
	CONSTRAINT "student_qualifications_verification_method_chk" CHECK (verification_method IN ('self_reported', 'document_evidence', 'official_api', 'counselor_attested', 'admin_verified')),
	CONSTRAINT "student_qualifications_self_reported_not_verified_chk" CHECK (verification_method <> 'self_reported' OR is_verified = false),
	CONSTRAINT "student_qualifications_verified_at_required_chk" CHECK (is_verified = false OR verified_at IS NOT NULL),
	CONSTRAINT "student_qualifications_verifier_role_chk" CHECK (verification_method NOT IN ('document_evidence', 'admin_verified') OR is_verified = false OR verified_by_role IN ('counselor', 'admin')),
	CONSTRAINT "student_qualifications_counselor_role_chk" CHECK (verification_method <> 'counselor_attested' OR is_verified = false OR verified_by_role = 'counselor'),
	CONSTRAINT "student_qualifications_document_evidence_required_chk" CHECK (verification_method <> 'document_evidence' OR evidence_document_version_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "studexo"."student_test_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"test_code" varchar(64) NOT NULL,
	"score_status" "studexo"."score_status" DEFAULT 'reported' NOT NULL,
	"overall_score" numeric(6, 2),
	"subscores" jsonb,
	"planned_test_date" date,
	"test_date" date,
	"expires_at" date,
	"waiver_reason" text,
	"verification_method" varchar(32) DEFAULT 'self_reported' NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"verified_by_user_id" uuid,
	"verified_by_role" "studexo"."user_role",
	"verified_at" timestamp with time zone,
	"evidence_document_version_id" uuid,
	"external_reference_url" text,
	"verification_valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_test_scores_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "student_test_scores_numeric_gate_chk" CHECK ((test_code <> 'moi' AND score_status = 'reported') OR (overall_score IS NULL AND subscores IS NULL)),
	CONSTRAINT "student_test_scores_overall_nonneg_chk" CHECK (overall_score IS NULL OR overall_score >= 0),
	CONSTRAINT "student_test_scores_reported_score_chk" CHECK (score_status <> 'reported' OR test_code = 'moi' OR overall_score IS NOT NULL),
	CONSTRAINT "student_test_scores_waiver_reason_chk" CHECK (score_status <> 'waived' OR waiver_reason IS NOT NULL),
	CONSTRAINT "student_test_scores_verification_method_chk" CHECK (verification_method IN ('self_reported', 'document_evidence', 'official_api', 'counselor_attested', 'admin_verified')),
	CONSTRAINT "student_test_scores_self_reported_not_verified_chk" CHECK (verification_method <> 'self_reported' OR is_verified = false),
	CONSTRAINT "student_test_scores_verified_at_required_chk" CHECK (is_verified = false OR verified_at IS NOT NULL),
	CONSTRAINT "student_test_scores_verifier_role_chk" CHECK (verification_method NOT IN ('document_evidence', 'admin_verified') OR is_verified = false OR verified_by_role IN ('counselor', 'admin')),
	CONSTRAINT "student_test_scores_counselor_role_chk" CHECK (verification_method <> 'counselor_attested' OR is_verified = false OR verified_by_role = 'counselor'),
	CONSTRAINT "student_test_scores_document_evidence_required_chk" CHECK (verification_method <> 'document_evidence' OR evidence_document_version_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "studexo"."institution_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"alias_name" varchar(240) NOT NULL,
	"alias_type" varchar(32) DEFAULT 'common' NOT NULL,
	"locale" varchar(16),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "institution_aliases_type_chk" CHECK (alias_type IN ('acronym', 'local_name', 'former_name', 'common', 'translation'))
);
--> statement-breakpoint
CREATE TABLE "studexo"."institutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(160) NOT NULL,
	"name" varchar(240) NOT NULL,
	"country_code" varchar(2) NOT NULL,
	"city" varchar(120),
	"institution_type" "studexo"."institution_type" DEFAULT 'public' NOT NULL,
	"official_website" text,
	"qs_world_rank" integer,
	"verification_status" "studexo"."verification_status" DEFAULT 'unverified' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "institutions_qs_rank_pos_chk" CHECK (qs_world_rank IS NULL OR qs_world_rank >= 1)
);
--> statement-breakpoint
CREATE TABLE "studexo"."programme_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"programme_id" uuid NOT NULL,
	"fee_type" "studexo"."fee_type" NOT NULL,
	"student_category" "studexo"."student_residency_category" DEFAULT 'international' NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"academic_year" varchar(16),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "programme_fees_amount_nonneg_chk" CHECK (amount >= 0)
);
--> statement-breakpoint
CREATE TABLE "studexo"."programme_intakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"programme_id" uuid NOT NULL,
	"intake_term" "studexo"."intake_term" NOT NULL,
	"intake_year" integer NOT NULL,
	"application_opens_at" timestamp with time zone,
	"application_deadline_at" timestamp with time zone,
	"priority_deadline_at" timestamp with time zone,
	"is_open_for_international" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "programme_intakes_id_programme_uq" UNIQUE("id","programme_id"),
	CONSTRAINT "programme_intakes_year_chk" CHECK (intake_year >= 2000 AND intake_year <= 2100)
);
--> statement-breakpoint
CREATE TABLE "studexo"."programme_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"programme_id" uuid NOT NULL,
	"requirement_type" "studexo"."requirement_type" NOT NULL,
	"country_scope" varchar(2),
	"grading_scale_code" varchar(64),
	"test_code" varchar(64),
	"minimum_numeric_score" numeric(6, 2),
	"summary" text NOT NULL,
	"structured_criteria" jsonb,
	"is_mandatory" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "programme_requirements_min_score_nonneg_chk" CHECK (minimum_numeric_score IS NULL OR minimum_numeric_score >= 0)
);
--> statement-breakpoint
CREATE TABLE "studexo"."programmes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"slug" varchar(180) NOT NULL,
	"title" varchar(240) NOT NULL,
	"study_level" "studexo"."study_level" NOT NULL,
	"discipline" varchar(140) NOT NULL,
	"delivery_mode" "studexo"."delivery_mode" DEFAULT 'on_campus' NOT NULL,
	"duration_months" integer NOT NULL,
	"language_of_instruction" varchar(16) DEFAULT 'en' NOT NULL,
	"official_url" text,
	"verification_status" "studexo"."verification_status" DEFAULT 'unverified' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "programmes_id_institution_uq" UNIQUE("id","institution_id"),
	CONSTRAINT "programmes_duration_pos_chk" CHECK (duration_months > 0)
);
--> statement-breakpoint
CREATE TABLE "studexo"."scholarship_eligibility_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scholarship_id" uuid NOT NULL,
	"rule_type" "studexo"."eligibility_rule_type" NOT NULL,
	"eligible_countries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grading_scale_code" varchar(64),
	"test_code" varchar(64),
	"minimum_numeric_score" numeric(6, 2),
	"summary" text NOT NULL,
	"structured_rule" jsonb,
	"is_mandatory" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scholarship_eligibility_min_score_nonneg_chk" CHECK (minimum_numeric_score IS NULL OR minimum_numeric_score >= 0)
);
--> statement-breakpoint
CREATE TABLE "studexo"."scholarship_funding_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scholarship_id" uuid NOT NULL,
	"component_type" "studexo"."funding_component" NOT NULL,
	"amount" numeric(14, 2),
	"currency_code" varchar(3),
	"percentage_covered" numeric(5, 2),
	"frequency" "studexo"."funding_frequency" DEFAULT 'annual' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scholarship_funding_amount_nonneg_chk" CHECK (amount IS NULL OR amount >= 0),
	CONSTRAINT "scholarship_funding_pct_range_chk" CHECK (percentage_covered IS NULL OR (percentage_covered >= 0 AND percentage_covered <= 100))
);
--> statement-breakpoint
CREATE TABLE "studexo"."scholarship_intakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scholarship_id" uuid NOT NULL,
	"cycle_label" varchar(64) NOT NULL,
	"intake_term" "studexo"."intake_term" DEFAULT 'rolling' NOT NULL,
	"intake_year" integer NOT NULL,
	"application_opens_at" timestamp with time zone,
	"application_deadline_at" timestamp with time zone,
	"result_expected_at" timestamp with time zone,
	"is_open" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scholarship_intakes_id_scholarship_uq" UNIQUE("id","scholarship_id"),
	CONSTRAINT "scholarship_intakes_year_chk" CHECK (intake_year >= 2000 AND intake_year <= 2100)
);
--> statement-breakpoint
CREATE TABLE "studexo"."scholarship_programmes" (
	"scholarship_id" uuid NOT NULL,
	"programme_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scholarship_programmes_scholarship_id_programme_id_pk" PRIMARY KEY("scholarship_id","programme_id")
);
--> statement-breakpoint
CREATE TABLE "studexo"."scholarships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(180) NOT NULL,
	"title" varchar(240) NOT NULL,
	"provider_name" varchar(200) NOT NULL,
	"provider_type" "studexo"."scholarship_provider_type" NOT NULL,
	"institution_id" uuid,
	"host_country_code" varchar(2) NOT NULL,
	"study_level" "studexo"."study_level" NOT NULL,
	"coverage_scope" "studexo"."scholarship_coverage" NOT NULL,
	"official_url" text,
	"verification_status" "studexo"."verification_status" DEFAULT 'unverified' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studexo"."sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"source_type" "studexo"."source_type" NOT NULL,
	"base_url" text NOT NULL,
	"reliability_tier" "studexo"."source_reliability" DEFAULT 'tier_1_official' NOT NULL,
	"country_code" varchar(2),
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studexo"."verification_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid,
	"programme_id" uuid,
	"scholarship_id" uuid,
	"field_path" varchar(120) NOT NULL,
	"claimed_value" jsonb,
	"status" "studexo"."verification_status" DEFAULT 'pending_review' NOT NULL,
	"verified_by_user_id" uuid,
	"verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"superseded_by_claim_id" uuid,
	"superseded_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_claims_single_target_chk" CHECK (((CASE WHEN institution_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN programme_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_id IS NOT NULL THEN 1 ELSE 0 END)) = 1),
	CONSTRAINT "verification_claims_not_self_superseded_chk" CHECK (superseded_by_claim_id IS NULL OR superseded_by_claim_id <> id),
	CONSTRAINT "verification_claims_supersession_state_chk" CHECK ((status <> 'superseded' AND superseded_by_claim_id IS NULL AND superseded_at IS NULL) OR (status = 'superseded' AND superseded_by_claim_id IS NOT NULL AND superseded_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "studexo"."verification_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"evidence_url" text NOT NULL,
	"excerpt" text,
	"http_status" integer,
	"content_hash" varchar(128),
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_evidence_http_status_chk" CHECK (http_status IS NULL OR (http_status >= 100 AND http_status <= 599))
);
--> statement-breakpoint
CREATE TABLE "studexo"."document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"stored_file_id" uuid NOT NULL,
	"uploaded_by_user_id" uuid,
	"version_number" integer NOT NULL,
	"change_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_versions_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "document_versions_id_doc_user_uq" UNIQUE("id","document_id","user_id"),
	CONSTRAINT "document_versions_number_positive_chk" CHECK (version_number >= 1)
);
--> statement-breakpoint
CREATE TABLE "studexo"."documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"document_type" varchar(64) NOT NULL,
	"title" varchar(200) NOT NULL,
	"status" "studexo"."document_status" DEFAULT 'active' NOT NULL,
	"current_version_number" integer DEFAULT 1 NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone,
	"archived_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "documents_current_version_positive_chk" CHECK (current_version_number >= 1),
	CONSTRAINT "documents_archived_at_consistency_chk" CHECK (status <> 'archived' OR archived_at IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "studexo"."stored_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"storage_provider" varchar(32) DEFAULT 'supabase_storage' NOT NULL,
	"storage_bucket" varchar(120) NOT NULL,
	"object_key" text NOT NULL,
	"original_filename" varchar(255) NOT NULL,
	"mime_type" varchar(160) NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256_checksum" varchar(64),
	"visibility" varchar(16) DEFAULT 'private' NOT NULL,
	"upload_status" "studexo"."file_upload_status" DEFAULT 'pending' NOT NULL,
	"uploaded_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid,
	"purge_state" "studexo"."purge_state" DEFAULT 'none' NOT NULL,
	"purge_requested_at" timestamp with time zone,
	"purge_lease_until" timestamp with time zone,
	"purge_attempts" integer DEFAULT 0 NOT NULL,
	"last_purge_error" text,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stored_files_id_owner_uq" UNIQUE("id","owner_user_id"),
	CONSTRAINT "stored_files_visibility_private_chk" CHECK (visibility = 'private'),
	CONSTRAINT "stored_files_byte_size_nonneg_chk" CHECK (byte_size >= 0),
	CONSTRAINT "stored_files_purge_attempts_nonneg_chk" CHECK (purge_attempts >= 0),
	CONSTRAINT "stored_files_deleted_at_consistency_chk" CHECK (upload_status <> 'deleted' OR deleted_at IS NOT NULL),
	CONSTRAINT "stored_files_purged_at_consistency_chk" CHECK ((purge_state = 'purged' AND purged_at IS NOT NULL) OR (purge_state <> 'purged' AND purged_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "studexo"."application_checklists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"university_application_id" uuid,
	"scholarship_application_id" uuid,
	"title" varchar(240) NOT NULL,
	"description" text,
	"is_completed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"linked_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_checklists_single_target_chk" CHECK (((CASE WHEN university_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_application_id IS NOT NULL THEN 1 ELSE 0 END)) = 1)
);
--> statement-breakpoint
CREATE TABLE "studexo"."application_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"university_application_id" uuid,
	"scholarship_application_id" uuid,
	"document_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"document_state" "studexo"."application_document_state" DEFAULT 'attached' NOT NULL,
	"replaced_by_id" uuid,
	"submitted_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_documents_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "application_documents_single_target_chk" CHECK (((CASE WHEN university_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_application_id IS NOT NULL THEN 1 ELSE 0 END)) = 1),
	CONSTRAINT "application_documents_not_self_replaced_chk" CHECK (replaced_by_id IS NULL OR replaced_by_id <> id),
	CONSTRAINT "application_documents_replacement_state_chk" CHECK ((document_state <> 'replaced' AND replaced_by_id IS NULL) OR (document_state = 'replaced' AND replaced_by_id IS NOT NULL)),
	CONSTRAINT "application_documents_submitted_at_chk" CHECK (document_state <> 'submitted' OR submitted_at IS NOT NULL),
	CONSTRAINT "application_documents_withdrawn_at_chk" CHECK (document_state <> 'withdrawn' OR withdrawn_at IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "studexo"."application_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"university_application_id" uuid,
	"scholarship_application_id" uuid,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_notes_single_target_chk" CHECK (((CASE WHEN university_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_application_id IS NOT NULL THEN 1 ELSE 0 END)) = 1)
);
--> statement-breakpoint
CREATE TABLE "studexo"."application_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"university_application_id" uuid,
	"scholarship_application_id" uuid,
	"from_status" "studexo"."application_status",
	"to_status" "studexo"."application_status" NOT NULL,
	"changed_by_user_id" uuid,
	"reason" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_status_history_single_target_chk" CHECK (((CASE WHEN university_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_application_id IS NOT NULL THEN 1 ELSE 0 END)) = 1)
);
--> statement-breakpoint
CREATE TABLE "studexo"."saved_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"programme_id" uuid,
	"scholarship_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_opportunities_single_target_chk" CHECK (((CASE WHEN programme_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_id IS NOT NULL THEN 1 ELSE 0 END)) = 1)
);
--> statement-breakpoint
CREATE TABLE "studexo"."scholarship_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scholarship_id" uuid NOT NULL,
	"scholarship_intake_id" uuid,
	"university_application_id" uuid,
	"status" "studexo"."application_status" DEFAULT 'shortlisted' NOT NULL,
	"portal_reference" varchar(120),
	"target_submission_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"decision_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scholarship_applications_id_user_uq" UNIQUE("id","user_id")
);
--> statement-breakpoint
CREATE TABLE "studexo"."university_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"programme_id" uuid NOT NULL,
	"programme_intake_id" uuid,
	"status" "studexo"."application_status" DEFAULT 'shortlisted' NOT NULL,
	"portal_reference" varchar(120),
	"target_submission_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"decision_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "university_applications_id_user_uq" UNIQUE("id","user_id")
);
--> statement-breakpoint
CREATE TABLE "studexo"."notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "studexo"."notification_channel" NOT NULL,
	"notification_type" varchar(64) NOT NULL,
	"dedupe_key" varchar(160) NOT NULL,
	"status" "studexo"."notification_status" DEFAULT 'queued' NOT NULL,
	"title" varchar(240) NOT NULL,
	"body" text NOT NULL,
	"university_application_id" uuid,
	"scholarship_application_id" uuid,
	"planner_task_id" uuid,
	"planner_event_id" uuid,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_attempts_nonneg_chk" CHECK (attempt_count >= 0),
	CONSTRAINT "notification_deliveries_read_at_invariant_chk" CHECK (read_at IS NULL OR (channel = 'in_app' AND status = 'sent')),
	CONSTRAINT "notification_deliveries_sent_at_chk" CHECK (status <> 'sent' OR sent_at IS NOT NULL),
	CONSTRAINT "notification_deliveries_at_most_one_target_chk" CHECK (((CASE WHEN university_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN planner_task_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN planner_event_id IS NOT NULL THEN 1 ELSE 0 END)) <= 1)
);
--> statement-breakpoint
CREATE TABLE "studexo"."notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"email_reminders_enabled" boolean DEFAULT true NOT NULL,
	"in_app_reminders_enabled" boolean DEFAULT true NOT NULL,
	"deadline_lead_days" integer DEFAULT 7 NOT NULL,
	"weekly_digest_enabled" boolean DEFAULT true NOT NULL,
	"quiet_hours_start" varchar(5),
	"quiet_hours_end" varchar(5),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_lead_days_nonneg_chk" CHECK (deadline_lead_days >= 0)
);
--> statement-breakpoint
CREATE TABLE "studexo"."planner_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"university_application_id" uuid,
	"scholarship_application_id" uuid,
	"event_type" "studexo"."planner_event_type" NOT NULL,
	"title" varchar(240) NOT NULL,
	"notes" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"is_all_day" boolean DEFAULT false NOT NULL,
	"timezone" varchar(64) DEFAULT 'Asia/Dhaka' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planner_events_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "planner_events_time_order_chk" CHECK (ends_at IS NULL OR ends_at >= starts_at),
	CONSTRAINT "planner_events_at_most_one_target_chk" CHECK (((CASE WHEN university_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_application_id IS NOT NULL THEN 1 ELSE 0 END)) <= 1)
);
--> statement-breakpoint
CREATE TABLE "studexo"."planner_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"university_application_id" uuid,
	"scholarship_application_id" uuid,
	"title" varchar(240) NOT NULL,
	"description" text,
	"status" "studexo"."task_status" DEFAULT 'todo' NOT NULL,
	"priority" "studexo"."task_priority" DEFAULT 'medium' NOT NULL,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planner_tasks_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "planner_tasks_at_most_one_target_chk" CHECK (((CASE WHEN university_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_application_id IS NOT NULL THEN 1 ELSE 0 END)) <= 1)
);
--> statement-breakpoint
CREATE TABLE "studexo"."ai_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"feature_key" varchar(64) NOT NULL,
	"title" varchar(240),
	"status" "studexo"."ai_conversation_status" DEFAULT 'active' NOT NULL,
	"university_application_id" uuid,
	"scholarship_application_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_conversations_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "ai_conversations_at_most_one_target_chk" CHECK (((CASE WHEN university_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_application_id IS NOT NULL THEN 1 ELSE 0 END)) <= 1)
);
--> statement-breakpoint
CREATE TABLE "studexo"."ai_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "studexo"."ai_message_role" NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studexo"."ai_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"feature_key" varchar(64) NOT NULL,
	"is_allowed" boolean DEFAULT true NOT NULL,
	"daily_run_quota" integer DEFAULT 25 NOT NULL,
	"granted_by_user_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_permissions_quota_nonneg_chk" CHECK (daily_run_quota >= 0)
);
--> statement-breakpoint
CREATE TABLE "studexo"."ai_prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt_key" varchar(120) NOT NULL,
	"version_number" integer NOT NULL,
	"feature_key" varchar(64) NOT NULL,
	"model_name" varchar(120) NOT NULL,
	"system_instruction_summary" text NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_prompt_versions_number_positive_chk" CHECK (version_number >= 1)
);
--> statement-breakpoint
CREATE TABLE "studexo"."ai_run_context_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ai_run_id" uuid NOT NULL,
	"document_id" uuid,
	"document_version_id" uuid,
	"university_application_id" uuid,
	"scholarship_application_id" uuid,
	"student_qualification_id" uuid,
	"student_test_score_id" uuid,
	"institution_id" uuid,
	"programme_id" uuid,
	"scholarship_id" uuid,
	"context_role" varchar(32) DEFAULT 'grounding' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_run_context_links_role_chk" CHECK (context_role IN ('grounding', 'primary_subject', 'comparison', 'user_attachment')),
	CONSTRAINT "ai_run_context_links_single_target_chk" CHECK (((CASE WHEN document_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN document_version_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN university_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN student_qualification_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN student_test_score_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN institution_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN programme_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_id IS NOT NULL THEN 1 ELSE 0 END)) = 1)
);
--> statement-breakpoint
CREATE TABLE "studexo"."ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"prompt_version_id" uuid,
	"feature_key" varchar(64) NOT NULL,
	"model_name" varchar(120) NOT NULL,
	"status" "studexo"."ai_run_status" DEFAULT 'queued' NOT NULL,
	"request_id" varchar(120),
	"latency_ms" integer,
	"error_code" varchar(80),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_runs_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "ai_runs_latency_nonneg_chk" CHECK (latency_ms IS NULL OR latency_ms >= 0)
);
--> statement-breakpoint
CREATE TABLE "studexo"."ai_usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ai_run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"model_name" varchar(120) NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" numeric(12, 6) DEFAULT '0.000000' NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_records_prompt_tokens_nonneg_chk" CHECK (prompt_tokens >= 0),
	CONSTRAINT "ai_usage_records_completion_tokens_nonneg_chk" CHECK (completion_tokens >= 0),
	CONSTRAINT "ai_usage_records_total_tokens_nonneg_chk" CHECK (total_tokens >= 0)
);
--> statement-breakpoint
CREATE TABLE "studexo"."external_identity_purge_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"former_user_id" uuid NOT NULL,
	"supabase_auth_user_id" uuid NOT NULL,
	"status" "studexo"."purge_state" DEFAULT 'pending_purge' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 10 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" varchar(120),
	"locked_until" timestamp with time zone,
	"last_error_code" varchar(64),
	"last_error_message" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_identity_purge_outbox_status_domain_chk" CHECK (status IN ('pending_purge', 'purging', 'purge_failed', 'purged')),
	CONSTRAINT "external_identity_purge_outbox_completed_at_chk" CHECK ((status = 'purged' AND completed_at IS NOT NULL) OR (status <> 'purged' AND completed_at IS NULL)),
	CONSTRAINT "external_identity_purge_outbox_attempts_chk" CHECK (attempt_count >= 0 AND max_attempts >= 1 AND attempt_count <= max_attempts)
);
--> statement-breakpoint
ALTER TABLE "studexo"."account_settings" ADD CONSTRAINT "account_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."user_consents" ADD CONSTRAINT "user_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."student_experiences" ADD CONSTRAINT "student_experiences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."student_experiences" ADD CONSTRAINT "student_experiences_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "studexo"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."student_experiences" ADD CONSTRAINT "student_experiences_evidence_doc_ver_user_fk" FOREIGN KEY ("evidence_document_version_id","user_id") REFERENCES "studexo"."document_versions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."student_profiles" ADD CONSTRAINT "student_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."student_publications_and_projects" ADD CONSTRAINT "student_publications_and_projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."student_publications_and_projects" ADD CONSTRAINT "student_publications_and_projects_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "studexo"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."student_publications_and_projects" ADD CONSTRAINT "student_pub_proj_evidence_doc_ver_user_fk" FOREIGN KEY ("evidence_document_version_id","user_id") REFERENCES "studexo"."document_versions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."student_qualifications" ADD CONSTRAINT "student_qualifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."student_qualifications" ADD CONSTRAINT "student_qualifications_grading_scale_code_grading_scales_code_fk" FOREIGN KEY ("grading_scale_code") REFERENCES "studexo"."grading_scales"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."student_qualifications" ADD CONSTRAINT "student_qualifications_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "studexo"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."student_qualifications" ADD CONSTRAINT "student_qualifications_evidence_doc_ver_user_fk" FOREIGN KEY ("evidence_document_version_id","user_id") REFERENCES "studexo"."document_versions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."student_test_scores" ADD CONSTRAINT "student_test_scores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."student_test_scores" ADD CONSTRAINT "student_test_scores_test_code_test_catalog_code_fk" FOREIGN KEY ("test_code") REFERENCES "studexo"."test_catalog"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."student_test_scores" ADD CONSTRAINT "student_test_scores_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "studexo"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."student_test_scores" ADD CONSTRAINT "student_test_scores_evidence_doc_ver_user_fk" FOREIGN KEY ("evidence_document_version_id","user_id") REFERENCES "studexo"."document_versions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."institution_aliases" ADD CONSTRAINT "institution_aliases_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "studexo"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."programme_fees" ADD CONSTRAINT "programme_fees_programme_id_programmes_id_fk" FOREIGN KEY ("programme_id") REFERENCES "studexo"."programmes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."programme_intakes" ADD CONSTRAINT "programme_intakes_programme_id_programmes_id_fk" FOREIGN KEY ("programme_id") REFERENCES "studexo"."programmes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."programme_requirements" ADD CONSTRAINT "programme_requirements_programme_id_programmes_id_fk" FOREIGN KEY ("programme_id") REFERENCES "studexo"."programmes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."programme_requirements" ADD CONSTRAINT "programme_requirements_grading_scale_code_grading_scales_code_fk" FOREIGN KEY ("grading_scale_code") REFERENCES "studexo"."grading_scales"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."programme_requirements" ADD CONSTRAINT "programme_requirements_test_code_test_catalog_code_fk" FOREIGN KEY ("test_code") REFERENCES "studexo"."test_catalog"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."programmes" ADD CONSTRAINT "programmes_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "studexo"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."scholarship_eligibility_rules" ADD CONSTRAINT "scholarship_eligibility_rules_scholarship_id_scholarships_id_fk" FOREIGN KEY ("scholarship_id") REFERENCES "studexo"."scholarships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."scholarship_eligibility_rules" ADD CONSTRAINT "scholarship_eligibility_rules_grading_scale_code_grading_scales_code_fk" FOREIGN KEY ("grading_scale_code") REFERENCES "studexo"."grading_scales"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."scholarship_eligibility_rules" ADD CONSTRAINT "scholarship_eligibility_rules_test_code_test_catalog_code_fk" FOREIGN KEY ("test_code") REFERENCES "studexo"."test_catalog"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."scholarship_funding_components" ADD CONSTRAINT "scholarship_funding_components_scholarship_id_scholarships_id_fk" FOREIGN KEY ("scholarship_id") REFERENCES "studexo"."scholarships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."scholarship_intakes" ADD CONSTRAINT "scholarship_intakes_scholarship_id_scholarships_id_fk" FOREIGN KEY ("scholarship_id") REFERENCES "studexo"."scholarships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."scholarship_programmes" ADD CONSTRAINT "scholarship_programmes_scholarship_id_scholarships_id_fk" FOREIGN KEY ("scholarship_id") REFERENCES "studexo"."scholarships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."scholarship_programmes" ADD CONSTRAINT "scholarship_programmes_programme_id_programmes_id_fk" FOREIGN KEY ("programme_id") REFERENCES "studexo"."programmes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."scholarships" ADD CONSTRAINT "scholarships_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "studexo"."institutions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."verification_claims" ADD CONSTRAINT "verification_claims_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "studexo"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."verification_claims" ADD CONSTRAINT "verification_claims_programme_id_programmes_id_fk" FOREIGN KEY ("programme_id") REFERENCES "studexo"."programmes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."verification_claims" ADD CONSTRAINT "verification_claims_scholarship_id_scholarships_id_fk" FOREIGN KEY ("scholarship_id") REFERENCES "studexo"."scholarships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."verification_claims" ADD CONSTRAINT "verification_claims_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "studexo"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."verification_claims" ADD CONSTRAINT "verification_claims_superseded_by_claim_id_verification_claims_id_fk" FOREIGN KEY ("superseded_by_claim_id") REFERENCES "studexo"."verification_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."verification_evidence" ADD CONSTRAINT "verification_evidence_claim_id_verification_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "studexo"."verification_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."verification_evidence" ADD CONSTRAINT "verification_evidence_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "studexo"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."document_versions" ADD CONSTRAINT "document_versions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."document_versions" ADD CONSTRAINT "document_versions_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "studexo"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."document_versions" ADD CONSTRAINT "document_versions_document_user_fk" FOREIGN KEY ("document_id","user_id") REFERENCES "studexo"."documents"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."document_versions" ADD CONSTRAINT "document_versions_stored_file_user_fk" FOREIGN KEY ("stored_file_id","user_id") REFERENCES "studexo"."stored_files"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."documents" ADD CONSTRAINT "documents_archived_by_user_id_users_id_fk" FOREIGN KEY ("archived_by_user_id") REFERENCES "studexo"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."stored_files" ADD CONSTRAINT "stored_files_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "studexo"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."stored_files" ADD CONSTRAINT "stored_files_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "studexo"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."application_checklists" ADD CONSTRAINT "application_checklists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."application_checklists" ADD CONSTRAINT "application_checklists_uni_app_user_fk" FOREIGN KEY ("university_application_id","user_id") REFERENCES "studexo"."university_applications"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."application_checklists" ADD CONSTRAINT "application_checklists_sch_app_user_fk" FOREIGN KEY ("scholarship_application_id","user_id") REFERENCES "studexo"."scholarship_applications"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."application_checklists" ADD CONSTRAINT "application_checklists_linked_doc_user_fk" FOREIGN KEY ("linked_document_id","user_id") REFERENCES "studexo"."documents"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."application_documents" ADD CONSTRAINT "application_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."application_documents" ADD CONSTRAINT "application_documents_uni_app_user_fk" FOREIGN KEY ("university_application_id","user_id") REFERENCES "studexo"."university_applications"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."application_documents" ADD CONSTRAINT "application_documents_sch_app_user_fk" FOREIGN KEY ("scholarship_application_id","user_id") REFERENCES "studexo"."scholarship_applications"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."application_documents" ADD CONSTRAINT "application_documents_document_user_fk" FOREIGN KEY ("document_id","user_id") REFERENCES "studexo"."documents"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."application_documents" ADD CONSTRAINT "application_documents_doc_version_doc_user_fk" FOREIGN KEY ("document_version_id","document_id","user_id") REFERENCES "studexo"."document_versions"("id","document_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."application_documents" ADD CONSTRAINT "application_documents_replaced_by_user_fk" FOREIGN KEY ("replaced_by_id","user_id") REFERENCES "studexo"."application_documents"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."application_notes" ADD CONSTRAINT "application_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."application_notes" ADD CONSTRAINT "application_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "studexo"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."application_notes" ADD CONSTRAINT "application_notes_uni_app_user_fk" FOREIGN KEY ("university_application_id","user_id") REFERENCES "studexo"."university_applications"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."application_notes" ADD CONSTRAINT "application_notes_sch_app_user_fk" FOREIGN KEY ("scholarship_application_id","user_id") REFERENCES "studexo"."scholarship_applications"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."application_status_history" ADD CONSTRAINT "application_status_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."application_status_history" ADD CONSTRAINT "application_status_history_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "studexo"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."application_status_history" ADD CONSTRAINT "application_status_history_uni_app_user_fk" FOREIGN KEY ("university_application_id","user_id") REFERENCES "studexo"."university_applications"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."application_status_history" ADD CONSTRAINT "application_status_history_sch_app_user_fk" FOREIGN KEY ("scholarship_application_id","user_id") REFERENCES "studexo"."scholarship_applications"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."saved_opportunities" ADD CONSTRAINT "saved_opportunities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."saved_opportunities" ADD CONSTRAINT "saved_opportunities_programme_id_programmes_id_fk" FOREIGN KEY ("programme_id") REFERENCES "studexo"."programmes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."saved_opportunities" ADD CONSTRAINT "saved_opportunities_scholarship_id_scholarships_id_fk" FOREIGN KEY ("scholarship_id") REFERENCES "studexo"."scholarships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."scholarship_applications" ADD CONSTRAINT "scholarship_applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."scholarship_applications" ADD CONSTRAINT "scholarship_applications_scholarship_id_scholarships_id_fk" FOREIGN KEY ("scholarship_id") REFERENCES "studexo"."scholarships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."scholarship_applications" ADD CONSTRAINT "scholarship_applications_intake_sch_fk" FOREIGN KEY ("scholarship_intake_id","scholarship_id") REFERENCES "studexo"."scholarship_intakes"("id","scholarship_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."scholarship_applications" ADD CONSTRAINT "scholarship_applications_uni_app_user_fk" FOREIGN KEY ("university_application_id","user_id") REFERENCES "studexo"."university_applications"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."university_applications" ADD CONSTRAINT "university_applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."university_applications" ADD CONSTRAINT "university_applications_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "studexo"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."university_applications" ADD CONSTRAINT "university_applications_programme_id_programmes_id_fk" FOREIGN KEY ("programme_id") REFERENCES "studexo"."programmes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."university_applications" ADD CONSTRAINT "university_applications_programme_inst_fk" FOREIGN KEY ("programme_id","institution_id") REFERENCES "studexo"."programmes"("id","institution_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."university_applications" ADD CONSTRAINT "university_applications_intake_prog_fk" FOREIGN KEY ("programme_intake_id","programme_id") REFERENCES "studexo"."programme_intakes"("id","programme_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_uni_app_user_fk" FOREIGN KEY ("university_application_id","user_id") REFERENCES "studexo"."university_applications"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_sch_app_user_fk" FOREIGN KEY ("scholarship_application_id","user_id") REFERENCES "studexo"."scholarship_applications"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_task_user_fk" FOREIGN KEY ("planner_task_id","user_id") REFERENCES "studexo"."planner_tasks"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_event_user_fk" FOREIGN KEY ("planner_event_id","user_id") REFERENCES "studexo"."planner_events"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."planner_events" ADD CONSTRAINT "planner_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."planner_events" ADD CONSTRAINT "planner_events_uni_app_user_fk" FOREIGN KEY ("university_application_id","user_id") REFERENCES "studexo"."university_applications"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."planner_events" ADD CONSTRAINT "planner_events_sch_app_user_fk" FOREIGN KEY ("scholarship_application_id","user_id") REFERENCES "studexo"."scholarship_applications"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."planner_tasks" ADD CONSTRAINT "planner_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."planner_tasks" ADD CONSTRAINT "planner_tasks_uni_app_user_fk" FOREIGN KEY ("university_application_id","user_id") REFERENCES "studexo"."university_applications"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."planner_tasks" ADD CONSTRAINT "planner_tasks_sch_app_user_fk" FOREIGN KEY ("scholarship_application_id","user_id") REFERENCES "studexo"."scholarship_applications"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_conversations" ADD CONSTRAINT "ai_conversations_uni_app_user_fk" FOREIGN KEY ("university_application_id","user_id") REFERENCES "studexo"."university_applications"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_conversations" ADD CONSTRAINT "ai_conversations_sch_app_user_fk" FOREIGN KEY ("scholarship_application_id","user_id") REFERENCES "studexo"."scholarship_applications"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_messages" ADD CONSTRAINT "ai_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_messages" ADD CONSTRAINT "ai_messages_conversation_user_fk" FOREIGN KEY ("conversation_id","user_id") REFERENCES "studexo"."ai_conversations"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_permissions" ADD CONSTRAINT "ai_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_permissions" ADD CONSTRAINT "ai_permissions_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "studexo"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_run_context_links" ADD CONSTRAINT "ai_run_context_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_run_context_links" ADD CONSTRAINT "ai_run_context_links_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "studexo"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_run_context_links" ADD CONSTRAINT "ai_run_context_links_programme_id_programmes_id_fk" FOREIGN KEY ("programme_id") REFERENCES "studexo"."programmes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_run_context_links" ADD CONSTRAINT "ai_run_context_links_scholarship_id_scholarships_id_fk" FOREIGN KEY ("scholarship_id") REFERENCES "studexo"."scholarships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_run_context_links" ADD CONSTRAINT "ai_run_context_links_run_user_fk" FOREIGN KEY ("ai_run_id","user_id") REFERENCES "studexo"."ai_runs"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_run_context_links" ADD CONSTRAINT "ai_run_context_links_doc_user_fk" FOREIGN KEY ("document_id","user_id") REFERENCES "studexo"."documents"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_run_context_links" ADD CONSTRAINT "ai_run_context_links_doc_ver_user_fk" FOREIGN KEY ("document_version_id","user_id") REFERENCES "studexo"."document_versions"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_run_context_links" ADD CONSTRAINT "ai_run_context_links_uni_app_user_fk" FOREIGN KEY ("university_application_id","user_id") REFERENCES "studexo"."university_applications"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_run_context_links" ADD CONSTRAINT "ai_run_context_links_sch_app_user_fk" FOREIGN KEY ("scholarship_application_id","user_id") REFERENCES "studexo"."scholarship_applications"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_run_context_links" ADD CONSTRAINT "ai_run_context_links_qual_user_fk" FOREIGN KEY ("student_qualification_id","user_id") REFERENCES "studexo"."student_qualifications"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_run_context_links" ADD CONSTRAINT "ai_run_context_links_test_score_user_fk" FOREIGN KEY ("student_test_score_id","user_id") REFERENCES "studexo"."student_test_scores"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_runs" ADD CONSTRAINT "ai_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_runs" ADD CONSTRAINT "ai_runs_prompt_version_id_ai_prompt_versions_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "studexo"."ai_prompt_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_runs" ADD CONSTRAINT "ai_runs_conversation_user_fk" FOREIGN KEY ("conversation_id","user_id") REFERENCES "studexo"."ai_conversations"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_usage_records" ADD CONSTRAINT "ai_usage_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "studexo"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studexo"."ai_usage_records" ADD CONSTRAINT "ai_usage_records_run_user_fk" FOREIGN KEY ("ai_run_id","user_id") REFERENCES "studexo"."ai_runs"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grading_scales_country_active_idx" ON "studexo"."grading_scales" USING btree ("country_code","is_active");--> statement-breakpoint
CREATE INDEX "test_catalog_category_active_idx" ON "studexo"."test_catalog" USING btree ("category","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "account_settings_user_id_uidx" ON "studexo"."account_settings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_provider_subject_uidx" ON "studexo"."auth_identities" USING btree ("provider","provider_subject");--> statement-breakpoint
CREATE INDEX "auth_identities_user_id_idx" ON "studexo"."auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_consents_user_type_recorded_idx" ON "studexo"."user_consents" USING btree ("user_id","consent_type","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_supabase_auth_user_id_uidx" ON "studexo"."users" USING btree ("supabase_auth_user_id") WHERE supabase_auth_user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "users_primary_email_idx" ON "studexo"."users" USING btree ("primary_email");--> statement-breakpoint
CREATE INDEX "users_role_status_idx" ON "studexo"."users" USING btree ("role","status");--> statement-breakpoint
CREATE INDEX "users_purge_schedule_idx" ON "studexo"."users" USING btree ("purge_state","deletion_scheduled_for");--> statement-breakpoint
CREATE INDEX "users_purge_lease_idx" ON "studexo"."users" USING btree ("purge_state","purge_lease_until");--> statement-breakpoint
CREATE INDEX "student_experiences_user_type_idx" ON "studexo"."student_experiences" USING btree ("user_id","experience_type");--> statement-breakpoint
CREATE UNIQUE INDEX "student_profiles_user_id_uidx" ON "studexo"."student_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "student_profiles_citizenship_idx" ON "studexo"."student_profiles" USING btree ("country_of_citizenship");--> statement-breakpoint
CREATE INDEX "student_pub_proj_user_type_idx" ON "studexo"."student_publications_and_projects" USING btree ("user_id","item_type");--> statement-breakpoint
CREATE INDEX "student_qualifications_user_id_idx" ON "studexo"."student_qualifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "student_qualifications_user_level_idx" ON "studexo"."student_qualifications" USING btree ("user_id","qualification_level");--> statement-breakpoint
CREATE INDEX "student_qualifications_grading_scale_idx" ON "studexo"."student_qualifications" USING btree ("grading_scale_code");--> statement-breakpoint
CREATE UNIQUE INDEX "student_test_scores_user_test_placeholder_uidx" ON "studexo"."student_test_scores" USING btree ("user_id","test_code") WHERE score_status IN ('not_tested', 'not_applicable', 'unknown');--> statement-breakpoint
CREATE INDEX "student_test_scores_user_id_idx" ON "studexo"."student_test_scores" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "student_test_scores_user_test_idx" ON "studexo"."student_test_scores" USING btree ("user_id","test_code");--> statement-breakpoint
CREATE UNIQUE INDEX "institution_aliases_inst_alias_uidx" ON "studexo"."institution_aliases" USING btree ("institution_id","alias_name");--> statement-breakpoint
CREATE INDEX "institution_aliases_alias_name_idx" ON "studexo"."institution_aliases" USING btree ("alias_name");--> statement-breakpoint
CREATE UNIQUE INDEX "institutions_slug_uidx" ON "studexo"."institutions" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "institutions_country_active_idx" ON "studexo"."institutions" USING btree ("country_code","is_active");--> statement-breakpoint
CREATE INDEX "institutions_verification_status_idx" ON "studexo"."institutions" USING btree ("verification_status");--> statement-breakpoint
CREATE INDEX "programme_fees_programme_id_idx" ON "studexo"."programme_fees" USING btree ("programme_id");--> statement-breakpoint
CREATE INDEX "programme_fees_type_cat_idx" ON "studexo"."programme_fees" USING btree ("programme_id","fee_type","student_category");--> statement-breakpoint
CREATE UNIQUE INDEX "programme_intakes_prog_term_year_uidx" ON "studexo"."programme_intakes" USING btree ("programme_id","intake_term","intake_year");--> statement-breakpoint
CREATE INDEX "programme_intakes_deadline_idx" ON "studexo"."programme_intakes" USING btree ("application_deadline_at");--> statement-breakpoint
CREATE INDEX "programme_requirements_programme_id_idx" ON "studexo"."programme_requirements" USING btree ("programme_id");--> statement-breakpoint
CREATE INDEX "programme_requirements_country_idx" ON "studexo"."programme_requirements" USING btree ("programme_id","country_scope");--> statement-breakpoint
CREATE INDEX "programme_requirements_grading_scale_idx" ON "studexo"."programme_requirements" USING btree ("grading_scale_code");--> statement-breakpoint
CREATE INDEX "programme_requirements_test_code_idx" ON "studexo"."programme_requirements" USING btree ("test_code");--> statement-breakpoint
CREATE UNIQUE INDEX "programmes_institution_slug_uidx" ON "studexo"."programmes" USING btree ("institution_id","slug");--> statement-breakpoint
CREATE INDEX "programmes_level_active_idx" ON "studexo"."programmes" USING btree ("study_level","is_active");--> statement-breakpoint
CREATE INDEX "programmes_discipline_idx" ON "studexo"."programmes" USING btree ("discipline");--> statement-breakpoint
CREATE INDEX "scholarship_eligibility_scholarship_id_idx" ON "studexo"."scholarship_eligibility_rules" USING btree ("scholarship_id");--> statement-breakpoint
CREATE INDEX "scholarship_eligibility_type_idx" ON "studexo"."scholarship_eligibility_rules" USING btree ("scholarship_id","rule_type");--> statement-breakpoint
CREATE INDEX "scholarship_eligibility_grading_scale_idx" ON "studexo"."scholarship_eligibility_rules" USING btree ("grading_scale_code");--> statement-breakpoint
CREATE INDEX "scholarship_eligibility_test_code_idx" ON "studexo"."scholarship_eligibility_rules" USING btree ("test_code");--> statement-breakpoint
CREATE INDEX "scholarship_funding_scholarship_id_idx" ON "studexo"."scholarship_funding_components" USING btree ("scholarship_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scholarship_intakes_sch_cycle_uidx" ON "studexo"."scholarship_intakes" USING btree ("scholarship_id","cycle_label");--> statement-breakpoint
CREATE INDEX "scholarship_intakes_deadline_idx" ON "studexo"."scholarship_intakes" USING btree ("application_deadline_at");--> statement-breakpoint
CREATE INDEX "scholarship_programmes_programme_id_idx" ON "studexo"."scholarship_programmes" USING btree ("programme_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scholarships_slug_uidx" ON "studexo"."scholarships" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "scholarships_country_level_active_idx" ON "studexo"."scholarships" USING btree ("host_country_code","study_level","is_active");--> statement-breakpoint
CREATE INDEX "scholarships_institution_id_idx" ON "studexo"."scholarships" USING btree ("institution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_base_url_uidx" ON "studexo"."sources" USING btree ("base_url");--> statement-breakpoint
CREATE INDEX "sources_type_tier_idx" ON "studexo"."sources" USING btree ("source_type","reliability_tier");--> statement-breakpoint
CREATE INDEX "verification_claims_institution_id_idx" ON "studexo"."verification_claims" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "verification_claims_programme_id_idx" ON "studexo"."verification_claims" USING btree ("programme_id");--> statement-breakpoint
CREATE INDEX "verification_claims_scholarship_id_idx" ON "studexo"."verification_claims" USING btree ("scholarship_id");--> statement-breakpoint
CREATE INDEX "verification_claims_status_idx" ON "studexo"."verification_claims" USING btree ("status");--> statement-breakpoint
CREATE INDEX "verification_claims_field_status_idx" ON "studexo"."verification_claims" USING btree ("field_path","status");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_claims_superseded_by_uidx" ON "studexo"."verification_claims" USING btree ("superseded_by_claim_id") WHERE superseded_by_claim_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "verification_evidence_claim_id_idx" ON "studexo"."verification_evidence" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "verification_evidence_source_id_idx" ON "studexo"."verification_evidence" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_doc_version_uidx" ON "studexo"."document_versions" USING btree ("document_id","version_number");--> statement-breakpoint
CREATE INDEX "document_versions_stored_file_id_idx" ON "studexo"."document_versions" USING btree ("stored_file_id");--> statement-breakpoint
CREATE INDEX "document_versions_user_id_idx" ON "studexo"."document_versions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "documents_user_type_idx" ON "studexo"."documents" USING btree ("user_id","document_type");--> statement-breakpoint
CREATE INDEX "documents_user_status_idx" ON "studexo"."documents" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "stored_files_bucket_key_uidx" ON "studexo"."stored_files" USING btree ("storage_bucket","object_key");--> statement-breakpoint
CREATE INDEX "stored_files_owner_status_idx" ON "studexo"."stored_files" USING btree ("owner_user_id","upload_status");--> statement-breakpoint
CREATE INDEX "stored_files_purge_state_lease_idx" ON "studexo"."stored_files" USING btree ("purge_state","purge_lease_until");--> statement-breakpoint
CREATE INDEX "application_checklists_uni_app_id_idx" ON "studexo"."application_checklists" USING btree ("university_application_id");--> statement-breakpoint
CREATE INDEX "application_checklists_sch_app_id_idx" ON "studexo"."application_checklists" USING btree ("scholarship_application_id");--> statement-breakpoint
CREATE INDEX "application_checklists_user_id_idx" ON "studexo"."application_checklists" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "application_documents_replaced_by_uidx" ON "studexo"."application_documents" USING btree ("replaced_by_id") WHERE replaced_by_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "application_documents_active_uni_doc_uidx" ON "studexo"."application_documents" USING btree ("university_application_id","document_id") WHERE university_application_id IS NOT NULL AND document_state IN ('attached', 'verified', 'submitted');--> statement-breakpoint
CREATE UNIQUE INDEX "application_documents_active_sch_doc_uidx" ON "studexo"."application_documents" USING btree ("scholarship_application_id","document_id") WHERE scholarship_application_id IS NOT NULL AND document_state IN ('attached', 'verified', 'submitted');--> statement-breakpoint
CREATE INDEX "application_documents_user_state_idx" ON "studexo"."application_documents" USING btree ("user_id","document_state");--> statement-breakpoint
CREATE INDEX "application_documents_doc_version_id_idx" ON "studexo"."application_documents" USING btree ("document_version_id");--> statement-breakpoint
CREATE INDEX "application_notes_uni_app_id_idx" ON "studexo"."application_notes" USING btree ("university_application_id");--> statement-breakpoint
CREATE INDEX "application_notes_sch_app_id_idx" ON "studexo"."application_notes" USING btree ("scholarship_application_id");--> statement-breakpoint
CREATE INDEX "application_notes_user_id_idx" ON "studexo"."application_notes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "application_status_history_user_changed_idx" ON "studexo"."application_status_history" USING btree ("user_id","changed_at");--> statement-breakpoint
CREATE INDEX "application_status_history_uni_app_idx" ON "studexo"."application_status_history" USING btree ("university_application_id","changed_at");--> statement-breakpoint
CREATE INDEX "application_status_history_sch_app_idx" ON "studexo"."application_status_history" USING btree ("scholarship_application_id","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_opportunities_user_prog_uidx" ON "studexo"."saved_opportunities" USING btree ("user_id","programme_id") WHERE programme_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_opportunities_user_sch_uidx" ON "studexo"."saved_opportunities" USING btree ("user_id","scholarship_id") WHERE scholarship_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "saved_opportunities_user_id_idx" ON "studexo"."saved_opportunities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scholarship_applications_active_sch_intake_uidx" ON "studexo"."scholarship_applications" USING btree ("user_id","scholarship_id","scholarship_intake_id") WHERE scholarship_intake_id IS NOT NULL AND status NOT IN ('rejected', 'withdrawn');--> statement-breakpoint
CREATE UNIQUE INDEX "scholarship_applications_active_sch_no_intake_uidx" ON "studexo"."scholarship_applications" USING btree ("user_id","scholarship_id") WHERE scholarship_intake_id IS NULL AND status NOT IN ('rejected', 'withdrawn');--> statement-breakpoint
CREATE INDEX "scholarship_applications_user_status_idx" ON "studexo"."scholarship_applications" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "scholarship_applications_scholarship_id_idx" ON "studexo"."scholarship_applications" USING btree ("scholarship_id");--> statement-breakpoint
CREATE INDEX "scholarship_applications_intake_id_idx" ON "studexo"."scholarship_applications" USING btree ("scholarship_intake_id");--> statement-breakpoint
CREATE INDEX "scholarship_applications_uni_app_id_idx" ON "studexo"."scholarship_applications" USING btree ("university_application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "university_applications_active_prog_intake_uidx" ON "studexo"."university_applications" USING btree ("user_id","programme_id","programme_intake_id") WHERE programme_intake_id IS NOT NULL AND status NOT IN ('rejected', 'withdrawn');--> statement-breakpoint
CREATE UNIQUE INDEX "university_applications_active_prog_no_intake_uidx" ON "studexo"."university_applications" USING btree ("user_id","programme_id") WHERE programme_intake_id IS NULL AND status NOT IN ('rejected', 'withdrawn');--> statement-breakpoint
CREATE INDEX "university_applications_user_status_idx" ON "studexo"."university_applications" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "university_applications_institution_id_idx" ON "studexo"."university_applications" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "university_applications_programme_id_idx" ON "studexo"."university_applications" USING btree ("programme_id");--> statement-breakpoint
CREATE INDEX "university_applications_intake_id_idx" ON "studexo"."university_applications" USING btree ("programme_intake_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_user_dedupe_uidx" ON "studexo"."notification_deliveries" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notification_deliveries_user_status_sched_idx" ON "studexo"."notification_deliveries" USING btree ("user_id","status","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_user_id_uidx" ON "studexo"."notification_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "planner_events_user_starts_at_idx" ON "studexo"."planner_events" USING btree ("user_id","starts_at");--> statement-breakpoint
CREATE INDEX "planner_events_uni_app_id_idx" ON "studexo"."planner_events" USING btree ("university_application_id");--> statement-breakpoint
CREATE INDEX "planner_events_sch_app_id_idx" ON "studexo"."planner_events" USING btree ("scholarship_application_id");--> statement-breakpoint
CREATE INDEX "planner_tasks_user_status_due_idx" ON "studexo"."planner_tasks" USING btree ("user_id","status","due_at");--> statement-breakpoint
CREATE INDEX "planner_tasks_uni_app_id_idx" ON "studexo"."planner_tasks" USING btree ("university_application_id");--> statement-breakpoint
CREATE INDEX "planner_tasks_sch_app_id_idx" ON "studexo"."planner_tasks" USING btree ("scholarship_application_id");--> statement-breakpoint
CREATE INDEX "ai_conversations_user_status_idx" ON "studexo"."ai_conversations" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "ai_conversations_uni_app_id_idx" ON "studexo"."ai_conversations" USING btree ("university_application_id");--> statement-breakpoint
CREATE INDEX "ai_conversations_sch_app_id_idx" ON "studexo"."ai_conversations" USING btree ("scholarship_application_id");--> statement-breakpoint
CREATE INDEX "ai_messages_conversation_created_idx" ON "studexo"."ai_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_messages_user_id_idx" ON "studexo"."ai_messages" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_permissions_user_feature_uidx" ON "studexo"."ai_permissions" USING btree ("user_id","feature_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_prompt_versions_key_ver_uidx" ON "studexo"."ai_prompt_versions" USING btree ("prompt_key","version_number");--> statement-breakpoint
CREATE INDEX "ai_prompt_versions_feature_active_idx" ON "studexo"."ai_prompt_versions" USING btree ("feature_key","is_active");--> statement-breakpoint
CREATE INDEX "ai_run_context_links_run_id_idx" ON "studexo"."ai_run_context_links" USING btree ("ai_run_id");--> statement-breakpoint
CREATE INDEX "ai_run_context_links_user_id_idx" ON "studexo"."ai_run_context_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_runs_user_created_idx" ON "studexo"."ai_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_runs_status_idx" ON "studexo"."ai_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ai_runs_conversation_id_idx" ON "studexo"."ai_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_records_run_id_uidx" ON "studexo"."ai_usage_records" USING btree ("ai_run_id");--> statement-breakpoint
CREATE INDEX "ai_usage_records_user_recorded_idx" ON "studexo"."ai_usage_records" USING btree ("user_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "external_identity_purge_outbox_auth_uidx" ON "studexo"."external_identity_purge_outbox" USING btree ("supabase_auth_user_id");--> statement-breakpoint
CREATE INDEX "external_identity_purge_outbox_poll_idx" ON "studexo"."external_identity_purge_outbox" USING btree ("status","next_attempt_at","locked_until");--> statement-breakpoint
CREATE INDEX "external_identity_purge_outbox_former_user_idx" ON "studexo"."external_identity_purge_outbox" USING btree ("former_user_id");