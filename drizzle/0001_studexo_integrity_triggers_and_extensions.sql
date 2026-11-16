-- Studexo Phase 8B.2J Custom SQL Migration:
-- Required pg_trgm extension + GIN trigram indexes, 17 PostgreSQL functions, and 50 triggers.
-- Note: Role creation, privilege grants, and ALTER FUNCTION ... OWNER TO studexo_purge_owner
-- are intentionally excluded from this migration so it can execute cleanly as studexo_migrator;
-- see docs/DATABASE_ROLES.md for the bootstrap & operations-admin handoff procedure.

DO $$
DECLARE
  v_trgm_schema text;
BEGIN
  SELECT n.nspname
    INTO v_trgm_schema
    FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'pg_trgm';

  IF v_trgm_schema IS NULL THEN
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'extensions') THEN
        EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions';
      ELSE
        EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_trgm';
      END IF;
    EXCEPTION
      WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
        RAISE EXCEPTION
          'Required PostgreSQL extension pg_trgm is unavailable or studexo_migrator lacks privilege to install it (%: %). Pre-provision pg_trgm as operations admin per docs/DATABASE_ROLES.md Step 2 before running 0001.',
          SQLSTATE,
          SQLERRM
          USING ERRCODE = '0A000';
    END;

    SELECT n.nspname
      INTO v_trgm_schema
      FROM pg_catalog.pg_extension e
      JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = 'pg_trgm';
  END IF;

  IF v_trgm_schema IS NULL THEN
    RAISE EXCEPTION
      'Required PostgreSQL extension pg_trgm was not found after installation attempt. Pre-provision pg_trgm per docs/DATABASE_ROLES.md Step 2.'
      USING ERRCODE = '0A000';
  END IF;

  EXECUTE pg_catalog.format(
    'CREATE INDEX IF NOT EXISTS institutions_name_trgm_gin_idx ON studexo.institutions USING gin (name %I.gin_trgm_ops)',
    v_trgm_schema
  );
  EXECUTE pg_catalog.format(
    'CREATE INDEX IF NOT EXISTS institution_aliases_name_trgm_gin_idx ON studexo.institution_aliases USING gin (alias_name %I.gin_trgm_ops)',
    v_trgm_schema
  );
  EXECUTE pg_catalog.format(
    'CREATE INDEX IF NOT EXISTS programmes_title_trgm_gin_idx ON studexo.programmes USING gin (title %I.gin_trgm_ops)',
    v_trgm_schema
  );
  EXECUTE pg_catalog.format(
    'CREATE INDEX IF NOT EXISTS scholarships_title_trgm_gin_idx ON studexo.scholarships USING gin (title %I.gin_trgm_ops)',
    v_trgm_schema
  );
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. Shared updated_at trigger function (Function 1 of 16)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION studexo.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, studexo
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Shared credential verification guard (Function 2 of 16)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION studexo.guard_student_credentials_verification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, studexo
AS $$
DECLARE
  v_verifier_role studexo.user_role;
  v_file_upload_status studexo.file_upload_status;
  v_file_purge_state studexo.purge_state;
BEGIN
  IF NEW.verification_method = 'self_reported' AND NEW.is_verified THEN
    RAISE EXCEPTION 'Self-reported credentials cannot have is_verified = true.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.is_verified AND NEW.verified_at IS NULL THEN
    RAISE EXCEPTION 'Verified credentials require a non-null verified_at timestamp.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.verified_by_user_id IS NOT NULL THEN
    SELECT u.role
      INTO v_verifier_role
      FROM studexo.users u
     WHERE u.id = NEW.verified_by_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Credential verifier user % does not exist.', NEW.verified_by_user_id
        USING ERRCODE = '23503';
    END IF;

    IF v_verifier_role NOT IN ('counselor', 'admin') THEN
      RAISE EXCEPTION 'Only counselor or admin roles may verify student credentials.'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.verified_by_role IS NOT NULL AND NEW.verified_by_role <> v_verifier_role THEN
      RAISE EXCEPTION 'verified_by_role (%) does not match verifier user role (%).',
        NEW.verified_by_role, v_verifier_role
        USING ERRCODE = '23514';
    END IF;

    NEW.verified_by_role := v_verifier_role;
  END IF;

  IF NEW.evidence_document_version_id IS NOT NULL THEN
    SELECT sf.upload_status, sf.purge_state
      INTO v_file_upload_status, v_file_purge_state
      FROM studexo.document_versions dv
      JOIN studexo.stored_files sf ON sf.id = dv.stored_file_id
     WHERE dv.id = NEW.evidence_document_version_id
       AND dv.user_id = NEW.user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Evidence document version % is not owned by user %.',
        NEW.evidence_document_version_id, NEW.user_id
        USING ERRCODE = '23503';
    END IF;

    IF v_file_upload_status IN ('pending', 'quarantined', 'deleted')
       OR v_file_purge_state <> 'none' THEN
      RAISE EXCEPTION 'Cannot link credential evidence to an unready, quarantined, or purged file.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Users lifecycle & purge guard (Function 3 of 16)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION studexo.guard_users_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, studexo
AS $$
DECLARE
  v_in_account_purge boolean := (
    CURRENT_USER = 'studexo_purge_owner'
    AND pg_catalog.current_setting('studexo.purge_mode', true) = 'account_purge'
  );
  v_is_purge_actor boolean := (
    CURRENT_USER IN ('studexo_purge_worker', 'studexo_purge_owner')
  );
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT v_in_account_purge THEN
      RAISE EXCEPTION 'Direct DELETE on studexo.users is forbidden; invoke studexo.execute_account_purge(uuid).'
        USING ERRCODE = '42501';
    END IF;

    IF OLD.status <> 'pending_deletion' OR OLD.purge_state <> 'purging' THEN
      RAISE EXCEPTION 'User % must be in pending_deletion / purging state before row deletion.', OLD.id
        USING ERRCODE = '23514';
    END IF;

    IF OLD.deletion_scheduled_for IS NULL OR pg_catalog.now() < OLD.deletion_scheduled_for THEN
      RAISE EXCEPTION 'User % deletion grace window has not elapsed.', OLD.id
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM studexo.stored_files sf
       WHERE sf.owner_user_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'Cannot delete user % while stored_files rows still exist.', OLD.id
        USING ERRCODE = '23514';
    END IF;

    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'studexo.users.id is immutable.'
      USING ERRCODE = '23514';
  END IF;

  IF CURRENT_USER = 'studexo_app' THEN
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.supabase_auth_user_id IS DISTINCT FROM OLD.supabase_auth_user_id THEN
      RAISE EXCEPTION 'studexo_app cannot modify user role or external auth identity binding.'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.status = 'suspended' OR (OLD.status = 'suspended' AND NEW.status <> OLD.status) THEN
      RAISE EXCEPTION 'studexo_app cannot perform direct administrative suspension status changes.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF OLD.purge_state = 'purged' AND NEW.purge_state <> 'purged' THEN
    RAISE EXCEPTION 'Cannot transition out of purged state for user %.', OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF OLD.purge_state = 'purging' AND NEW.purge_state IN ('none', 'pending_purge') THEN
    RAISE EXCEPTION 'Cannot revert purging user % back to %.', OLD.id, NEW.purge_state
      USING ERRCODE = '23514';
  END IF;

  IF NOT v_is_purge_actor THEN
    IF NEW.purge_state IN ('purging', 'purge_failed', 'purged')
       OR NEW.purge_lease_owner IS DISTINCT FROM OLD.purge_lease_owner
       OR NEW.purge_lease_until IS DISTINCT FROM OLD.purge_lease_until
       OR NEW.purge_attempts IS DISTINCT FROM OLD.purge_attempts
       OR NEW.last_purge_error IS DISTINCT FROM OLD.last_purge_error
       OR NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
      RAISE EXCEPTION 'Role % cannot mutate internal user purge fields.', CURRENT_USER
        USING ERRCODE = '42501';
    END IF;

    IF OLD.status <> 'pending_deletion' AND NEW.status = 'pending_deletion' THEN
      IF OLD.status <> 'active' OR OLD.purge_state <> 'none' THEN
        RAISE EXCEPTION 'Only active unpurged users may enter pending_deletion.'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.deletion_requested_at IS NULL OR NEW.deletion_scheduled_for IS NULL THEN
        RAISE EXCEPTION 'Deletion request requires both deletion_requested_at and deletion_scheduled_for.'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.deletion_requested_at < pg_catalog.now() - interval '5 minutes' THEN
        RAISE EXCEPTION 'deletion_requested_at cannot be backdated past the 5-minute clock skew window.'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.deletion_scheduled_for < NEW.deletion_requested_at + interval '14 days' THEN
        RAISE EXCEPTION 'Deletion request must enforce at least a 14-day grace interval.'
          USING ERRCODE = '23514';
      END IF;

      NEW.purge_state := 'pending_purge';
    ELSIF OLD.status = 'pending_deletion' AND NEW.status = 'pending_deletion' THEN
      IF NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at THEN
        RAISE EXCEPTION 'Original deletion_requested_at cannot be modified for user %.', OLD.id
          USING ERRCODE = '23514';
      END IF;

      IF NEW.deletion_scheduled_for IS NULL
         OR (OLD.deletion_scheduled_for IS NOT NULL AND NEW.deletion_scheduled_for < OLD.deletion_scheduled_for) THEN
        RAISE EXCEPTION 'Original deletion_scheduled_for deadline cannot be shortened or cleared.'
          USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.status = 'pending_deletion' AND NEW.status <> 'pending_deletion' THEN
      IF NEW.status <> 'active' THEN
        RAISE EXCEPTION 'pending_deletion users cannot bypass lifecycle directly to %.', NEW.status
          USING ERRCODE = '23514';
      END IF;

      IF OLD.purge_state IN ('purging', 'purge_failed', 'purged') THEN
        RAISE EXCEPTION 'Cannot cancel deletion for user % once irreversible purge has started (%).',
          OLD.id, OLD.purge_state
          USING ERRCODE = '23514';
      END IF;

      IF OLD.deletion_scheduled_for IS NULL OR pg_catalog.now() >= OLD.deletion_scheduled_for THEN
        RAISE EXCEPTION 'Cannot cancel deletion for user % after scheduled grace deadline.', OLD.id
          USING ERRCODE = '23514';
      END IF;

      IF NEW.deletion_requested_at IS NOT NULL OR NEW.deletion_scheduled_for IS NOT NULL THEN
        RAISE EXCEPTION 'Cancelling scheduled deletion requires clearing deletion_requested_at and deletion_scheduled_for.'
          USING ERRCODE = '23514';
      END IF;

      NEW.purge_state := 'none';
    END IF;
  ELSE
    -- Purge worker / purge owner transitions
    IF NEW.purge_attempts < OLD.purge_attempts THEN
      RAISE EXCEPTION 'User % purge_attempts cannot decrease (% -> %).', OLD.id, OLD.purge_attempts, NEW.purge_attempts
        USING ERRCODE = '23514';
    END IF;

    IF NEW.purge_state IN ('purging', 'purge_failed', 'purged') THEN
      IF OLD.status <> 'pending_deletion'
         OR OLD.deletion_scheduled_for IS NULL
         OR pg_catalog.now() < OLD.deletion_scheduled_for THEN
        RAISE EXCEPTION 'Cannot advance purge_state for user % before grace window expiry.', OLD.id
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF NEW.purge_state = 'purging' THEN
      IF NEW.purge_lease_owner IS NULL
         OR pg_catalog.btrim(NEW.purge_lease_owner) = ''
         OR NEW.purge_lease_until IS NULL THEN
        RAISE EXCEPTION 'User % purging state requires non-empty purge_lease_owner and purge_lease_until.', OLD.id
          USING ERRCODE = '23514';
      END IF;

      IF NOT v_in_account_purge AND NEW.purge_lease_until <= pg_catalog.now() THEN
        RAISE EXCEPTION 'Account purge lease for user % must expire in the future.', OLD.id
          USING ERRCODE = '23514';
      END IF;

      IF OLD.purge_state = 'purging'
         AND OLD.purge_lease_until IS NOT NULL
         AND OLD.purge_lease_until > pg_catalog.now()
         AND NOT v_in_account_purge
         AND NEW.purge_lease_owner IS DISTINCT FROM OLD.purge_lease_owner THEN
        RAISE EXCEPTION 'Cannot steal active account purge lease for user % held by % until %.',
          OLD.id, OLD.purge_lease_owner, OLD.purge_lease_until
          USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NEW.purge_lease_owner IS NOT NULL OR NEW.purge_lease_until IS NOT NULL THEN
        RAISE EXCEPTION 'User % must clear purge_lease_owner and purge_lease_until when purge_state is %.',
          OLD.id, NEW.purge_state
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF NEW.purge_state = 'purged' AND NOT v_in_account_purge THEN
      RAISE EXCEPTION 'Only execute_account_purge() may mark user % purged.', OLD.id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.status = 'pending_deletion' AND NEW.purge_state = 'none' THEN
    RAISE EXCEPTION 'pending_deletion users must transition purge_state out of none.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Stored files Storage-first lifecycle guard (Function 4 of 17)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION studexo.guard_stored_files_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, studexo
AS $$
DECLARE
  v_in_account_purge boolean := (
    CURRENT_USER = 'studexo_purge_owner'
    AND pg_catalog.current_setting('studexo.purge_mode', true) = 'account_purge'
  );
  v_in_file_deletion_request boolean := (
    CURRENT_USER = 'studexo_migrator'
    AND pg_catalog.current_setting('studexo.file_deletion_mode', true) = 'request'
  );
  v_is_purge_actor boolean := (
    CURRENT_USER IN ('studexo_purge_worker', 'studexo_purge_owner')
  );
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT v_in_account_purge THEN
      RAISE EXCEPTION 'Direct DELETE on stored_files is restricted to execute_account_purge().'
        USING ERRCODE = '42501';
    END IF;

    IF OLD.purge_state <> 'purged' OR OLD.upload_status <> 'deleted' OR OLD.purged_at IS NULL THEN
      RAISE EXCEPTION 'Refusing DELETE on stored_files %: Storage object deletion must be confirmed first (purge_state = purged).',
        OLD.id
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM studexo.document_versions dv
       WHERE dv.stored_file_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'Cannot delete stored_files % while document_versions still reference it.', OLD.id
        USING ERRCODE = '23503';
    END IF;

    RETURN OLD;
  END IF;

  IF NEW.visibility <> 'private' THEN
    RAISE EXCEPTION 'All Studexo stored_files must keep private visibility.'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.upload_status NOT IN ('pending', 'uploaded')
       OR NEW.purge_state <> 'none'
       OR NEW.deleted_at IS NOT NULL
       OR NEW.deleted_by_user_id IS NOT NULL
       OR NEW.purge_requested_at IS NOT NULL
       OR NEW.purge_lease_until IS NOT NULL
       OR NEW.purge_attempts <> 0
       OR NEW.last_purge_error IS NOT NULL
       OR NEW.purged_at IS NOT NULL THEN
      RAISE EXCEPTION 'stored_files rows must be inserted in pending/uploaded upload_status with purge_state = none.'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW.id <> OLD.id
     OR NEW.owner_user_id <> OLD.owner_user_id
     OR NEW.storage_provider <> OLD.storage_provider
     OR NEW.storage_bucket <> OLD.storage_bucket
     OR NEW.object_key <> OLD.object_key THEN
    RAISE EXCEPTION 'stored_files identity, ownership, and storage coordinates are immutable.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.deleted_by_user_id IS DISTINCT FROM OLD.deleted_by_user_id THEN
    IF v_in_account_purge THEN
      IF NOT (
        OLD.deleted_by_user_id IS NOT NULL
        AND NEW.deleted_by_user_id IS NULL
        AND EXISTS (
          SELECT 1
            FROM studexo.users u
           WHERE u.id = OLD.deleted_by_user_id
             AND u.status = 'pending_deletion'
             AND u.purge_state = 'purging'
        )
      ) THEN
        RAISE EXCEPTION 'Account purge may only clear stored_files.deleted_by_user_id for a user in pending_deletion / purging state.'
          USING ERRCODE = '42501';
      END IF;
    ELSIF v_in_file_deletion_request THEN
      IF NOT (
        OLD.deleted_by_user_id IS NULL
        AND NEW.deleted_by_user_id IS NOT NULL
        AND OLD.purge_state = 'none'
        AND NEW.purge_state = 'pending_purge'
        AND OLD.upload_status <> 'deleted'
        AND NEW.upload_status <> 'deleted'
        AND EXISTS (
          SELECT 1
            FROM studexo.users u
           WHERE u.id = NEW.deleted_by_user_id
             AND u.status = 'active'
             AND u.purge_state = 'none'
             AND (OLD.owner_user_id = NEW.deleted_by_user_id OR u.role = 'admin')
        )
      ) THEN
        RAISE EXCEPTION 'File deletion attribution may only set deleted_by_user_id from NULL to an active owner or admin user during none -> pending_purge transition.'
          USING ERRCODE = '42501';
      END IF;
    ELSE
      RAISE EXCEPTION 'Only authorised deletion request or account_purge execution may modify stored_files.deleted_by_user_id.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NOT v_is_purge_actor THEN
    IF v_in_file_deletion_request THEN
      IF NEW.upload_status = 'deleted'
         OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
         OR OLD.purge_state <> 'none'
         OR NEW.purge_state <> 'pending_purge'
         OR NEW.purge_requested_at IS NULL
         OR NEW.purge_lease_until IS DISTINCT FROM OLD.purge_lease_until
         OR NEW.purge_attempts IS DISTINCT FROM OLD.purge_attempts
         OR NEW.last_purge_error IS DISTINCT FROM OLD.last_purge_error
         OR NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
        RAISE EXCEPTION 'File deletion request may only transition purge_state from none to pending_purge.'
          USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.upload_status = 'deleted'
       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
       OR NEW.purge_state IS DISTINCT FROM OLD.purge_state
       OR NEW.purge_requested_at IS DISTINCT FROM OLD.purge_requested_at
       OR NEW.purge_lease_until IS DISTINCT FROM OLD.purge_lease_until
       OR NEW.purge_attempts IS DISTINCT FROM OLD.purge_attempts
       OR NEW.last_purge_error IS DISTINCT FROM OLD.last_purge_error
       OR NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
      RAISE EXCEPTION 'Only authorised lifecycle roles may modify stored_files purge or deletion fields.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF OLD.upload_status <> 'pending' AND NEW.upload_status = 'pending' THEN
    RAISE EXCEPTION 'Cannot revert stored_files upload_status back to pending.'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.upload_status = 'deleted' AND NEW.upload_status <> 'deleted' THEN
    RAISE EXCEPTION 'Deleted stored_files % cannot transition upload_status to %.', OLD.id, NEW.upload_status
      USING ERRCODE = '23514';
  END IF;

  IF OLD.purge_state <> 'none'
     AND OLD.upload_status = 'pending'
     AND NEW.upload_status IN ('uploaded', 'verified') THEN
    RAISE EXCEPTION 'Upload completion blocked because stored_files % has active purge_state %.',
      OLD.id, OLD.purge_state
      USING ERRCODE = '23514';
  END IF;

  IF OLD.purge_state = 'purged' THEN
    IF NEW.purge_state <> 'purged'
       OR NEW.upload_status <> 'deleted'
       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
       OR NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
      RAISE EXCEPTION 'Purged stored_files % cannot transition to % or alter purge timestamps.',
        OLD.id, NEW.purge_state
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.purge_state = 'purging' THEN
    IF NEW.purge_state = 'none' THEN
      RAISE EXCEPTION 'Cannot revert stored_files % directly from purging to none.', OLD.id
        USING ERRCODE = '23514';
    END IF;

    IF NEW.purge_state = 'pending_purge'
       AND OLD.purge_lease_until IS NOT NULL
       AND OLD.purge_lease_until > pg_catalog.now() THEN
      RAISE EXCEPTION 'Cannot reset stored_files % from purging to pending_purge while lease is active.', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.purge_state = 'purged' THEN
    IF OLD.purge_state NOT IN ('purging', 'purged') THEN
      RAISE EXCEPTION 'stored_files % must hold a purging lease before transitioning to purged.', OLD.id
        USING ERRCODE = '23514';
    END IF;

    IF NEW.upload_status <> 'deleted' OR NEW.deleted_at IS NULL OR NEW.purged_at IS NULL THEN
      RAISE EXCEPTION 'Purged stored_files % requires upload_status=deleted, deleted_at, and purged_at.', NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Document versions integrity guard (Function 5 of 16)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION studexo.guard_document_versions_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, studexo
AS $$
DECLARE
  v_upload_status studexo.file_upload_status;
  v_purge_state studexo.purge_state;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id
       OR NEW.document_id <> OLD.document_id
       OR NEW.user_id <> OLD.user_id
       OR NEW.stored_file_id <> OLD.stored_file_id
       OR NEW.version_number <> OLD.version_number THEN
      RAISE EXCEPTION 'document_versions identity, file binding, and version_number are immutable.'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- Lock the stored_files row FOR SHARE so concurrent purge claiming (FOR UPDATE) serializes cleanly.
  SELECT sf.upload_status, sf.purge_state
    INTO v_upload_status, v_purge_state
    FROM studexo.stored_files sf
   WHERE sf.id = NEW.stored_file_id
     AND sf.owner_user_id = NEW.user_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stored_file % does not exist for user %.', NEW.stored_file_id, NEW.user_id
      USING ERRCODE = '23503';
  END IF;

  IF v_upload_status NOT IN ('uploaded', 'verified') OR v_purge_state <> 'none' THEN
    RAISE EXCEPTION 'document_versions requires an uploaded/verified, unpurged stored_file.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Application documents lifecycle & replacement guard (Function 6 of 16)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION studexo.guard_application_documents_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, studexo
AS $$
DECLARE
  v_in_account_purge boolean := (
    CURRENT_USER = 'studexo_purge_owner'
    AND pg_catalog.current_setting('studexo.purge_mode', true) = 'account_purge'
  );
  v_app_key text;
  v_lock_id bigint;
  v_file_upload_status studexo.file_upload_status;
  v_file_purge_state studexo.purge_state;
  v_target_user_id uuid;
  v_target_uni_app_id uuid;
  v_target_sch_app_id uuid;
  v_target_state studexo.application_document_state;
  v_cycle_found boolean := false;
BEGIN
  v_app_key := 'studexo:appdoc:' || COALESCE(
    CASE WHEN TG_OP = 'DELETE' THEN OLD.university_application_id::text ELSE NEW.university_application_id::text END,
    CASE WHEN TG_OP = 'DELETE' THEN OLD.scholarship_application_id::text ELSE NEW.scholarship_application_id::text END
  );
  v_lock_id := ('x' || pg_catalog.substr(pg_catalog.md5(v_app_key), 1, 16))::bit(64)::bigint;
  PERFORM pg_catalog.pg_advisory_xact_lock(v_lock_id);

  IF TG_OP = 'DELETE' THEN
    IF v_in_account_purge THEN
      RETURN OLD;
    END IF;

    IF OLD.document_state = 'submitted' THEN
      RAISE EXCEPTION 'Submitted application_documents row % cannot be deleted directly; withdraw or replace it.',
        OLD.id
        USING ERRCODE = '23514';
    END IF;

    IF OLD.document_state = 'replaced' THEN
      RAISE EXCEPTION 'Replaced application_documents row % cannot be deleted directly; replacement history is immutable.',
        OLD.id
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM studexo.application_documents ad
       WHERE ad.replaced_by_id = OLD.id
         AND ad.user_id = OLD.user_id
    ) THEN
      RAISE EXCEPTION 'Cannot delete application_documents row % because another row records replaced_by_id pointing to it.',
        OLD.id
        USING ERRCODE = '23514';
    END IF;

    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.document_state IN ('withdrawn', 'replaced') THEN
      RAISE EXCEPTION 'New application_documents row % cannot start in % state.',
        NEW.id, NEW.document_state
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id
       OR NEW.user_id <> OLD.user_id
       OR NEW.university_application_id IS DISTINCT FROM OLD.university_application_id
       OR NEW.scholarship_application_id IS DISTINCT FROM OLD.scholarship_application_id
       OR NEW.document_id <> OLD.document_id THEN
      RAISE EXCEPTION 'application_documents row % cannot alter identity, ownership, application, or document bindings.',
        OLD.id
        USING ERRCODE = '23514';
    END IF;

    IF OLD.document_state = 'replaced' THEN
      IF NEW.document_state <> 'replaced'
         OR NEW.replaced_by_id IS DISTINCT FROM OLD.replaced_by_id
         OR NEW.document_version_id <> OLD.document_version_id
         OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
         OR NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at THEN
        RAISE EXCEPTION 'Replaced application_documents row % is historically immutable.',
          OLD.id
          USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.document_state = 'withdrawn' THEN
      IF NEW.document_state <> 'withdrawn'
         OR NEW.document_version_id <> OLD.document_version_id
         OR NEW.replaced_by_id IS DISTINCT FROM OLD.replaced_by_id
         OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
         OR NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at THEN
        RAISE EXCEPTION 'Withdrawn application_documents row % cannot return to active or submitted states.',
          OLD.id
          USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.document_state = 'submitted' THEN
      IF NEW.document_version_id <> OLD.document_version_id
         OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
        RAISE EXCEPTION 'Submitted application_documents row % cannot alter document_version_id or submitted_at.',
          OLD.id
          USING ERRCODE = '23514';
      END IF;

      IF NEW.document_state IN ('attached', 'verified') THEN
        RAISE EXCEPTION 'Submitted application_documents row % cannot revert to %.',
          OLD.id, NEW.document_state
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF NEW.document_state = 'withdrawn' AND OLD.document_state <> 'withdrawn' THEN
      IF EXISTS (
        SELECT 1
          FROM studexo.application_documents ad
         WHERE ad.replaced_by_id = NEW.id
           AND ad.user_id = NEW.user_id
      ) THEN
        RAISE EXCEPTION 'Cannot withdraw application_documents row % because it is an active replacement target.',
          NEW.id
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF NEW.document_state IN ('attached', 'verified', 'submitted') THEN
    SELECT sf.upload_status, sf.purge_state
      INTO v_file_upload_status, v_file_purge_state
      FROM studexo.document_versions dv
      JOIN studexo.stored_files sf ON sf.id = dv.stored_file_id
     WHERE dv.id = NEW.document_version_id
       AND dv.document_id = NEW.document_id
       AND dv.user_id = NEW.user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Document version % does not match document % and user %.',
        NEW.document_version_id, NEW.document_id, NEW.user_id
        USING ERRCODE = '23503';
    END IF;

    IF v_file_upload_status IN ('pending', 'quarantined', 'deleted')
       OR v_file_purge_state <> 'none' THEN
      RAISE EXCEPTION 'Cannot attach or submit quarantined, pending, or purged file version %.',
        NEW.document_version_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.replaced_by_id IS NOT NULL THEN
    SELECT ad.user_id, ad.university_application_id, ad.scholarship_application_id, ad.document_state
      INTO v_target_user_id, v_target_uni_app_id, v_target_sch_app_id, v_target_state
      FROM studexo.application_documents ad
     WHERE ad.id = NEW.replaced_by_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Replacement application_documents row % does not exist.', NEW.replaced_by_id
        USING ERRCODE = '23503';
    END IF;

    IF v_target_user_id <> NEW.user_id
       OR v_target_uni_app_id IS DISTINCT FROM NEW.university_application_id
       OR v_target_sch_app_id IS DISTINCT FROM NEW.scholarship_application_id THEN
      RAISE EXCEPTION 'Replacement application_documents row % must belong to the same user and application.',
        NEW.replaced_by_id
        USING ERRCODE = '23514';
    END IF;

    IF v_target_state = 'withdrawn' THEN
      RAISE EXCEPTION 'Replacement target % cannot be withdrawn.', NEW.replaced_by_id
        USING ERRCODE = '23514';
    END IF;

    WITH RECURSIVE walk AS (
      SELECT ad.id, ad.replaced_by_id, ARRAY[ad.id] AS visited
        FROM studexo.application_documents ad
       WHERE ad.id = NEW.replaced_by_id
      UNION ALL
      SELECT nxt.id, nxt.replaced_by_id, w.visited || nxt.id
        FROM walk w
        JOIN studexo.application_documents nxt ON nxt.id = w.replaced_by_id
       WHERE w.replaced_by_id IS NOT NULL
         AND NOT (nxt.id = ANY(w.visited))
    )
    SELECT EXISTS (
      SELECT 1
        FROM walk
       WHERE id = NEW.id
          OR replaced_by_id = NEW.id
    )
      INTO v_cycle_found;

    IF v_cycle_found THEN
      RAISE EXCEPTION 'Replacement chain cycle detected on application_documents %.', NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. Verification claims supersession concurrency & immutability guard (Function 7 of 16)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION studexo.guard_verification_claims_supersession()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, studexo
AS $$
DECLARE
  v_isolation text;
  v_target_type text;
  v_target_id text;
  v_lock_input text;
  v_lock_id bigint;
  v_target_inst uuid;
  v_target_prog uuid;
  v_target_sch uuid;
  v_target_field varchar(120);
  v_target_status studexo.verification_status;
  v_cycle_found boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id THEN
      RAISE EXCEPTION 'verification_claims.id is immutable.'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.institution_id IS DISTINCT FROM OLD.institution_id
       OR NEW.programme_id IS DISTINCT FROM OLD.programme_id
       OR NEW.scholarship_id IS DISTINCT FROM OLD.scholarship_id
       OR NEW.field_path IS DISTINCT FROM OLD.field_path THEN
      RAISE EXCEPTION 'verification_claims target (institution_id, programme_id, scholarship_id, field_path) is immutable.'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'superseded' OR OLD.superseded_by_claim_id IS NOT NULL THEN
      -- Narrow exception: explicit account-purge anonymisation of verified_by_user_id only
      -- executed by studexo_purge_owner inside execute_account_purge(uuid).
      IF pg_catalog.current_setting('studexo.purge_mode', true) = 'account_purge'
         AND CURRENT_USER = 'studexo_purge_owner'
         AND OLD.verified_by_user_id IS NOT NULL
         AND NEW.verified_by_user_id IS NULL
         AND NEW.status = OLD.status
         AND NEW.claimed_value IS NOT DISTINCT FROM OLD.claimed_value
         AND NEW.verified_at IS NOT DISTINCT FROM OLD.verified_at
         AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at
         AND NEW.superseded_by_claim_id IS NOT DISTINCT FROM OLD.superseded_by_claim_id
         AND NEW.superseded_at IS NOT DISTINCT FROM OLD.superseded_at
         AND NEW.notes IS NOT DISTINCT FROM OLD.notes
         AND NEW.created_at = OLD.created_at
         AND NEW.updated_at = OLD.updated_at
         AND EXISTS (
           SELECT 1
             FROM studexo.users u
            WHERE u.id = OLD.verified_by_user_id
              AND u.status = 'pending_deletion'
              AND u.purge_state = 'purging'
         ) THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'Superseded verification_claim % is immutable and cannot be restored or modified.',
        OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.superseded_by_claim_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_isolation := pg_catalog.current_setting('transaction_isolation');
  IF v_isolation <> 'read committed' THEN
    RAISE EXCEPTION 'verification_claims supersession requires READ COMMITTED transaction isolation (got: %).',
      v_isolation
      USING ERRCODE = '25000';
  END IF;

  IF NEW.institution_id IS NOT NULL THEN
    v_target_type := 'institution';
    v_target_id := NEW.institution_id::text;
  ELSIF NEW.programme_id IS NOT NULL THEN
    v_target_type := 'programme';
    v_target_id := NEW.programme_id::text;
  ELSIF NEW.scholarship_id IS NOT NULL THEN
    v_target_type := 'scholarship';
    v_target_id := NEW.scholarship_id::text;
  ELSE
    RAISE EXCEPTION 'verification_claims must reference exactly one catalog target.'
      USING ERRCODE = '23514';
  END IF;

  v_lock_input := 'studexo:vclaim:' || v_target_type || ':' || v_target_id || ':' || NEW.field_path;
  v_lock_id := ('x' || pg_catalog.substr(pg_catalog.md5(v_lock_input), 1, 16))::bit(64)::bigint;

  PERFORM pg_catalog.pg_advisory_xact_lock(v_lock_id);

  SELECT vc.institution_id, vc.programme_id, vc.scholarship_id, vc.field_path, vc.status
    INTO v_target_inst, v_target_prog, v_target_sch, v_target_field, v_target_status
    FROM studexo.verification_claims vc
   WHERE vc.id = NEW.superseded_by_claim_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Superseding verification_claim % does not exist.', NEW.superseded_by_claim_id
      USING ERRCODE = '23503';
  END IF;

  IF v_target_inst IS DISTINCT FROM NEW.institution_id
     OR v_target_prog IS DISTINCT FROM NEW.programme_id
     OR v_target_sch IS DISTINCT FROM NEW.scholarship_id
     OR v_target_field IS DISTINCT FROM NEW.field_path THEN
    RAISE EXCEPTION 'Superseding claim % must target the exact same catalog entity and field_path.',
      NEW.superseded_by_claim_id
      USING ERRCODE = '23514';
  END IF;

  IF v_target_status IN ('superseded', 'rejected', 'disputed') THEN
    RAISE EXCEPTION 'Superseding verification_claim % cannot have status %.',
      NEW.superseded_by_claim_id, v_target_status
      USING ERRCODE = '23514';
  END IF;

  WITH RECURSIVE chain AS (
    SELECT vc.id, vc.superseded_by_claim_id, ARRAY[vc.id] AS visited
      FROM studexo.verification_claims vc
     WHERE vc.id = NEW.superseded_by_claim_id
    UNION ALL
    SELECT nxt.id, nxt.superseded_by_claim_id, c.visited || nxt.id
      FROM chain c
      JOIN studexo.verification_claims nxt ON nxt.id = c.superseded_by_claim_id
     WHERE c.superseded_by_claim_id IS NOT NULL
       AND NOT (nxt.id = ANY(c.visited))
  )
  SELECT EXISTS (
    SELECT 1
      FROM chain
     WHERE id = NEW.id
        OR superseded_by_claim_id = NEW.id
  )
    INTO v_cycle_found;

  IF v_cycle_found THEN
    RAISE EXCEPTION 'Verification claim supersession cycle detected involving claim %.', NEW.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. Verification evidence immutability guard (Function 8 of 16)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION studexo.guard_verification_evidence_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, studexo
AS $$
BEGIN
  RAISE EXCEPTION 'studexo.verification_evidence is append-only and immutable (% forbidden).', TG_OP
    USING ERRCODE = '42501';
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9–15. Composite ON DELETE NO ACTION Unlinker Functions (Functions 9–15 of 16)
-- Note: programme_intakes and scholarship_intakes use ON DELETE RESTRICT instead
-- of silent nullification to prevent partial unique index collisions & lost intake provenance.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION studexo.unlink_document_version_refs()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, studexo
AS $$
BEGIN
  UPDATE studexo.student_qualifications
     SET evidence_document_version_id = NULL,
         is_verified = CASE WHEN verification_method = 'document_evidence' THEN false ELSE is_verified END,
         verified_by_user_id = CASE WHEN verification_method = 'document_evidence' THEN NULL ELSE verified_by_user_id END,
         verified_by_role = CASE WHEN verification_method = 'document_evidence' THEN NULL ELSE verified_by_role END,
         verified_at = CASE WHEN verification_method = 'document_evidence' THEN NULL ELSE verified_at END,
         verification_method = CASE WHEN verification_method = 'document_evidence' THEN 'self_reported' ELSE verification_method END
   WHERE evidence_document_version_id = OLD.id
     AND user_id = OLD.user_id;

  UPDATE studexo.student_test_scores
     SET evidence_document_version_id = NULL,
         is_verified = CASE WHEN verification_method = 'document_evidence' THEN false ELSE is_verified END,
         verified_by_user_id = CASE WHEN verification_method = 'document_evidence' THEN NULL ELSE verified_by_user_id END,
         verified_by_role = CASE WHEN verification_method = 'document_evidence' THEN NULL ELSE verified_by_role END,
         verified_at = CASE WHEN verification_method = 'document_evidence' THEN NULL ELSE verified_at END,
         verification_method = CASE WHEN verification_method = 'document_evidence' THEN 'self_reported' ELSE verification_method END
   WHERE evidence_document_version_id = OLD.id
     AND user_id = OLD.user_id;

  UPDATE studexo.student_experiences
     SET evidence_document_version_id = NULL,
         is_verified = CASE WHEN verification_method = 'document_evidence' THEN false ELSE is_verified END,
         verified_by_user_id = CASE WHEN verification_method = 'document_evidence' THEN NULL ELSE verified_by_user_id END,
         verified_by_role = CASE WHEN verification_method = 'document_evidence' THEN NULL ELSE verified_by_role END,
         verified_at = CASE WHEN verification_method = 'document_evidence' THEN NULL ELSE verified_at END,
         verification_method = CASE WHEN verification_method = 'document_evidence' THEN 'self_reported' ELSE verification_method END
   WHERE evidence_document_version_id = OLD.id
     AND user_id = OLD.user_id;

  UPDATE studexo.student_publications_and_projects
     SET evidence_document_version_id = NULL,
         is_verified = CASE WHEN verification_method = 'document_evidence' THEN false ELSE is_verified END,
         verified_by_user_id = CASE WHEN verification_method = 'document_evidence' THEN NULL ELSE verified_by_user_id END,
         verified_by_role = CASE WHEN verification_method = 'document_evidence' THEN NULL ELSE verified_by_role END,
         verified_at = CASE WHEN verification_method = 'document_evidence' THEN NULL ELSE verified_at END,
         verification_method = CASE WHEN verification_method = 'document_evidence' THEN 'self_reported' ELSE verification_method END
   WHERE evidence_document_version_id = OLD.id
     AND user_id = OLD.user_id;

  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION studexo.unlink_university_application_refs()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, studexo
AS $$
BEGIN
  UPDATE studexo.scholarship_applications
     SET university_application_id = NULL
   WHERE university_application_id = OLD.id
     AND user_id = OLD.user_id;

  UPDATE studexo.planner_tasks
     SET university_application_id = NULL
   WHERE university_application_id = OLD.id
     AND user_id = OLD.user_id;

  UPDATE studexo.planner_events
     SET university_application_id = NULL
   WHERE university_application_id = OLD.id
     AND user_id = OLD.user_id;

  UPDATE studexo.ai_conversations
     SET university_application_id = NULL
   WHERE university_application_id = OLD.id
     AND user_id = OLD.user_id;

  UPDATE studexo.notification_deliveries
     SET university_application_id = NULL
   WHERE university_application_id = OLD.id
     AND user_id = OLD.user_id;

  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION studexo.unlink_scholarship_application_refs()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, studexo
AS $$
BEGIN
  UPDATE studexo.planner_tasks
     SET scholarship_application_id = NULL
   WHERE scholarship_application_id = OLD.id
     AND user_id = OLD.user_id;

  UPDATE studexo.planner_events
     SET scholarship_application_id = NULL
   WHERE scholarship_application_id = OLD.id
     AND user_id = OLD.user_id;

  UPDATE studexo.ai_conversations
     SET scholarship_application_id = NULL
   WHERE scholarship_application_id = OLD.id
     AND user_id = OLD.user_id;

  UPDATE studexo.notification_deliveries
     SET scholarship_application_id = NULL
   WHERE scholarship_application_id = OLD.id
     AND user_id = OLD.user_id;

  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION studexo.unlink_document_refs()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, studexo
AS $$
BEGIN
  UPDATE studexo.application_checklists
     SET linked_document_id = NULL
   WHERE linked_document_id = OLD.id
     AND user_id = OLD.user_id;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION studexo.unlink_ai_conversation_refs()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, studexo
AS $$
BEGIN
  UPDATE studexo.ai_runs
     SET conversation_id = NULL
   WHERE conversation_id = OLD.id
     AND user_id = OLD.user_id;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION studexo.unlink_planner_task_refs()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, studexo
AS $$
BEGIN
  UPDATE studexo.notification_deliveries
     SET planner_task_id = NULL
   WHERE planner_task_id = OLD.id
     AND user_id = OLD.user_id;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION studexo.unlink_planner_event_refs()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, studexo
AS $$
BEGIN
  UPDATE studexo.notification_deliveries
     SET planner_event_id = NULL
   WHERE planner_event_id = OLD.id
     AND user_id = OLD.user_id;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 16. Account Purge Entry Point (Function 16 of 16, SECURITY DEFINER)
--     Note: Operations admin transfers function ownership to studexo_purge_owner
--     after migration execution (see docs/DATABASE_ROLES.md).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION studexo.execute_account_purge(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, studexo
AS $$
DECLARE
  v_user studexo.users%ROWTYPE;
  v_unpurged_files bigint;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'studexo.execute_account_purge requires READ COMMITTED transaction isolation (got: %).',
      pg_catalog.current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;

  SELECT *
    INTO v_user
    FROM studexo.users u
   WHERE u.id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account purge target user % does not exist.', p_user_id
      USING ERRCODE = '22023';
  END IF;

  IF v_user.status <> 'pending_deletion' THEN
    RAISE EXCEPTION 'User % must be in pending_deletion status before purge.', p_user_id
      USING ERRCODE = '23514';
  END IF;

  IF v_user.deletion_scheduled_for IS NULL OR pg_catalog.now() < v_user.deletion_scheduled_for THEN
    RAISE EXCEPTION 'User % deletion grace window has not elapsed.', p_user_id
      USING ERRCODE = '23514';
  END IF;

  SELECT pg_catalog.count(*)
    INTO v_unpurged_files
    FROM studexo.stored_files sf
   WHERE sf.owner_user_id = p_user_id
     AND (
       sf.purge_state <> 'purged'
       OR sf.upload_status <> 'deleted'
       OR sf.purged_at IS NULL
     );

  IF v_unpurged_files > 0 THEN
    RAISE EXCEPTION 'Refusing database account purge for user %: % stored_files row(s) are not yet Storage-confirmed purged.',
      p_user_id, v_unpurged_files
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.set_config('studexo.purge_mode', 'account_purge', true);

  UPDATE studexo.users
     SET purge_state = 'purging',
         purge_lease_owner = COALESCE(purge_lease_owner, 'execute_account_purge'),
         purge_lease_until = COALESCE(purge_lease_until, pg_catalog.now() + interval '5 minutes')
   WHERE id = p_user_id;

  IF v_user.supabase_auth_user_id IS NOT NULL THEN
    INSERT INTO studexo.external_identity_purge_outbox (
      former_user_id,
      supabase_auth_user_id,
      status
    )
    VALUES (
      p_user_id,
      v_user.supabase_auth_user_id,
      'pending_purge'
    )
    ON CONFLICT (supabase_auth_user_id) DO NOTHING;
  END IF;

  -- Explicitly anonymise cross-user verifier / deleter references as studexo_purge_owner
  -- before deleting stored_files or studexo.users.
  UPDATE studexo.verification_claims
     SET verified_by_user_id = NULL
   WHERE verified_by_user_id = p_user_id;

  UPDATE studexo.stored_files
     SET deleted_by_user_id = NULL
   WHERE deleted_by_user_id = p_user_id;

  -- Delete dependent application artifacts and stored_files rows cleanly before deleting studexo.users.
  DELETE FROM studexo.application_documents WHERE user_id = p_user_id;
  DELETE FROM studexo.documents WHERE user_id = p_user_id;
  DELETE FROM studexo.stored_files WHERE owner_user_id = p_user_id;
  DELETE FROM studexo.users WHERE id = p_user_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION studexo.execute_account_purge(uuid) FROM PUBLIC;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 17. Stored File Deletion Attribution Entry Point (Function 17 of 17, SECURITY DEFINER)
--     Owned by studexo_migrator (never studexo_purge_owner). Narrowly grants
--     studexo_app a controlled way to attribute stored_files.deleted_by_user_id
--     and transition none -> pending_purge without opening direct UPDATE on
--     deleted_by_user_id or purge_state.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION studexo.request_stored_file_deletion(
  p_file_id uuid,
  p_actor_user_id uuid
)
RETURNS studexo.stored_files
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, studexo
AS $$
DECLARE
  v_actor_role studexo.user_role;
  v_actor_status studexo.account_status;
  v_actor_purge_state studexo.purge_state;
  v_file studexo.stored_files%ROWTYPE;
BEGIN
  IF p_file_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'Both p_file_id and p_actor_user_id are required to attribute stored_files deletion.'
      USING ERRCODE = '22023';
  END IF;

  SELECT u.role, u.status, u.purge_state
    INTO v_actor_role, v_actor_status, v_actor_purge_state
    FROM studexo.users u
   WHERE u.id = p_actor_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Deletion actor user % does not exist.', p_actor_user_id
      USING ERRCODE = '23503';
  END IF;

  IF v_actor_status <> 'active' OR v_actor_purge_state <> 'none' THEN
    RAISE EXCEPTION 'Deletion actor user % must be active with purge_state = none (got status=%, purge_state=%).',
      p_actor_user_id, v_actor_status, v_actor_purge_state
      USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_file
    FROM studexo.stored_files sf
   WHERE sf.id = p_file_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target stored_files row % does not exist.', p_file_id
      USING ERRCODE = '22023';
  END IF;

  IF v_file.owner_user_id <> p_actor_user_id AND v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'Actor user % (role=%) is not authorised to delete stored_files % owned by %.',
      p_actor_user_id, v_actor_role, p_file_id, v_file.owner_user_id
      USING ERRCODE = '42501';
  END IF;

  IF v_file.upload_status = 'deleted'
     OR v_file.purge_state <> 'none'
     OR v_file.deleted_by_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'stored_files % is already deleted, purged, or pending purge (upload_status=%, purge_state=%).',
      p_file_id, v_file.upload_status, v_file.purge_state
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM studexo.document_versions dv
     WHERE dv.stored_file_id = p_file_id
  ) THEN
    RAISE EXCEPTION 'Cannot request deletion for stored_files % while document_versions reference it.', p_file_id
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.set_config('studexo.file_deletion_mode', 'request', true);

  UPDATE studexo.stored_files
     SET deleted_by_user_id = p_actor_user_id,
         purge_state = 'pending_purge',
         purge_requested_at = pg_catalog.now()
   WHERE id = p_file_id
  RETURNING * INTO v_file;

  PERFORM pg_catalog.set_config('studexo.file_deletion_mode', '', true);

  RETURN v_file;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION studexo.request_stored_file_deletion(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 33 updated_at Triggers (Triggers 1–33 of 50)
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_grading_scales_updated_at
  BEFORE UPDATE ON studexo.grading_scales
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_test_catalog_updated_at
  BEFORE UPDATE ON studexo.test_catalog
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON studexo.users
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_auth_identities_updated_at
  BEFORE UPDATE ON studexo.auth_identities
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_account_settings_updated_at
  BEFORE UPDATE ON studexo.account_settings
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_student_profiles_updated_at
  BEFORE UPDATE ON studexo.student_profiles
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_student_qualifications_updated_at
  BEFORE UPDATE ON studexo.student_qualifications
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_student_test_scores_updated_at
  BEFORE UPDATE ON studexo.student_test_scores
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_student_experiences_updated_at
  BEFORE UPDATE ON studexo.student_experiences
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_student_publications_and_projects_updated_at
  BEFORE UPDATE ON studexo.student_publications_and_projects
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_institutions_updated_at
  BEFORE UPDATE ON studexo.institutions
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_programmes_updated_at
  BEFORE UPDATE ON studexo.programmes
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_programme_intakes_updated_at
  BEFORE UPDATE ON studexo.programme_intakes
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_programme_fees_updated_at
  BEFORE UPDATE ON studexo.programme_fees
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_programme_requirements_updated_at
  BEFORE UPDATE ON studexo.programme_requirements
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_scholarships_updated_at
  BEFORE UPDATE ON studexo.scholarships
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_scholarship_intakes_updated_at
  BEFORE UPDATE ON studexo.scholarship_intakes
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_sources_updated_at
  BEFORE UPDATE ON studexo.sources
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_verification_claims_updated_at
  BEFORE UPDATE ON studexo.verification_claims
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_stored_files_updated_at
  BEFORE UPDATE ON studexo.stored_files
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_documents_updated_at
  BEFORE UPDATE ON studexo.documents
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_university_applications_updated_at
  BEFORE UPDATE ON studexo.university_applications
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_scholarship_applications_updated_at
  BEFORE UPDATE ON studexo.scholarship_applications
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_application_documents_updated_at
  BEFORE UPDATE ON studexo.application_documents
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_application_checklists_updated_at
  BEFORE UPDATE ON studexo.application_checklists
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_application_notes_updated_at
  BEFORE UPDATE ON studexo.application_notes
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_planner_tasks_updated_at
  BEFORE UPDATE ON studexo.planner_tasks
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_planner_events_updated_at
  BEFORE UPDATE ON studexo.planner_events
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_notification_preferences_updated_at
  BEFORE UPDATE ON studexo.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_notification_deliveries_updated_at
  BEFORE UPDATE ON studexo.notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_ai_permissions_updated_at
  BEFORE UPDATE ON studexo.ai_permissions
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_ai_conversations_updated_at
  BEFORE UPDATE ON studexo.ai_conversations
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_external_identity_purge_outbox_updated_at
  BEFORE UPDATE ON studexo.external_identity_purge_outbox
  FOR EACH ROW EXECUTE FUNCTION studexo.set_updated_at();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 17 Domain / Lifecycle Triggers (Triggers 34–50 of 50)
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_student_qualifications_verification_guard
  BEFORE INSERT OR UPDATE ON studexo.student_qualifications
  FOR EACH ROW EXECUTE FUNCTION studexo.guard_student_credentials_verification();
--> statement-breakpoint
CREATE TRIGGER trg_student_test_scores_verification_guard
  BEFORE INSERT OR UPDATE ON studexo.student_test_scores
  FOR EACH ROW EXECUTE FUNCTION studexo.guard_student_credentials_verification();
--> statement-breakpoint
CREATE TRIGGER trg_student_experiences_verification_guard
  BEFORE INSERT OR UPDATE ON studexo.student_experiences
  FOR EACH ROW EXECUTE FUNCTION studexo.guard_student_credentials_verification();
--> statement-breakpoint
CREATE TRIGGER trg_student_publications_and_projects_verification_guard
  BEFORE INSERT OR UPDATE ON studexo.student_publications_and_projects
  FOR EACH ROW EXECUTE FUNCTION studexo.guard_student_credentials_verification();
--> statement-breakpoint

CREATE TRIGGER trg_users_lifecycle
  BEFORE UPDATE OR DELETE ON studexo.users
  FOR EACH ROW EXECUTE FUNCTION studexo.guard_users_lifecycle();
--> statement-breakpoint
CREATE TRIGGER trg_stored_files_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON studexo.stored_files
  FOR EACH ROW EXECUTE FUNCTION studexo.guard_stored_files_lifecycle();
--> statement-breakpoint
CREATE TRIGGER trg_document_versions_integrity
  BEFORE INSERT OR UPDATE ON studexo.document_versions
  FOR EACH ROW EXECUTE FUNCTION studexo.guard_document_versions_integrity();
--> statement-breakpoint
CREATE TRIGGER trg_application_documents_integrity
  BEFORE INSERT OR UPDATE OR DELETE ON studexo.application_documents
  FOR EACH ROW EXECUTE FUNCTION studexo.guard_application_documents_integrity();
--> statement-breakpoint
CREATE TRIGGER trg_verification_claims_supersession
  BEFORE INSERT OR UPDATE ON studexo.verification_claims
  FOR EACH ROW EXECUTE FUNCTION studexo.guard_verification_claims_supersession();
--> statement-breakpoint
CREATE TRIGGER trg_verification_evidence_immutable
  BEFORE UPDATE OR DELETE ON studexo.verification_evidence
  FOR EACH ROW EXECUTE FUNCTION studexo.guard_verification_evidence_immutable();
--> statement-breakpoint

CREATE TRIGGER trg_document_versions_unlink_refs
  BEFORE DELETE ON studexo.document_versions
  FOR EACH ROW EXECUTE FUNCTION studexo.unlink_document_version_refs();
--> statement-breakpoint
CREATE TRIGGER trg_university_applications_unlink_refs
  BEFORE DELETE ON studexo.university_applications
  FOR EACH ROW EXECUTE FUNCTION studexo.unlink_university_application_refs();
--> statement-breakpoint
CREATE TRIGGER trg_scholarship_applications_unlink_refs
  BEFORE DELETE ON studexo.scholarship_applications
  FOR EACH ROW EXECUTE FUNCTION studexo.unlink_scholarship_application_refs();
--> statement-breakpoint
CREATE TRIGGER trg_documents_unlink_refs
  BEFORE DELETE ON studexo.documents
  FOR EACH ROW EXECUTE FUNCTION studexo.unlink_document_refs();
--> statement-breakpoint
CREATE TRIGGER trg_ai_conversations_unlink_refs
  BEFORE DELETE ON studexo.ai_conversations
  FOR EACH ROW EXECUTE FUNCTION studexo.unlink_ai_conversation_refs();
--> statement-breakpoint
CREATE TRIGGER trg_planner_tasks_unlink_refs
  BEFORE DELETE ON studexo.planner_tasks
  FOR EACH ROW EXECUTE FUNCTION studexo.unlink_planner_task_refs();
--> statement-breakpoint
CREATE TRIGGER trg_planner_events_unlink_refs
  BEFORE DELETE ON studexo.planner_events
  FOR EACH ROW EXECUTE FUNCTION studexo.unlink_planner_event_refs();