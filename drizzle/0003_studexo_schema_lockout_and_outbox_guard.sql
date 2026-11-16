-- Studexo Phase 8B.3B Custom SQL Migration:
-- 1. Adds narrow SECURITY DEFINER guard studexo.is_auth_user_pending_purge(uuid)
--    so studexo_app and trigger guards can block re-registration of identities with
--    pending_deletion users or unpurged external_identity_purge_outbox rows without
--    exposing direct SELECT/INSERT/UPDATE/DELETE privileges on the outbox table.
-- 2. Updates studexo.guard_users_lifecycle() to enforce outbox/pending-deletion
--    re-registration protection transactionally on INSERT and identity re-binding.
-- 3. Locks down schema studexo (USAGE/CREATE, tables, sequences, functions, and
--    default privileges) against PUBLIC as well as Supabase PostgREST roles
--    (anon, authenticated, service_role) when present in pg_roles.

-- ---------------------------------------------------------------------------
-- 1. Narrow Outbox Re-Registration Check (Function 19 of 19, SECURITY DEFINER)
--    Owned by studexo_migrator; EXECUTE revoked from PUBLIC and granted solely
--    to studexo_app in docs/DATABASE_ROLES.md Step 6.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION studexo.is_auth_user_pending_purge(
  p_supabase_auth_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, studexo
AS $$
DECLARE
  v_pending boolean := false;
BEGIN
  IF p_supabase_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'p_supabase_auth_user_id is required to verify external identity purge status.'
      USING ERRCODE = '22023';
  END IF;

  SELECT (
    EXISTS (
      SELECT 1
        FROM studexo.external_identity_purge_outbox o
       WHERE o.supabase_auth_user_id = p_supabase_auth_user_id
         AND o.status <> 'purged'
    )
    OR EXISTS (
      SELECT 1
        FROM studexo.users u
       WHERE u.supabase_auth_user_id = p_supabase_auth_user_id
         AND u.status = 'pending_deletion'
    )
  )
  INTO v_pending;

  RETURN v_pending;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION studexo.is_auth_user_pending_purge(uuid) FROM PUBLIC;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Harden Users Lifecycle Guard With Outbox Re-Registration Protection
--    Preserves all Phase 8B.2L role, status, and purge invariants while
--    transactionally blocking INSERT/rebind for identities with active deletion
--    or unpurged external_identity_purge_outbox records.
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

    IF NEW.supabase_auth_user_id IS NOT NULL THEN
      IF studexo.is_auth_user_pending_purge(NEW.supabase_auth_user_id) THEN
        RAISE EXCEPTION 'External auth identity % has an active or unpurged deletion in progress; registration is blocked until external identity purge completes.',
          NEW.supabase_auth_user_id
          USING ERRCODE = '23514';
      END IF;
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

  IF NEW.supabase_auth_user_id IS NOT NULL
     AND NEW.supabase_auth_user_id IS DISTINCT FROM OLD.supabase_auth_user_id THEN
    IF studexo.is_auth_user_pending_purge(NEW.supabase_auth_user_id) THEN
      RAISE EXCEPTION 'External auth identity % has an active or unpurged deletion in progress; binding is blocked until external identity purge completes.',
        NEW.supabase_auth_user_id
        USING ERRCODE = '23514';
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

-- ---------------------------------------------------------------------------
-- 3. Schema studexo Lockout Against PUBLIC and Supabase PostgREST Roles
-- ---------------------------------------------------------------------------
REVOKE ALL ON SCHEMA studexo FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA studexo FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA studexo FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  v_role text;
  v_fn record;
BEGIN
  -- Revoke implicit PUBLIC EXECUTE from all functions in schema studexo owned by CURRENT_USER
  -- (skips execute_account_purge cleanly if Step 4 already transferred it to studexo_purge_owner).
  FOR v_fn IN
    SELECT p.oid::regprocedure AS fn_sig
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
     WHERE n.nspname = 'studexo'
       AND r.rolname = CURRENT_USER
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn.fn_sig);
  END LOOP;

  -- Prevent future objects created by CURRENT_USER (studexo_migrator) from inheriting PUBLIC access.
  EXECUTE pg_catalog.format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA studexo REVOKE ALL ON TABLES FROM PUBLIC',
    CURRENT_USER
  );
  EXECUTE pg_catalog.format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA studexo REVOKE ALL ON SEQUENCES FROM PUBLIC',
    CURRENT_USER
  );
  EXECUTE pg_catalog.format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA studexo REVOKE ALL ON FUNCTIONS FROM PUBLIC',
    CURRENT_USER
  );
  EXECUTE pg_catalog.format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA studexo REVOKE ALL ON TYPES FROM PUBLIC',
    CURRENT_USER
  );

  -- On Supabase (or test clusters defining PostgREST roles), revoke all current & future access
  -- from anon, authenticated, and service_role cleanly without failing on vanilla PostgreSQL.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role) THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON SCHEMA studexo FROM %I', v_role);
      EXECUTE pg_catalog.format('REVOKE ALL ON ALL TABLES IN SCHEMA studexo FROM %I', v_role);
      EXECUTE pg_catalog.format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA studexo FROM %I', v_role);

      FOR v_fn IN
        SELECT p.oid::regprocedure AS fn_sig
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
         WHERE n.nspname = 'studexo'
           AND r.rolname = CURRENT_USER
      LOOP
        EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I', v_fn.fn_sig, v_role);
      END LOOP;

      EXECUTE pg_catalog.format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA studexo REVOKE ALL ON TABLES FROM %I',
        CURRENT_USER, v_role
      );
      EXECUTE pg_catalog.format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA studexo REVOKE ALL ON SEQUENCES FROM %I',
        CURRENT_USER, v_role
      );
      EXECUTE pg_catalog.format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA studexo REVOKE ALL ON FUNCTIONS FROM %I',
        CURRENT_USER, v_role
      );
      EXECUTE pg_catalog.format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA studexo REVOKE ALL ON TYPES FROM %I',
        CURRENT_USER, v_role
      );
    END IF;
  END LOOP;
END;
$$;
