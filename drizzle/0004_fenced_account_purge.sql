-- ---------------------------------------------------------------------------
-- Migration 0004: Fenced Account Purge RPC
-- Replaces unfenced studexo.execute_account_purge(uuid) with a fenced 3-argument
-- function enforcing strict lease ownership, attempt count, purge_state = 'purging',
-- and unexpired lease timestamp checks inside the atomic transaction.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS studexo.execute_account_purge(uuid);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION studexo.execute_account_purge(
  p_user_id uuid,
  p_expected_lease_owner varchar,
  p_expected_purge_attempts integer
)
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

  IF v_user.purge_state <> 'purging' THEN
    RAISE EXCEPTION 'User % purge_state must be purging (got: %).', p_user_id, v_user.purge_state
      USING ERRCODE = '23514';
  END IF;

  IF v_user.purge_lease_owner IS DISTINCT FROM p_expected_lease_owner THEN
    RAISE EXCEPTION 'Account purge lease owner mismatch for user % (expected: %, actual: %).',
      p_user_id, p_expected_lease_owner, v_user.purge_lease_owner
      USING ERRCODE = '23514';
  END IF;

  IF v_user.purge_attempts <> p_expected_purge_attempts THEN
    RAISE EXCEPTION 'Account purge attempt count mismatch for user % (expected: %, actual: %).',
      p_user_id, p_expected_purge_attempts, v_user.purge_attempts
      USING ERRCODE = '23514';
  END IF;

  IF v_user.purge_lease_until IS NULL OR pg_catalog.now() > v_user.purge_lease_until THEN
    RAISE EXCEPTION 'Account purge lease expired for user % (lease_until: %, now: %).',
      p_user_id, v_user.purge_lease_until, pg_catalog.now()
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

ALTER FUNCTION studexo.execute_account_purge(uuid, varchar, integer) OWNER TO studexo_purge_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION studexo.execute_account_purge(uuid, varchar, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION studexo.execute_account_purge(uuid, varchar, integer) TO studexo_purge_worker;
