-- Studexo Phase 8B.2L Custom SQL Migration:
-- Resolves the two Phase 8B.2K findings without modifying historical 0000/0001 migrations:
-- 1. Hardens studexo.guard_users_lifecycle() and trg_users_lifecycle to cover INSERT
--    (blocking role escalation and dirty lifecycle fields on INSERT).
-- 2. Enforces stored_files purge_state = 'none' invariants in studexo.guard_stored_files_lifecycle()
--    and adds SECURITY DEFINER studexo.revert_stored_file_deletion_request(uuid, uuid) so
--    pending_purge -> none rollback atomically clears deleted_by_user_id and purge_requested_at.

-- ---------------------------------------------------------------------------
-- 1. Users lifecycle & purge guard (INSERT + UPDATE + DELETE)
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

  IF TG_OP = 'INSERT' THEN
    IF CURRENT_USER IN ('studexo_app', 'studexo_purge_worker', 'studexo_purge_owner', 'studexo_catalog_admin')
       AND NEW.role <> 'student' THEN
      RAISE EXCEPTION 'Role % may only insert student users (attempted role: %).', CURRENT_USER, NEW.role
        USING ERRCODE = '42501';
    END IF;

    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'New studexo.users row % must start with status = active (got: %).',
        NEW.id, NEW.status
        USING ERRCODE = '23514';
    END IF;

    IF NEW.purge_state <> 'none' THEN
      RAISE EXCEPTION 'New studexo.users row % must start with purge_state = none (got: %).',
        NEW.id, NEW.purge_state
        USING ERRCODE = '23514';
    END IF;

    IF NEW.deletion_requested_at IS NOT NULL OR NEW.deletion_scheduled_for IS NOT NULL THEN
      RAISE EXCEPTION 'New studexo.users row % cannot set deletion_requested_at or deletion_scheduled_for.',
        NEW.id
        USING ERRCODE = '23514';
    END IF;

    IF NEW.purge_lease_owner IS NOT NULL OR NEW.purge_lease_until IS NOT NULL THEN
      RAISE EXCEPTION 'New studexo.users row % cannot set purge_lease_owner or purge_lease_until.',
        NEW.id
        USING ERRCODE = '23514';
    END IF;

    IF NEW.purge_attempts <> 0 OR NEW.last_purge_error IS NOT NULL OR NEW.purged_at IS NOT NULL THEN
      RAISE EXCEPTION 'New studexo.users row % must start with purge_attempts = 0, last_purge_error = NULL, and purged_at = NULL.',
        NEW.id
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
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

DROP TRIGGER IF EXISTS trg_users_lifecycle ON studexo.users;
--> statement-breakpoint
CREATE TRIGGER trg_users_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON studexo.users
  FOR EACH ROW EXECUTE FUNCTION studexo.guard_users_lifecycle();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Stored files Storage-first lifecycle & rollback guard
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
  v_in_file_deletion_revert boolean := (
    CURRENT_USER = 'studexo_migrator'
    AND pg_catalog.current_setting('studexo.file_deletion_mode', true) = 'revert'
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

  IF NEW.purge_attempts < OLD.purge_attempts THEN
    RAISE EXCEPTION 'stored_files % purge_attempts cannot decrease (% -> %).',
      OLD.id, OLD.purge_attempts, NEW.purge_attempts
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
    ELSIF v_in_file_deletion_revert THEN
      IF NOT (
        OLD.deleted_by_user_id IS NOT NULL
        AND NEW.deleted_by_user_id IS NULL
        AND OLD.purge_state = 'pending_purge'
        AND NEW.purge_state = 'none'
        AND OLD.upload_status <> 'deleted'
        AND NEW.upload_status <> 'deleted'
        AND OLD.deleted_at IS NULL
        AND NEW.deleted_at IS NULL
        AND OLD.purged_at IS NULL
        AND NEW.purged_at IS NULL
        AND OLD.purge_lease_until IS NULL
        AND NEW.purge_lease_until IS NULL
        AND OLD.purge_attempts = 0
        AND NEW.purge_attempts = 0
        AND OLD.last_purge_error IS NULL
        AND NEW.last_purge_error IS NULL
      ) THEN
        RAISE EXCEPTION 'File deletion rollback may only clear deleted_by_user_id during an authorised pending_purge -> none revert before purge execution begins.'
          USING ERRCODE = '42501';
      END IF;
    ELSE
      RAISE EXCEPTION 'Only authorised deletion request, authorised deletion revert, or account_purge execution may modify stored_files.deleted_by_user_id.'
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
    ELSIF v_in_file_deletion_revert THEN
      IF NEW.upload_status IS DISTINCT FROM OLD.upload_status
         OR NEW.deleted_at IS NOT NULL
         OR OLD.purge_state <> 'pending_purge'
         OR NEW.purge_state <> 'none'
         OR NEW.purge_requested_at IS NOT NULL
         OR NEW.purge_lease_until IS NOT NULL
         OR NEW.purge_attempts <> 0
         OR NEW.last_purge_error IS NOT NULL
         OR NEW.purged_at IS NOT NULL THEN
        RAISE EXCEPTION 'File deletion rollback may only transition purge_state from pending_purge to none while clearing request metadata.'
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

  IF OLD.purge_state = 'purge_failed' AND NEW.purge_state IN ('none', 'pending_purge') THEN
    RAISE EXCEPTION 'Failed stored_files % cannot revert from purge_failed to %; retry via purging lease.',
      OLD.id, NEW.purge_state
      USING ERRCODE = '23514';
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

  IF OLD.purge_state <> 'none' AND NEW.purge_state = 'none' AND NOT v_in_file_deletion_revert THEN
    RAISE EXCEPTION 'Cannot revert stored_files % from % to none outside studexo.revert_stored_file_deletion_request().',
      OLD.id, OLD.purge_state
      USING ERRCODE = '23514';
  END IF;

  IF NEW.purge_state = 'none' THEN
    IF NEW.deleted_by_user_id IS NOT NULL
       OR NEW.purge_requested_at IS NOT NULL
       OR NEW.purge_lease_until IS NOT NULL
       OR NEW.deleted_at IS NOT NULL
       OR NEW.purged_at IS NOT NULL
       OR NEW.upload_status = 'deleted' THEN
      RAISE EXCEPTION 'stored_files % in purge_state = none must not retain deletion or purge metadata.',
        NEW.id
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
-- 3. Narrow Stored File Deletion Rollback Entry Point (Function 18 of 18, SECURITY DEFINER)
--    Owned by studexo_migrator; EXECUTE revoked from PUBLIC and granted solely
--    to studexo_purge_worker in docs/DATABASE_ROLES.md Step 7.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION studexo.revert_stored_file_deletion_request(
  p_file_id uuid,
  p_owner_user_id uuid
)
RETURNS studexo.stored_files
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, studexo
AS $$
DECLARE
  v_owner_purge_state studexo.purge_state;
  v_file studexo.stored_files%ROWTYPE;
BEGIN
  IF p_file_id IS NULL OR p_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'Both p_file_id and p_owner_user_id are required to revert stored_files deletion request.'
      USING ERRCODE = '22023';
  END IF;

  SELECT u.purge_state
    INTO v_owner_purge_state
    FROM studexo.users u
   WHERE u.id = p_owner_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Owner user % does not exist.', p_owner_user_id
      USING ERRCODE = '23503';
  END IF;

  IF v_owner_purge_state IN ('purging', 'purged') THEN
    RAISE EXCEPTION 'Cannot revert stored_files deletion request while owner % is in purge_state %.',
      p_owner_user_id, v_owner_purge_state
      USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_file
    FROM studexo.stored_files sf
   WHERE sf.id = p_file_id
     AND sf.owner_user_id = p_owner_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Owned stored_files row % does not exist for owner %.', p_file_id, p_owner_user_id
      USING ERRCODE = '22023';
  END IF;

  IF v_file.purge_state <> 'pending_purge' THEN
    RAISE EXCEPTION 'Cannot revert stored_files %: expected purge_state = pending_purge (got: %).',
      p_file_id, v_file.purge_state
      USING ERRCODE = '23514';
  END IF;

  IF v_file.upload_status = 'deleted'
     OR v_file.deleted_at IS NOT NULL
     OR v_file.purged_at IS NOT NULL
     OR v_file.purge_lease_until IS NOT NULL
     OR v_file.purge_attempts <> 0
     OR v_file.last_purge_error IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot revert stored_files % to none after purge execution or lease acquisition has started.',
      p_file_id
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.set_config('studexo.file_deletion_mode', 'revert', true);

  UPDATE studexo.stored_files
     SET deleted_by_user_id = NULL,
         purge_state = 'none',
         purge_requested_at = NULL
   WHERE id = p_file_id
     AND owner_user_id = p_owner_user_id
  RETURNING * INTO v_file;

  PERFORM pg_catalog.set_config('studexo.file_deletion_mode', '', true);

  RETURN v_file;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION studexo.revert_stored_file_deletion_request(uuid, uuid) FROM PUBLIC;
