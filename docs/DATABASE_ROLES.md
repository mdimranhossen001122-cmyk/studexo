# Studexo PostgreSQL Role Model & Operations Handoff

This document defines the least-privilege PostgreSQL role architecture and operations-admin bootstrap/handoff procedure for deploying the `studexo` database foundation (`0000_init_studexo_mvp.sql`, `0001_studexo_integrity_triggers_and_extensions.sql`, `0002_studexo_user_insert_and_file_rollback_guards.sql`, and `0003_studexo_schema_lockout_and_outbox_guard.sql`).

**Important:** No credentials, passwords, live connection strings, or roles are provisioned in this repository. Never place role creation (`CREATE ROLE`) or cross-role ownership transfer (`ALTER FUNCTION ... OWNER TO studexo_purge_owner`) inside Drizzle migrations run by `studexo_migrator`.

---

## 1. Least-Privilege Role Model

| Role | Login? | Intended Consumer | Privileges Summary |
|---|---|---|---|
| `studexo_migrator` | `LOGIN` | Offline CI / Authorised Migration Runner (`DIRECT_DATABASE_URL`) | Owns schema `studexo` and dedicated migration tracking schema `drizzle`, plus all `studexo` tables/enums/sequences/functions except `execute_account_purge(uuid)` (also owns `SECURITY DEFINER` `request_stored_file_deletion(uuid, uuid)`, `revert_stored_file_deletion_request(uuid, uuid)`, and `is_auth_user_pending_purge(uuid)`). No `SUPERUSER`, `CREATEDB`, or `CREATEROLE`. |
| `studexo_purge_owner` | `NOLOGIN` | Owner of `SECURITY DEFINER` `studexo.execute_account_purge(uuid)` | Holds scoped `DELETE` on `studexo.users`, `studexo.stored_files`, `studexo.documents`, `studexo.application_documents`, dependent user tables, `UPDATE (verified_by_user_id)` on `studexo.verification_claims`, `UPDATE (deleted_by_user_id)` on `studexo.stored_files`, and `INSERT` on `studexo.external_identity_purge_outbox`. Triggers check `CURRENT_USER = 'studexo_purge_owner'` + `studexo.purge_mode = 'account_purge'`. |
| `studexo_app` | `LOGIN` | Runtime API server (`DATABASE_URL`) | `USAGE` on `studexo`. Column-restricted `INSERT` on `studexo.users` (`id`, `supabase_auth_user_id`, `primary_email`, `display_name` only — always starts `'student'`, `'active'`, `'none'`, blocked when `is_auth_user_pending_purge(supabase_auth_user_id)` is true) and column-restricted `UPDATE` on `studexo.users` (profile + grace-request columns only — **no** `role`, `supabase_auth_user_id`, `purge_state`, `purge_lease_*`, `purged_at`, or `DELETE`), column-restricted `UPDATE` on `studexo.stored_files` (upload completion metadata only — **no** direct `UPDATE` on `deleted_by_user_id`, purge columns, or `DELETE`), `EXECUTE` on `studexo.request_stored_file_deletion(uuid, uuid)` for Stage 1 deletion requests (`none -> pending_purge`), and `EXECUTE` on `studexo.is_auth_user_pending_purge(uuid)` for boolean external purge checks. Read-only `SELECT` on reference, catalog, provenance/verification, `ai_prompt_versions`, and `ai_permissions` tables. Privilege-based append-only `SELECT, INSERT` on `user_consents` and `application_status_history`. Zero privileges on `external_identity_purge_outbox` or schema `drizzle`. Never `EXECUTE` on `execute_account_purge(uuid)` or `revert_stored_file_deletion_request(uuid, uuid)`. |
| `studexo_purge_worker` | `LOGIN` | Dedicated Account-Purge & File-Purge Worker (`WORKER_DATABASE_URL`, isolated from API env/pool) | Column-scoped `SELECT` / `UPDATE` on `studexo.users` (including `purge_lease_owner`, `purge_lease_until`) and `studexo.stored_files` (**no** `deleted_by_user_id`), column-scoped `SELECT` on `studexo.document_versions`, `SELECT` + column-scoped `UPDATE` on `studexo.external_identity_purge_outbox` (**no** `INSERT` or `DELETE` on `users`, `stored_files`, or `external_identity_purge_outbox`), zero privileges on schema `drizzle`, and `EXECUTE` on `studexo.execute_account_purge(uuid)` plus `studexo.revert_stored_file_deletion_request(uuid, uuid)`. Runs Stage 2 Storage-first file deletions and `pending_purge -> none` reference-blocked rollbacks asynchronously. |
| `studexo_catalog_admin` | `NOLOGIN` *(deferred)* | Future Backoffice / Verification & Catalog Pipeline (`CATALOG_ADMIN_DATABASE_URL` deferred until catalog runtime phase) | Dedicated non-runtime role (`NOLOGIN NOINHERIT`, zero staging credentials issued) scoped for mutating curated catalog entities, `sources`, `verification_claims`, `verification_evidence` (`SELECT, INSERT`), `ai_prompt_versions`, and `ai_permissions`. Zero privileges on schema `drizzle`. Kept strictly separate from `studexo_app`, `studexo_purge_worker`, and `studexo_purge_owner`. |

---

## 2. Hosted Supabase Non-Superuser Administrator & Ownership Rules

1. **Supabase `postgres` Is Not a True `SUPERUSER`:** On hosted Supabase, the internal `supabase_admin` superuser is reserved by the platform. Operations administrators connect as `postgres`, which holds `CREATEROLE`, `INHERIT`, and platform helper memberships rather than `rolsuper = true`.
2. **Why Role Membership Is Required:** A true PostgreSQL superuser bypasses role-membership checks on `CREATE SCHEMA ... AUTHORIZATION <role>`, `ALTER FUNCTION ... OWNER TO <role>`, `ALTER DEFAULT PRIVILEGES FOR ROLE <role>`, and `GRANT/REVOKE` across objects owned by another role. Because hosted Supabase `postgres` is a **non-superuser**, PostgreSQL enforces role membership checks whenever `postgres` delegates schema ownership (`studexo`, `drizzle`), transfers function ownership (`execute_account_purge(uuid)` -> `studexo_purge_owner`), grants privileges across `studexo.*` objects owned by `studexo_migrator` (Steps 5–8), or sets `ALTER DEFAULT PRIVILEGES FOR ROLE ...`.
3. **PostgreSQL 15 vs. PostgreSQL 16+ Membership Semantics:**
   - **PostgreSQL 15:** `CREATE ROLE` by a `CREATEROLE` administrator does **not** automatically grant membership in the new role to the creator. Execute `GRANT studexo_migrator TO postgres;` and `GRANT studexo_purge_owner TO postgres;` (requiring standard `postgres` `INHERIT` role attribute). PostgreSQL 15 does **not** support `WITH SET ...` / `WITH INHERIT ...` clause syntax on `GRANT`.
   - **PostgreSQL 16+:** `CREATEROLE` changes grant automatic `ADMIN OPTION` to the creator **without** `SET` or `INHERIT` options (`SET FALSE`, `INHERIT FALSE` by default). Delegating schema ownership (`AUTHORIZATION`), running `ALTER DEFAULT PRIVILEGES FOR ROLE ...`, and transferring function ownership (`OWNER TO`) require `SET TRUE`, while executing `ALTER FUNCTION` + Steps 5–8 `GRANT/REVOKE` on `studexo_migrator`-owned objects without `SUPERUSER` requires `INHERIT TRUE` on `studexo_migrator`. Execute `GRANT studexo_migrator TO postgres WITH SET TRUE, INHERIT TRUE;` and `GRANT studexo_purge_owner TO postgres WITH SET TRUE, INHERIT FALSE;` (`INHERIT FALSE` prevents `postgres` from implicitly inheriting `studexo_purge_owner` privileges).
4. **Why Ownership Transfer Lives Outside `0001` & Never Grants Membership to App/Worker/Migrator:**
   - `db:migrate` connects as `studexo_migrator`. Granting `studexo_purge_owner` membership to `studexo_migrator`, `studexo_app`, `studexo_purge_worker`, or `studexo_catalog_admin` would permit `SET ROLE studexo_purge_owner; SET LOCAL studexo.purge_mode = 'account_purge';`, bypassing trigger guards to arbitrarily `DELETE` `users` and `stored_files`.
   - Instead, `postgres` holds **minimum temporary membership**: `studexo_purge_owner` only across Steps 1–4 (revoked immediately at the end of Step 4 before Step 5 grants purge table privileges) and `studexo_migrator` only across Steps 1–8 (revoked immediately at the end of Step 8 once Steps 5–8 role grants complete).

---

## 3. Non-Secret Bootstrap & Operations-Admin Handoff

### Step 1 — Pre-Migration Role Bootstrap, Tracking Schema & Temp Membership (Operations Admin, Before `0000`/`0001`)

Generate unique, high-entropy passwords per `LOGIN` role (`studexo_migrator`, `studexo_app`, `studexo_purge_worker`) inside your secret manager before running Step 1, and enforce `scram-sha-256`. **Never** commit passwords or issue credentials for `NOLOGIN` roles (`studexo_purge_owner`, `studexo_catalog_admin`).

```sql
-- Execute as PostgreSQL admin (e.g. hosted Supabase `postgres`).
SET password_encryption = 'scram-sha-256';

CREATE ROLE studexo_purge_owner NOLOGIN NOINHERIT;
CREATE ROLE studexo_migrator LOGIN NOINHERIT PASSWORD '<SECRET_MANAGER_MIGRATOR_PASSWORD>';
CREATE ROLE studexo_app LOGIN NOINHERIT PASSWORD '<SECRET_MANAGER_APP_PASSWORD>';
CREATE ROLE studexo_purge_worker LOGIN NOINHERIT PASSWORD '<SECRET_MANAGER_WORKER_PASSWORD>';
CREATE ROLE studexo_catalog_admin NOLOGIN NOINHERIT;

-- Hosted Supabase non-superuser membership prerequisites (no-op if CURRENT_USER is true SUPERUSER).
-- Requires CURRENT_USER (e.g. `postgres`) to hold CREATEROLE and INHERIT attributes.
DO $$
DECLARE
  v_is_superuser boolean;
  v_has_inherit boolean;
  v_pg_major integer := current_setting('server_version_num')::int / 10000;
BEGIN
  SELECT r.rolsuper, r.rolinherit INTO v_is_superuser, v_has_inherit
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = CURRENT_USER;

  IF NOT v_is_superuser THEN
    IF NOT v_has_inherit THEN
      RAISE EXCEPTION 'Non-superuser admin role % must have INHERIT attribute to inherit studexo_migrator during Steps 1-8.', CURRENT_USER;
    END IF;

    IF v_pg_major >= 16 THEN
      EXECUTE format('GRANT studexo_migrator TO %I WITH SET TRUE, INHERIT TRUE', CURRENT_USER);
      EXECUTE format('GRANT studexo_purge_owner TO %I WITH SET TRUE, INHERIT FALSE', CURRENT_USER);
    ELSE
      EXECUTE format('GRANT studexo_migrator TO %I', CURRENT_USER);
      EXECUTE format('GRANT studexo_purge_owner TO %I', CURRENT_USER);
    END IF;
  END IF;
END $$;

REVOKE ALL ON SCHEMA public FROM studexo_migrator, studexo_app, studexo_purge_worker, studexo_purge_owner, studexo_catalog_admin;

-- Primary application schema (owned by studexo_migrator)
CREATE SCHEMA IF NOT EXISTS studexo AUTHORIZATION studexo_migrator;
REVOKE ALL ON SCHEMA studexo FROM PUBLIC;

-- Dedicated Drizzle migration tracking schema (owned by studexo_migrator; isolated from studexo and PostgREST)
CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION studexo_migrator;
REVOKE ALL ON SCHEMA drizzle FROM PUBLIC;
REVOKE ALL ON SCHEMA drizzle FROM studexo_app, studexo_purge_worker, studexo_purge_owner, studexo_catalog_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE studexo_migrator IN SCHEMA drizzle REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE studexo_migrator IN SCHEMA drizzle REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE studexo_migrator IN SCHEMA drizzle REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE studexo_migrator IN SCHEMA drizzle REVOKE ALL ON TYPES FROM PUBLIC;

DO $$
DECLARE v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA drizzle FROM %I', v_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE studexo_migrator IN SCHEMA drizzle REVOKE ALL ON TABLES FROM %I', v_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE studexo_migrator IN SCHEMA drizzle REVOKE ALL ON SEQUENCES FROM %I', v_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE studexo_migrator IN SCHEMA drizzle REVOKE ALL ON FUNCTIONS FROM %I', v_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE studexo_migrator IN SCHEMA drizzle REVOKE ALL ON TYPES FROM %I', v_role);
    END IF;
  END LOOP;
END $$;
```

### Step 2 — Required Extension Pre-Provisioning (Operations Admin, Required Before `0001`)

`pg_trgm` is a **required capability** for `0001_studexo_integrity_triggers_and_extensions.sql` (which creates all 4 GIN trigram indexes on `institutions`, `institution_aliases`, `programmes`, and `scholarships`, and raises SQLSTATE `0A000` if `pg_trgm` is missing and cannot be created by `studexo_migrator`). Note that Supabase pre-creates the `extensions` schema, whereas stock PostgreSQL 15 requires creating it explicitly first.

```sql
-- Execute as operations admin when studexo_migrator lacks extension-creation privilege (standard on Supabase & stock PG 15):
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO studexo_migrator, studexo_app, studexo_purge_worker, studexo_catalog_admin;
```

### Step 3 — Execute Schema & Trigger Migrations (`studexo_migrator` via Authorised `db:migrate`)

Run `0000_init_studexo_mvp.sql`, `0001_studexo_integrity_triggers_and_extensions.sql`, `0002_studexo_user_insert_and_file_rollback_guards.sql`, and `0003_studexo_schema_lockout_and_outbox_guard.sql` via the dedicated TLS-verified migration runner:

```bash
DIRECT_DATABASE_URL="<migrator-direct-or-session-uri>" \
DB_SSL_ROOT_CERT="<pem-if-custom-ca>" \
NODE_ENV=production \
bun run db:migrate
```

*(or `npm run db:migrate` in Node environments).* **Why `db:migrate` (`src/server/db/migrate.ts`) is required instead of `drizzle-kit migrate`:**
1. Installed `drizzle-kit@0.31.11` + `drizzle-orm@0.45.4` `PgDialect.migrate()` unconditionally runs `CREATE SCHEMA IF NOT EXISTS "drizzle"`, which fails in PostgreSQL 15 with SQLSTATE `42501` (`permission denied for database`) when `studexo_migrator` intentionally lacks `CREATE ON DATABASE` — even when `drizzle` already exists. `src/server/db/migrate.ts` verifies that Step 1 pre-created `drizzle` owned by `studexo_migrator` without executing `CREATE SCHEMA`, then applies unapplied migrations transactionally into `drizzle.__drizzle_migrations`.
2. `drizzle-kit@0.31.11` ignores `DB_SSL_ROOT_CERT` and does not enforce `resolvePostgresTlsConfig()` when invoked with a connection URL. `src/server/db/migrate.ts` uses `parseMigrationEnv()` + `resolvePostgresTlsConfig()` for exact TLS parity (`verify-full` / `{ rejectUnauthorized: true, ca }`, `prepare: false`, `max: 1`).
3. Never invoke `db:migrate` automatically during API or worker startup.

### Step 4 — Lock Down Purge Function ACLs, Grant Worker Execution, Transfer Ownership & Revoke `studexo_purge_owner` Membership (Operations Admin)

Note: `0001_studexo_integrity_triggers_and_extensions.sql` already executes `REVOKE ALL ON FUNCTION studexo.execute_account_purge(uuid) FROM PUBLIC;` immediately upon creating the function and `0003_studexo_schema_lockout_and_outbox_guard.sql` locks out `PUBLIC`, `anon`, `authenticated`, and `service_role` on `studexo` objects owned by `studexo_migrator`. Because hosted Supabase `postgres` is a non-superuser, Step 1 temporarily granted `studexo_migrator` (`SET TRUE, INHERIT TRUE` on PG 16+) and `studexo_purge_owner` (`SET TRUE, INHERIT FALSE` on PG 16+) to `CURRENT_USER` (`postgres`). Execute function ACL scoping while `studexo_migrator` owns `execute_account_purge(uuid)`, transfer ownership to `studexo_purge_owner`, lock down `studexo_purge_owner` default function privileges, and **immediately revoke `studexo_purge_owner` membership before Step 5** (retaining `studexo_migrator` temporary membership solely through Step 8 so Steps 5–8 can grant `studexo.*` privileges):

```sql
-- Prerequisite check: ensure CURRENT_USER is superuser or holds temporary Step 1 memberships.
-- Apply function ACL scoping while studexo_migrator owns the function, then transfer ownership:
REVOKE ALL ON FUNCTION studexo.execute_account_purge(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION studexo.execute_account_purge(uuid) TO studexo_purge_worker;

DO $$
DECLARE
  v_role text;
  v_is_superuser boolean;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION studexo.execute_account_purge(uuid) FROM %I', v_role);
    END IF;
  END LOOP;

  -- Non-superuser ALTER FUNCTION ... OWNER TO requires the target owner to hold CREATE on schema studexo during transfer.
  GRANT USAGE, CREATE ON SCHEMA studexo TO studexo_purge_owner;
  ALTER FUNCTION studexo.execute_account_purge(uuid) OWNER TO studexo_purge_owner;
  REVOKE CREATE ON SCHEMA studexo FROM studexo_purge_owner;

  ALTER DEFAULT PRIVILEGES FOR ROLE studexo_purge_owner IN SCHEMA studexo REVOKE ALL ON FUNCTIONS FROM PUBLIC;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE studexo_purge_owner IN SCHEMA studexo REVOKE ALL ON FUNCTIONS FROM %I', v_role);
    END IF;
  END LOOP;

  -- Immediately revoke temporary studexo_purge_owner membership before Step 5 grants purge privileges:
  SELECT r.rolsuper INTO v_is_superuser
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = CURRENT_USER;

  IF NOT v_is_superuser THEN
    EXECUTE format('REVOKE studexo_purge_owner FROM %I', CURRENT_USER);
  END IF;
END $$;
```

### Step 5 — Grant Scoped Owner Privileges to `studexo_purge_owner` (Operations Admin)

```sql
GRANT USAGE ON SCHEMA studexo TO studexo_purge_owner;
GRANT SELECT, UPDATE, DELETE ON studexo.users TO studexo_purge_owner;
-- Narrow UPDATE (deleted_by_user_id) lets execute_account_purge clear cross-user deleter references before user deletion.
GRANT SELECT, UPDATE (deleted_by_user_id), DELETE ON studexo.stored_files TO studexo_purge_owner;
GRANT SELECT, DELETE ON studexo.documents, studexo.application_documents TO studexo_purge_owner;
GRANT SELECT, UPDATE, DELETE ON
  studexo.auth_identities,
  studexo.account_settings,
  studexo.user_consents,
  studexo.student_profiles,
  studexo.student_qualifications,
  studexo.student_test_scores,
  studexo.student_experiences,
  studexo.student_publications_and_projects,
  studexo.document_versions,
  studexo.saved_opportunities,
  studexo.university_applications,
  studexo.scholarship_applications,
  studexo.application_checklists,
  studexo.application_notes,
  studexo.application_status_history,
  studexo.planner_tasks,
  studexo.planner_events,
  studexo.notification_preferences,
  studexo.notification_deliveries,
  studexo.ai_permissions,
  studexo.ai_conversations,
  studexo.ai_messages,
  studexo.ai_runs,
  studexo.ai_usage_records,
  studexo.ai_run_context_links
TO studexo_purge_owner;
-- verification_claims explicit anonymisation clears verified_by_user_id before user deletion;
-- narrow account_purge exception in guard_verification_claims_supersession() requires CURRENT_USER = 'studexo_purge_owner'
-- and permits NULLing ONLY verified_by_user_id while the referenced user is in pending_deletion / purging state.
GRANT SELECT, UPDATE (verified_by_user_id) ON studexo.verification_claims TO studexo_purge_owner;
GRANT INSERT, SELECT ON studexo.external_identity_purge_outbox TO studexo_purge_owner;
GRANT EXECUTE ON FUNCTION studexo.is_auth_user_pending_purge(uuid) TO studexo_purge_owner;
```

### Step 6 — Grant Runtime Privileges to `studexo_app` (Operations Admin)

```sql
REVOKE CREATE ON SCHEMA studexo FROM PUBLIC, studexo_app, studexo_purge_worker, studexo_purge_owner, studexo_catalog_admin;
GRANT USAGE ON SCHEMA studexo TO studexo_app;

-- Reference, curated catalog, verification provenance, and AI governance tables: READ-ONLY for studexo_app
GRANT SELECT ON
  studexo.grading_scales,
  studexo.test_catalog,
  studexo.institutions,
  studexo.institution_aliases,
  studexo.programmes,
  studexo.programme_intakes,
  studexo.programme_fees,
  studexo.programme_requirements,
  studexo.scholarships,
  studexo.scholarship_intakes,
  studexo.scholarship_programmes,
  studexo.scholarship_eligibility_rules,
  studexo.scholarship_funding_components,
  studexo.sources,
  studexo.verification_claims,
  studexo.verification_evidence,
  studexo.ai_prompt_versions,
  studexo.ai_permissions
TO studexo_app;

-- Users: allow column-scoped INSERT for normal student registration only and non-privileged profile / deletion-grace UPDATE columns.
-- NO INSERT or UPDATE on role, purge_state, purge_attempts, purge_lease_*, last_purge_error, or purged_at; NO DELETE.
-- guard_users_lifecycle() enforces clean initial state on INSERT and manages purge_state on active deletion requests/cancellations.
-- Administrative or counselor user provisioning must use a privileged operations/admin role, never studexo_app.
REVOKE ALL ON studexo.users FROM PUBLIC;
REVOKE INSERT ON studexo.users FROM studexo_app;
GRANT SELECT ON studexo.users TO studexo_app;
GRANT INSERT (
  id,
  supabase_auth_user_id,
  primary_email,
  display_name
) ON studexo.users TO studexo_app;
GRANT UPDATE (
  primary_email,
  display_name,
  status,
  deletion_requested_at,
  deletion_scheduled_for,
  updated_at
) ON studexo.users TO studexo_app;

-- Stored files: allow INSERT (pending/uploaded) and upload completion column UPDATE only.
-- NO direct UPDATE on purge_state, deleted_at, deleted_by_user_id, purge_*, or purged_at; NO DELETE.
-- Authenticated file deletion requests invoke studexo.request_stored_file_deletion(uuid, uuid)
-- to attribute deleted_by_user_id and transition none -> pending_purge atomically.
GRANT SELECT, INSERT ON studexo.stored_files TO studexo_app;
GRANT UPDATE (
  original_filename,
  mime_type,
  byte_size,
  sha256_checksum,
  upload_status,
  uploaded_at,
  updated_at
) ON studexo.stored_files TO studexo_app;
GRANT EXECUTE ON FUNCTION studexo.request_stored_file_deletion(uuid, uuid) TO studexo_app;

-- Outbox re-registration protection: boolean-only SECURITY DEFINER check (zero direct table access)
GRANT EXECUTE ON FUNCTION studexo.is_auth_user_pending_purge(uuid) TO studexo_app;

-- Append-only ledgers for runtime: privilege-based SELECT + INSERT only for studexo_app
-- (no trigger on user_consents or application_status_history; studexo_migrator, studexo_purge_owner, and CASCADE purges can delete).
GRANT SELECT, INSERT ON
  studexo.user_consents,
  studexo.application_status_history
TO studexo_app;

-- Standard mutable user / application / AI execution tables
GRANT SELECT, INSERT, UPDATE, DELETE ON
  studexo.auth_identities,
  studexo.account_settings,
  studexo.student_profiles,
  studexo.student_qualifications,
  studexo.student_test_scores,
  studexo.student_experiences,
  studexo.student_publications_and_projects,
  studexo.documents,
  studexo.document_versions,
  studexo.saved_opportunities,
  studexo.university_applications,
  studexo.scholarship_applications,
  studexo.application_documents,
  studexo.application_checklists,
  studexo.application_notes,
  studexo.planner_tasks,
  studexo.planner_events,
  studexo.notification_preferences,
  studexo.notification_deliveries,
  studexo.ai_conversations,
  studexo.ai_messages,
  studexo.ai_runs,
  studexo.ai_usage_records,
  studexo.ai_run_context_links
TO studexo_app;

-- Explicitly ensure zero access on external_identity_purge_outbox for studexo_app
REVOKE ALL ON studexo.external_identity_purge_outbox FROM studexo_app;
```

### Step 7 — Grant Worker Privileges to `studexo_purge_worker` (Operations Admin)

```sql
GRANT USAGE ON SCHEMA studexo TO studexo_purge_worker;

-- Column-scoped SELECT & UPDATE on studexo.users (no email/profile columns beyond purge orchestration & leasing; no INSERT/DELETE)
GRANT SELECT (
  id,
  supabase_auth_user_id,
  status,
  deletion_requested_at,
  deletion_scheduled_for,
  purge_state,
  purge_lease_owner,
  purge_lease_until,
  purge_attempts,
  purged_at
) ON studexo.users TO studexo_purge_worker;
GRANT UPDATE (
  purge_state,
  purge_lease_owner,
  purge_lease_until,
  purge_attempts,
  last_purge_error,
  purged_at,
  updated_at
) ON studexo.users TO studexo_purge_worker;

-- Column-scoped SELECT & UPDATE on studexo.stored_files (no DELETE, no UPDATE on deleted_by_user_id)
GRANT SELECT (
  id,
  owner_user_id,
  storage_bucket,
  object_key,
  upload_status,
  deleted_at,
  deleted_by_user_id,
  purge_state,
  purge_requested_at,
  purge_lease_until,
  purge_attempts,
  last_purge_error,
  purged_at
) ON studexo.stored_files TO studexo_purge_worker;
GRANT UPDATE (
  upload_status,
  deleted_at,
  purge_state,
  purge_requested_at,
  purge_lease_until,
  purge_attempts,
  last_purge_error,
  purged_at,
  updated_at
) ON studexo.stored_files TO studexo_purge_worker;

-- Column-scoped SELECT on studexo.document_versions for reference checks prior to purge lease
GRANT SELECT (id, stored_file_id, user_id) ON studexo.document_versions TO studexo_purge_worker;

-- Outbox: SELECT + column-scoped UPDATE only (outbox rows are inserted solely inside execute_account_purge)
GRANT SELECT ON studexo.external_identity_purge_outbox TO studexo_purge_worker;
GRANT UPDATE (
  status,
  attempt_count,
  next_attempt_at,
  lease_owner,
  locked_until,
  last_error_code,
  last_error_message,
  completed_at,
  updated_at
) ON studexo.external_identity_purge_outbox TO studexo_purge_worker;

-- EXECUTE on studexo.execute_account_purge(uuid) was already granted to studexo_purge_worker in Step 4 before transferring ownership to studexo_purge_owner and revoking temporary membership.
GRANT EXECUTE ON FUNCTION studexo.revert_stored_file_deletion_request(uuid, uuid) TO studexo_purge_worker;
GRANT EXECUTE ON FUNCTION studexo.is_auth_user_pending_purge(uuid) TO studexo_purge_worker;
```

### Step 8 — Grant Catalog / Verification / AI Governance Privileges to `studexo_catalog_admin` (Operations Admin)

`studexo_catalog_admin` is kept outside Drizzle migrations and cleanly isolated from user runtime traffic:

```sql
GRANT USAGE ON SCHEMA studexo TO studexo_catalog_admin;
GRANT SELECT ON studexo.users, studexo.grading_scales, studexo.test_catalog TO studexo_catalog_admin;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  studexo.institutions,
  studexo.institution_aliases,
  studexo.programmes,
  studexo.programme_intakes,
  studexo.programme_fees,
  studexo.programme_requirements,
  studexo.scholarships,
  studexo.scholarship_intakes,
  studexo.scholarship_programmes,
  studexo.scholarship_eligibility_rules,
  studexo.scholarship_funding_components,
  studexo.sources,
  studexo.verification_claims,
  studexo.ai_prompt_versions,
  studexo.ai_permissions
TO studexo_catalog_admin;

-- Append-only ledger: SELECT + INSERT only (never UPDATE or DELETE)
GRANT SELECT, INSERT ON studexo.verification_evidence TO studexo_catalog_admin;

-- Revoke temporary studexo_migrator membership from non-superuser admin once Steps 5-8 grants finish:
DO $$
DECLARE
  v_is_superuser boolean;
BEGIN
  SELECT r.rolsuper INTO v_is_superuser
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = CURRENT_USER;

  IF NOT v_is_superuser THEN
    EXECUTE format('REVOKE studexo_migrator FROM %I', CURRENT_USER);
  END IF;
END $$;
```

Note: Because `university_applications_intake_prog_fk` and `scholarship_applications_intake_sch_fk` enforce `ON DELETE RESTRICT`, catalog deletion of an in-use `programme_intakes` or `scholarship_intakes` row fails cleanly without requiring elevated `UPDATE` privileges on student application tables.

### Step 9 — Seed Initial Reference Lookup Rows (`grading_scales`, `test_catalog`)

Execute **strictly as `studexo_migrator` (table owner) or authorised operations administrator (`postgres`, prior to Step 8 temporary-membership revocation)** — never as `studexo_app` or `studexo_catalog_admin`, which intentionally hold read-only `SELECT` on reference lookup tables. Seed the canonical `DEFAULT_GRADING_SCALES` (6 rows) and `DEFAULT_TEST_CATALOG` (9 rows) from `src/server/db/schema/reference.ts` using idempotent `INSERT ... ON CONFLICT (code) DO NOTHING`.

### Step 10 — Hosted Supabase PostgREST Configuration (Required Beyond SQL)

In addition to SQL-level revocations (`PUBLIC`, `anon`, `authenticated`, `service_role`, and `ALTER DEFAULT PRIVILEGES` across schemas `studexo` and `drizzle` in `0003` and Steps 1–4):

1. In **Supabase Dashboard -> Settings -> API -> Exposed schemas** (and `pgrst.db_schemas` if self-managed), keep **only `public`** and **exclude `studexo`, `extensions`, and `drizzle` completely** so PostgREST never routes HTTP Data API requests or schema metadata discovery into `studexo` or Drizzle migration history.
2. **Never** grant `USAGE` or table/function privileges on `studexo` or `drizzle` to `anon`, `authenticated`, or `service_role`, and never substitute RLS policies on `studexo` as a reason to expose `studexo` via PostgREST. `SUPABASE_SERVICE_ROLE_KEY` is reserved strictly for Storage and Auth Admin HTTP APIs, while database access flows exclusively through the dedicated PostgreSQL roles (`studexo_app`, `studexo_purge_worker`, `studexo_migrator`).

### Step 11 — Live PostgreSQL Verification Gates (Before Production Traffic)

1. Confirm `studexo_migrator`, `studexo_app`, `studexo_purge_worker`, `studexo_purge_owner`, and `studexo_catalog_admin` are `NOINHERIT`, `studexo_catalog_admin` has `rolcanlogin = false`, `studexo_purge_owner` has `rolcanlogin = false`, and **no** role (`postgres`, `studexo_app`, `studexo_catalog_admin`, `studexo_purge_worker`, `studexo_migrator`) holds residual membership in `studexo_purge_owner` (and temporary `studexo_migrator` membership has been revoked from `postgres`).
2. Confirm `pg_proc.prosecdef = true`, `proowner = studexo_purge_owner`, and `proconfig` contains `search_path=pg_catalog, studexo` for `studexo.execute_account_purge(uuid)`, and `prosecdef = true`, `proowner = studexo_migrator`, `proconfig` contains `search_path=pg_catalog, studexo`, with `PUBLIC` execute revoked, `EXECUTE` granted solely to `studexo_app` for `studexo.request_stored_file_deletion(uuid, uuid)` and `studexo.is_auth_user_pending_purge(uuid)`, and `EXECUTE` granted solely to `studexo_purge_worker` for `studexo.revert_stored_file_deletion_request(uuid, uuid)`.
3. Confirm `pg_extension` contains `pg_trgm` and all 4 trigram GIN indexes (`institutions_name_trgm_gin_idx`, `institution_aliases_name_trgm_gin_idx`, `programmes_title_trgm_gin_idx`, `scholarships_title_trgm_gin_idx`) exist, schema `studexo` and schema `drizzle` are both owned by `studexo_migrator`, `drizzle.__drizzle_migrations` contains the 4 applied migration entries, `studexo.grading_scales` (`6` rows) and `studexo.test_catalog` (`9` rows) are populated, and `PUBLIC`, `anon`, `authenticated`, `service_role`, `studexo_app`, `studexo_purge_worker`, and `studexo_catalog_admin` hold **zero** privileges across schema `drizzle` (`__drizzle_migrations` + sequence + default privileges) and `PUBLIC`/`anon`/`authenticated`/`service_role` hold **zero** privileges across schema `studexo`.
4. Execute disposable-PostgreSQL integration tests verifying:
   - Execution of `0000_init_studexo_mvp.sql`, `0001_studexo_integrity_triggers_and_extensions.sql`, `0002_studexo_user_insert_and_file_rollback_guards.sql`, and `0003_studexo_schema_lockout_and_outbox_guard.sql` via `db:migrate` (`src/server/db/migrate.ts`) as `studexo_migrator` (without `CREATE ON DATABASE`) after Steps 1–2 succeeds cleanly, idempotent re-run skips all 4 migrations cleanly, missing/misowned `drizzle` tracking schema fails loudly before executing DDL, and misowned pre-existing schema `studexo` fails loudly with `42501`.
   - Direct `DELETE FROM studexo.users` and `DELETE FROM studexo.stored_files` fail (`42501`) as `studexo_app` and `studexo_migrator`.
   - Simulated `anon`, `authenticated`, and `service_role` roles fail (`42501`) attempting `USAGE` on `studexo`, `SELECT` on `studexo.users`, or `EXECUTE` on `studexo.request_stored_file_deletion(uuid, uuid)` / `studexo.is_auth_user_pending_purge(uuid)` / `studexo.execute_account_purge(uuid)` / future tables created by `studexo_migrator`.
   - `studexo_app` can insert a normal student via column-scoped `INSERT (id, supabase_auth_user_id, primary_email, display_name)` but cannot insert `role`, `status`, `purge_state`, `deletion_*`, `purge_*`, or `purged_at` (`42501` via column grants, and `42501`/`23514` via `guard_users_lifecycle()` `BEFORE INSERT`), cannot re-register or insert a `supabase_auth_user_id` while `users.status = 'pending_deletion'` or while `external_identity_purge_outbox.status` is `'pending_purge' | 'purging' | 'purge_failed'` (`23514`, with `studexo.is_auth_user_pending_purge(uuid)` returning `true` without granting direct table access on `external_identity_purge_outbox`, and returning `false` after `status = 'purged'`), cannot mint `'admin'` users to escalate `request_stored_file_deletion()` or `guard_student_credentials_verification()`, cannot mutate `users.purge_state`, `users.status = 'suspended'`, `stored_files.purge_state`, `stored_files.deleted_by_user_id` via direct `UPDATE`, `verification_claims`, `ai_permissions`, `ai_prompt_versions`, or catalog tables (`42501`), while `studexo_app` CAN call `studexo.request_stored_file_deletion(file_id, actor_id)` for Stage 1 legitimate owner or admin deletion attribution (rejecting null/missing/inactive actors, cross-user non-admin spoofing `42501`, in-use `document_versions` refs `23514`, and already-purged files `23514`) and cannot invoke `studexo.revert_stored_file_deletion_request(uuid, uuid)` (`42501`).
   - `studexo_app` can request and cancel a 14-day account deletion (`pending_deletion` <-> `active`), and backdated/shortened grace requests and post-deadline cancellations are rejected (`23514`).
   - `studexo_purge_worker` cannot `INSERT`/`DELETE` `external_identity_purge_outbox`, cannot `DELETE` `users`/`stored_files`, cannot mutate `stored_files.deleted_by_user_id` directly or execute `studexo.request_stored_file_deletion(uuid, uuid)` (`42501`), cannot revert `pending_purge -> none` directly (`23514`) or leave `deleted_by_user_id` set when `purge_state = 'none'` (`23514`), CAN execute `studexo.revert_stored_file_deletion_request(file_id, owner_id)` strictly on untouched `pending_purge` files (clearing `deleted_by_user_id` and `purge_requested_at` atomically so a subsequent Stage 1 re-request + Stage 2 purge succeeds, while rejecting `purging`/`purge_failed`/`purged` or `purge_attempts > 0` with `23514`), and cannot advance purge before grace expiry (`23514`).
   - `execute_account_purge(uuid)` rejects unpurged `stored_files` (`23514`), rejects non-`read committed` isolation (`25000`), and cleanly completes account deletion even when `verification_claims.verified_by_user_id` points to a superseded claim or `stored_files.deleted_by_user_id` points to another user's file attributed via `request_stored_file_deletion` (explicit updates inside `execute_account_purge` as `studexo_purge_owner`).
   - `verification_claims` supersession rejects non-`read committed` isolation (`25000`), rejects historical mutation of superseded claims (`23514`) including attempts by `studexo_migrator`, rejects `'superseded' | 'rejected' | 'disputed'` replacements (`23514`), and detects 2-node and 3-node cycles (`23514`).
   - `application_documents` enforces advisory locking on `INSERT`/`UPDATE`/`DELETE`, protects `'replaced'`/`'withdrawn'`/`'submitted'` history, and rejects deleting `'replaced'` or `replaced_by_id`-referenced rows (`23514`).
   - `programme_intakes` and `scholarship_intakes` referencing active applications fail with `23503` (`ON DELETE RESTRICT`).
   - All 7 unlinker triggers clear optional composite FKs cleanly without violating `user_id NOT NULL`.
   - `verification_evidence` rejects `UPDATE`/`DELETE` via trigger `trg_verification_evidence_immutable` (`42501`) for all roles; `user_consents` and `application_status_history` enforce append-only behavior via `studexo_app` privilege grants (`42501` for `studexo_app`, while `studexo_migrator`, `studexo_purge_owner`, and `ON DELETE CASCADE` retain delete capability).
