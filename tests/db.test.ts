import fs from 'node:fs';
import path from 'node:path';
import { is, isTable } from 'drizzle-orm';
import { getTableConfig, isPgEnum, type PgEnum, type PgTable } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv, parseMigrationEnv, parseWorkerEnv } from '../src/server/config/env';
import {
  aiUsageRecords,
  closeAllDbs,
  closeDb,
  createRuntimeDbClient,
  DatabaseNotConfiguredError,
  getDatabaseConfigStatus,
  getDb,
  getMigrationConnectionConfig,
  getWorkerDb,
  hasActiveDbClient,
  hasActiveWorkerDbClient,
  notificationStatusEnum,
  programmeFees,
  schema,
  scholarshipFundingComponents,
  scoreStatusEnum,
  storedFiles,
  studentProfiles,
  studexoSchema,
} from '../src/server/db/index';
import {
  DEFAULT_MIGRATIONS_FOLDER,
  DEFAULT_MIGRATIONS_SCHEMA,
  DEFAULT_MIGRATIONS_TABLE,
  ensureTrackingSchemaReady,
  runMigrations,
} from '../src/server/db/migrate';

const EXPECTED_TABLES = [
  'grading_scales',
  'test_catalog',
  'users',
  'auth_identities',
  'account_settings',
  'user_consents',
  'student_profiles',
  'student_qualifications',
  'student_test_scores',
  'student_experiences',
  'student_publications_and_projects',
  'institutions',
  'institution_aliases',
  'programmes',
  'programme_intakes',
  'programme_fees',
  'programme_requirements',
  'scholarships',
  'scholarship_intakes',
  'scholarship_programmes',
  'scholarship_eligibility_rules',
  'scholarship_funding_components',
  'sources',
  'verification_claims',
  'verification_evidence',
  'stored_files',
  'documents',
  'document_versions',
  'saved_opportunities',
  'university_applications',
  'scholarship_applications',
  'application_documents',
  'application_checklists',
  'application_notes',
  'application_status_history',
  'planner_tasks',
  'planner_events',
  'notification_preferences',
  'notification_deliveries',
  'ai_prompt_versions',
  'ai_permissions',
  'ai_conversations',
  'ai_messages',
  'ai_runs',
  'ai_usage_records',
  'ai_run_context_links',
  'external_identity_purge_outbox',
] as const;

const EXPECTED_ENUMS = [
  'user_role',
  'account_status',
  'auth_provider',
  'consent_type',
  'purge_state',
  'study_level',
  'funding_need',
  'qualification_level',
  'score_status',
  'experience_type',
  'institution_type',
  'delivery_mode',
  'intake_term',
  'fee_type',
  'student_residency_category',
  'requirement_type',
  'scholarship_provider_type',
  'scholarship_coverage',
  'eligibility_rule_type',
  'funding_component',
  'funding_frequency',
  'verification_status',
  'source_type',
  'source_reliability',
  'file_upload_status',
  'document_status',
  'application_document_state',
  'application_status',
  'task_status',
  'task_priority',
  'planner_event_type',
  'notification_channel',
  'notification_status',
  'ai_conversation_status',
  'ai_message_role',
  'ai_run_status',
] as const;

const EXPECTED_FUNCTIONS = [
  'set_updated_at',
  'guard_student_credentials_verification',
  'guard_users_lifecycle',
  'guard_stored_files_lifecycle',
  'guard_document_versions_integrity',
  'guard_application_documents_integrity',
  'guard_verification_claims_supersession',
  'guard_verification_evidence_immutable',
  'unlink_document_version_refs',
  'unlink_university_application_refs',
  'unlink_scholarship_application_refs',
  'unlink_document_refs',
  'unlink_ai_conversation_refs',
  'unlink_planner_task_refs',
  'unlink_planner_event_refs',
  'execute_account_purge',
  'request_stored_file_deletion',
] as const;

const EXPECTED_UPDATED_AT_TRIGGERS = [
  'trg_grading_scales_updated_at',
  'trg_test_catalog_updated_at',
  'trg_users_updated_at',
  'trg_auth_identities_updated_at',
  'trg_account_settings_updated_at',
  'trg_student_profiles_updated_at',
  'trg_student_qualifications_updated_at',
  'trg_student_test_scores_updated_at',
  'trg_student_experiences_updated_at',
  'trg_student_publications_and_projects_updated_at',
  'trg_institutions_updated_at',
  'trg_programmes_updated_at',
  'trg_programme_intakes_updated_at',
  'trg_programme_fees_updated_at',
  'trg_programme_requirements_updated_at',
  'trg_scholarships_updated_at',
  'trg_scholarship_intakes_updated_at',
  'trg_sources_updated_at',
  'trg_verification_claims_updated_at',
  'trg_stored_files_updated_at',
  'trg_documents_updated_at',
  'trg_university_applications_updated_at',
  'trg_scholarship_applications_updated_at',
  'trg_application_documents_updated_at',
  'trg_application_checklists_updated_at',
  'trg_application_notes_updated_at',
  'trg_planner_tasks_updated_at',
  'trg_planner_events_updated_at',
  'trg_notification_preferences_updated_at',
  'trg_notification_deliveries_updated_at',
  'trg_ai_permissions_updated_at',
  'trg_ai_conversations_updated_at',
  'trg_external_identity_purge_outbox_updated_at',
] as const;

const EXPECTED_DOMAIN_TRIGGERS = [
  'trg_student_qualifications_verification_guard',
  'trg_student_test_scores_verification_guard',
  'trg_student_experiences_verification_guard',
  'trg_student_publications_and_projects_verification_guard',
  'trg_users_lifecycle',
  'trg_stored_files_lifecycle',
  'trg_document_versions_integrity',
  'trg_application_documents_integrity',
  'trg_verification_claims_supersession',
  'trg_verification_evidence_immutable',
  'trg_document_versions_unlink_refs',
  'trg_university_applications_unlink_refs',
  'trg_scholarship_applications_unlink_refs',
  'trg_documents_unlink_refs',
  'trg_ai_conversations_unlink_refs',
  'trg_planner_tasks_unlink_refs',
  'trg_planner_events_unlink_refs',
] as const;

describe('Studexo database implementation (Phase 8B.3B)', () => {
  afterEach(async () => {
    await closeAllDbs();
  });

  it('exports exact 47 tables and 36 PostgreSQL enums isolated strictly inside studexo', () => {
    expect(studexoSchema.schemaName).toBe('studexo');

    const exportedTables = (Object.values(schema) as unknown[]).filter((value): value is PgTable =>
      isTable(value),
    );
    const tableConfigs = exportedTables.map((table) => getTableConfig(table));
    const tableNames = tableConfigs.map((cfg) => cfg.name).sort();

    expect(exportedTables).toHaveLength(47);
    expect(tableNames).toEqual([...EXPECTED_TABLES].sort());
    for (const cfg of tableConfigs) {
      expect(cfg.schema).toBe('studexo');
    }

    const exportedEnums = (Object.values(schema) as unknown[]).filter(
      (value): value is PgEnum<[string, ...string[]]> =>
        isPgEnum(value) && is(value as object, value as never) !== undefined,
    );
    const enumNames = exportedEnums.map((e) => e.enumName).sort();
    expect(exportedEnums).toHaveLength(36);
    expect(enumNames).toEqual([...EXPECTED_ENUMS].sort());
  });

  it('enforces settled enum domains, numeric precision, Storage-first purge FKs, and intake ON DELETE RESTRICT', () => {
    expect(scoreStatusEnum.enumValues).toEqual([
      'reported',
      'planned',
      'taken_pending_result',
      'not_tested',
      'not_applicable',
      'unknown',
      'waived',
    ]);
    expect(notificationStatusEnum.enumValues).toEqual([
      'queued',
      'sending',
      'sent',
      'failed',
      'cancelled',
    ]);
    expect(notificationStatusEnum.enumValues).not.toContain('read');

    expect(studentProfiles.annualBudgetAmount.columnType).toBe('PgNumeric');
    expect(programmeFees.amount.columnType).toBe('PgNumeric');
    expect(scholarshipFundingComponents.amount.columnType).toBe('PgNumeric');
    expect(scholarshipFundingComponents.percentageCovered.columnType).toBe('PgNumeric');
    expect(aiUsageRecords.estimatedCostUsd.columnType).toBe('PgNumeric');
    expect(storedFiles.visibility.default).toBe('private');

    const storedFilesCfg = getTableConfig(schema.storedFiles);
    const ownerFk = storedFilesCfg.foreignKeys.find((fk) =>
      fk.reference().columns.some((c) => c.name === 'owner_user_id'),
    );
    expect(ownerFk?.onDelete).toBe('restrict');

    const uniAppCfg = getTableConfig(schema.universityApplications);
    const uniIntakeFk = uniAppCfg.foreignKeys.find((fk) => fk.getName() === 'university_applications_intake_prog_fk');
    expect(uniIntakeFk?.onDelete).toBe('restrict');

    const schAppCfg = getTableConfig(schema.scholarshipApplications);
    const schIntakeFk = schAppCfg.foreignKeys.find((fk) => fk.getName() === 'scholarship_applications_intake_sch_fk');
    expect(schIntakeFk?.onDelete).toBe('restrict');

    const outboxCfg = getTableConfig(schema.externalIdentityPurgeOutbox);
    expect(outboxCfg.foreignKeys).toHaveLength(0);
  });

  it('enforces explicit CHECK constraints, users purge lease invariants, canonical document_state, and composite ownership FKs', () => {
    const usersCfg = getTableConfig(schema.users);
    expect(usersCfg.columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(['purge_lease_owner', 'purge_lease_until']),
    );
    expect(usersCfg.checks.map((c) => c.name)).toContain('users_purge_lease_state_chk');
    expect(usersCfg.indexes.map((i) => i.config.name)).toContain('users_purge_lease_idx');

    const verificationCfg = getTableConfig(schema.verificationClaims);
    const appDocsCfg = getTableConfig(schema.applicationDocuments);
    const savedOppsCfg = getTableConfig(schema.savedOpportunities);
    const deliveriesCfg = getTableConfig(schema.notificationDeliveries);
    const contextLinksCfg = getTableConfig(schema.aiRunContextLinks);
    const usageCfg = getTableConfig(schema.aiUsageRecords);

    expect(verificationCfg.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'verification_claims_single_target_chk',
        'verification_claims_not_self_superseded_chk',
        'verification_claims_supersession_state_chk',
      ]),
    );
    for (const fk of verificationCfg.foreignKeys) {
      const ref = fk.reference();
      if (ref.foreignTable !== schema.users) {
        expect(fk.onDelete).toBe('restrict');
      }
    }

    expect(appDocsCfg.columns.map((c) => c.name)).toContain('document_state');
    expect(appDocsCfg.columns.map((c) => c.name)).not.toContain('submission_state');
    expect(appDocsCfg.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'application_documents_single_target_chk',
        'application_documents_not_self_replaced_chk',
        'application_documents_replacement_state_chk',
      ]),
    );

    expect(savedOppsCfg.checks.map((c) => c.name)).toContain('saved_opportunities_single_target_chk');
    expect(deliveriesCfg.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'notification_deliveries_read_at_invariant_chk',
        'notification_deliveries_at_most_one_target_chk',
      ]),
    );
    expect(contextLinksCfg.checks.map((c) => c.name)).toContain(
      'ai_run_context_links_single_target_chk',
    );
    expect(contextLinksCfg.foreignKeys.every((fk) => fk.onDelete === 'cascade')).toBe(true);
    expect(usageCfg.checks).toHaveLength(3);
  });

  it('ships complete offline migrations 0000, 0001, 0002, and 0003 with 47 tables, 36 enums, 19 functions, 50 triggers, 126 indexes, and Phase 8B.3B SQL guards', () => {
    const migration0000Path = path.resolve(process.cwd(), 'drizzle', '0000_init_studexo_mvp.sql');
    const migration0001Path = path.resolve(
      process.cwd(),
      'drizzle',
      '0001_studexo_integrity_triggers_and_extensions.sql',
    );
    const migration0002Path = path.resolve(
      process.cwd(),
      'drizzle',
      '0002_studexo_user_insert_and_file_rollback_guards.sql',
    );
    const migration0003Path = path.resolve(
      process.cwd(),
      'drizzle',
      '0003_studexo_schema_lockout_and_outbox_guard.sql',
    );
    const journalPath = path.resolve(process.cwd(), 'drizzle', 'meta', '_journal.json');
    const snap0000Path = path.resolve(process.cwd(), 'drizzle', 'meta', '0000_snapshot.json');
    const snap0001Path = path.resolve(process.cwd(), 'drizzle', 'meta', '0001_snapshot.json');
    const snap0002Path = path.resolve(process.cwd(), 'drizzle', 'meta', '0002_snapshot.json');
    const snap0003Path = path.resolve(process.cwd(), 'drizzle', 'meta', '0003_snapshot.json');

    expect(fs.existsSync(migration0000Path)).toBe(true);
    expect(fs.existsSync(migration0001Path)).toBe(true);
    expect(fs.existsSync(migration0002Path)).toBe(true);
    expect(fs.existsSync(migration0003Path)).toBe(true);
    expect(fs.existsSync(snap0002Path)).toBe(true);
    expect(fs.existsSync(snap0003Path)).toBe(true);
    expect(fs.existsSync(journalPath)).toBe(true);

    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    expect(journal.entries.map((e) => e.tag)).toEqual([
      '0000_init_studexo_mvp',
      '0001_studexo_integrity_triggers_and_extensions',
      '0002_studexo_user_insert_and_file_rollback_guards',
      '0003_studexo_schema_lockout_and_outbox_guard',
      '0004_fenced_account_purge',
      '0005_fenced_account_purge_equality',
    ]);

    const sql0000 = fs.readFileSync(migration0000Path, 'utf8');
    expect(sql0000).toContain('CREATE SCHEMA "studexo";');
    expect(sql0000).toContain("WHERE n.nspname = 'studexo'");
    expect(sql0000).toContain("v_schema_owner <> 'studexo_migrator'");
    expect(sql0000).toContain("USING ERRCODE = '42501'");
    expect(sql0000.match(/CREATE TABLE "studexo"\."/g) ?? []).toHaveLength(47);
    expect(sql0000.match(/CREATE TYPE "studexo"\."/g) ?? []).toHaveLength(36);
    expect(sql0000.match(/^CREATE .*INDEX /gm) ?? []).toHaveLength(122);
    expect(sql0000).toContain('"purge_lease_owner" varchar(120)');
    expect(sql0000).toContain('"purge_lease_until" timestamp with time zone');
    expect(sql0000).toContain('CONSTRAINT "users_purge_lease_state_chk" CHECK');
    expect(sql0000).toContain('CREATE INDEX "users_purge_lease_idx"');
    expect(sql0000).not.toMatch(/REFERENCES\s+"(auth|storage|realtime|public)"\./i);
    expect(sql0000).toMatch(
      /CONSTRAINT "university_applications_intake_prog_fk"[\s\S]*?ON DELETE restrict ON UPDATE no action/,
    );
    expect(sql0000).toMatch(
      /CONSTRAINT "scholarship_applications_intake_sch_fk"[\s\S]*?ON DELETE restrict ON UPDATE no action/,
    );

    const snap0000 = fs.readFileSync(snap0000Path, 'utf8');
    const snap0001 = fs.readFileSync(snap0001Path, 'utf8');
    const snap0002 = fs.readFileSync(snap0002Path, 'utf8');
    const snap0003 = fs.readFileSync(snap0003Path, 'utf8');
    const parsed0000 = JSON.parse(snap0000) as {
      id: string;
      prevId: string;
      tables: {
        'studexo.users': {
          columns: Record<string, unknown>;
          indexes: Record<string, unknown>;
          checkConstraints: Record<string, unknown>;
        };
        'studexo.university_applications': { foreignKeys: Record<string, { onDelete: string }> };
        'studexo.scholarship_applications': { foreignKeys: Record<string, { onDelete: string }> };
      };
    };
    const parsed0001 = JSON.parse(snap0001) as typeof parsed0000;
    const parsed0002 = JSON.parse(snap0002) as typeof parsed0000;
    const parsed0003 = JSON.parse(snap0003) as typeof parsed0000;
    expect(parsed0001.prevId).toBe(parsed0000.id);
    expect(parsed0002.prevId).toBe(parsed0001.id);
    expect(parsed0003.prevId).toBe(parsed0002.id);
    expect({ ...parsed0000, id: undefined, prevId: undefined }).toEqual({
      ...parsed0001,
      id: undefined,
      prevId: undefined,
    });
    expect({ ...parsed0001, id: undefined, prevId: undefined }).toEqual({
      ...parsed0002,
      id: undefined,
      prevId: undefined,
    });
    expect({ ...parsed0002, id: undefined, prevId: undefined }).toEqual({
      ...parsed0003,
      id: undefined,
      prevId: undefined,
    });
    for (const parsed of [parsed0000, parsed0001, parsed0002]) {
      expect(parsed.tables['studexo.users'].columns).toHaveProperty('purge_lease_owner');
      expect(parsed.tables['studexo.users'].columns).toHaveProperty('purge_lease_until');
      expect(parsed.tables['studexo.users'].indexes).toHaveProperty('users_purge_lease_idx');
      expect(parsed.tables['studexo.users'].checkConstraints).toHaveProperty(
        'users_purge_lease_state_chk',
      );
      expect(
        parsed.tables['studexo.university_applications'].foreignKeys.university_applications_intake_prog_fk
          ?.onDelete,
      ).toBe('restrict');
      expect(
        parsed.tables['studexo.scholarship_applications'].foreignKeys.scholarship_applications_intake_sch_fk
          ?.onDelete,
      ).toBe('restrict');
    }

    const sql0001 = fs.readFileSync(migration0001Path, 'utf8');
    const functionMatches = [
      ...sql0001.matchAll(/CREATE OR REPLACE FUNCTION studexo\.([a-z0-9_]+)\(/g),
    ].map((m) => m[1]);
    expect(functionMatches).toHaveLength(17);
    expect(functionMatches.sort()).toEqual([...EXPECTED_FUNCTIONS].sort());

    const triggerMatches = [...sql0001.matchAll(/CREATE TRIGGER ([a-z0-9_]+)/g)].map((m) => m[1]);
    expect(triggerMatches).toHaveLength(50);
    expect(triggerMatches.sort()).toEqual(
      [...EXPECTED_UPDATED_AT_TRIGGERS, ...EXPECTED_DOMAIN_TRIGGERS].sort(),
    );

    // Structural verification of SQL guards (runtime behavior still requires live PostgreSQL verification).
    expect(sql0001).toContain("USING ERRCODE = '0A000'");
    expect(sql0001).not.toMatch(/WHEN insufficient_privilege[\s\S]*?NULL;/);
    expect(sql0001.match(/%I\.gin_trgm_ops/g) ?? []).toHaveLength(4);

    // Unqualified SQL-standard CURRENT_USER must be used everywhere instead of invalid pg_catalog.current_user
    const legacyQualifiedCurrentUser = ['pg_catalog', 'current_user'].join('.');
    expect(sql0001).not.toContain(legacyQualifiedCurrentUser);
    expect(sql0001.match(/\bCURRENT_USER\b/g) ?? []).toHaveLength(9);

    // Ensure phantom intake unlinkers do not exist anywhere
    expect(sql0001).not.toContain('unlink_programme_intake_refs');
    expect(sql0001).not.toContain('unlink_scholarship_intake_refs');

    expect(sql0001).toContain('BEFORE UPDATE OR DELETE ON studexo.users');
    expect(sql0001).toContain("interval '14 days'");
    expect(sql0001).toContain("interval '5 minutes'");
    expect(sql0001).toContain('studexo_app cannot perform direct administrative suspension status changes');
    expect(sql0001).toContain('Cannot steal active account purge lease for user %');

    expect(sql0001).toContain('BEFORE INSERT OR UPDATE OR DELETE ON studexo.stored_files');
    expect(sql0001).toContain("NEW.upload_status NOT IN ('pending', 'uploaded')");
    expect(sql0001).toContain('Cannot reset stored_files % from purging to pending_purge while lease is active');
    expect(sql0001).toContain(
      'Only authorised deletion request or account_purge execution may modify stored_files.deleted_by_user_id.',
    );
    expect(sql0001).toContain("pg_catalog.current_setting('studexo.file_deletion_mode', true) = 'request'");

    expect(sql0001).toMatch(/guard_document_versions_integrity[\s\S]*?FOR SHARE/);

    expect(sql0001).toContain('BEFORE INSERT OR UPDATE OR DELETE ON studexo.application_documents');
    expect(sql0001).toMatch(
      /guard_application_documents_integrity[\s\S]*?PERFORM pg_catalog\.pg_advisory_xact_lock\(v_lock_id\);[\s\S]*?IF TG_OP = 'DELETE' THEN[\s\S]*?IF v_in_account_purge THEN/,
    );
    expect(sql0001).toContain('Replaced application_documents row % is historically immutable');
    expect(sql0001).toContain(
      'Withdrawn application_documents row % cannot return to active or submitted states',
    );
    expect(sql0001).toContain('Replaced application_documents row % cannot be deleted directly');
    expect(sql0001).toContain(
      'Cannot delete application_documents row % because another row records replaced_by_id pointing to it',
    );
    expect(sql0001).toContain(
      'Cannot withdraw application_documents row % because it is an active replacement target',
    );

    const guardClaimsBody = sql0001.slice(
      sql0001.indexOf('CREATE OR REPLACE FUNCTION studexo.guard_verification_claims_supersession()'),
      sql0001.indexOf('CREATE OR REPLACE FUNCTION studexo.guard_verification_evidence_immutable()'),
    );
    expect(guardClaimsBody).toContain('Superseded verification_claim % is immutable and cannot be restored or modified');
    expect(guardClaimsBody).toContain("CURRENT_USER = 'studexo_purge_owner'");
    expect(guardClaimsBody).toContain("pg_catalog.current_setting('studexo.purge_mode', true) = 'account_purge'");
    expect(guardClaimsBody).toContain('AND NEW.updated_at = OLD.updated_at');
    expect(guardClaimsBody).toContain("AND u.status = 'pending_deletion'");
    expect(guardClaimsBody).toContain("AND u.purge_state = 'purging'");
    expect(guardClaimsBody).not.toContain('studexo_migrator');
    expect(guardClaimsBody).not.toContain('NOT EXISTS');
    expect(sql0001).toContain("v_target_status IN ('superseded', 'rejected', 'disputed')");

    const purgeFnSection = sql0001.slice(
      sql0001.indexOf('CREATE OR REPLACE FUNCTION studexo.execute_account_purge('),
      sql0001.indexOf('-- 33 updated_at Triggers'),
    );
    expect(purgeFnSection).toContain('SECURITY DEFINER');
    expect(purgeFnSection).toContain('SET search_path = pg_catalog, studexo');
    expect(purgeFnSection).toContain('studexo.execute_account_purge requires READ COMMITTED transaction isolation');
    expect(purgeFnSection).toContain("USING ERRCODE = '25000'");
    expect(purgeFnSection).toMatch(
      /UPDATE studexo\.users[\s\S]*?UPDATE studexo\.verification_claims\s+SET verified_by_user_id = NULL\s+WHERE verified_by_user_id = p_user_id;[\s\S]*?UPDATE studexo\.stored_files\s+SET deleted_by_user_id = NULL\s+WHERE deleted_by_user_id = p_user_id;[\s\S]*?DELETE FROM studexo\.application_documents WHERE user_id = p_user_id;[\s\S]*?DELETE FROM studexo\.documents WHERE user_id = p_user_id;[\s\S]*?DELETE FROM studexo\.stored_files WHERE owner_user_id = p_user_id;[\s\S]*?DELETE FROM studexo\.users WHERE id = p_user_id;/,
    );
    expect(purgeFnSection).toContain('REVOKE ALL ON FUNCTION studexo.execute_account_purge(uuid) FROM PUBLIC;');
    expect(purgeFnSection).not.toContain('GRANT EXECUTE ON FUNCTION studexo.execute_account_purge');

    const fileDeletionFnSection = sql0001.slice(
      sql0001.indexOf('CREATE OR REPLACE FUNCTION studexo.request_stored_file_deletion('),
      sql0001.indexOf('-- 33 updated_at Triggers'),
    );
    expect(fileDeletionFnSection).toContain('SECURITY DEFINER');
    expect(fileDeletionFnSection).toContain('SET search_path = pg_catalog, studexo');
    expect(fileDeletionFnSection).toContain('FOR UPDATE');
    expect(fileDeletionFnSection).toContain('FROM studexo.document_versions');
    expect(fileDeletionFnSection).toContain(
      'REVOKE ALL ON FUNCTION studexo.request_stored_file_deletion(uuid, uuid) FROM PUBLIC;',
    );
    expect(fileDeletionFnSection).not.toContain('GRANT EXECUTE ON FUNCTION studexo.request_stored_file_deletion');

    const executableSql0001 = sql0001.replace(/--.*$/gm, '');
    expect(executableSql0001).not.toMatch(/\bCREATE ROLE\b/i);
    expect(executableSql0001).not.toMatch(/\bALTER FUNCTION\b[\s\S]*\bOWNER TO\b/i);

    const sql0002 = fs.readFileSync(migration0002Path, 'utf8');
    const fn0002Matches = [
      ...sql0002.matchAll(/CREATE OR REPLACE FUNCTION studexo\.([a-z0-9_]+)\(/g),
    ].map((m) => m[1]);
    expect(fn0002Matches.sort()).toEqual([
      'guard_stored_files_lifecycle',
      'guard_users_lifecycle',
      'revert_stored_file_deletion_request',
    ]);
    const uniqueCatalogFunctions = new Set([...EXPECTED_FUNCTIONS, ...fn0002Matches]);
    expect(uniqueCatalogFunctions.size).toBe(18);
    expect(sql0002).not.toContain(legacyQualifiedCurrentUser);

    // Finding 1 remediation checks in 0002: INSERT guard + updated trigger event mask
    expect(sql0002).toContain('DROP TRIGGER IF EXISTS trg_users_lifecycle ON studexo.users;');
    expect(sql0002).toContain('BEFORE INSERT OR UPDATE OR DELETE ON studexo.users');
    expect(sql0002).toContain(
      "IF CURRENT_USER IN ('studexo_app', 'studexo_purge_worker', 'studexo_purge_owner', 'studexo_catalog_admin')",
    );
    expect(sql0002).toContain("AND NEW.role <> 'student' THEN");
    expect(sql0002).toContain("IF NEW.status <> 'active' THEN");
    expect(sql0002).toContain("IF NEW.purge_state <> 'none' THEN");
    expect(sql0002).toContain('IF NEW.deletion_requested_at IS NOT NULL OR NEW.deletion_scheduled_for IS NOT NULL THEN');
    expect(sql0002).toContain('IF NEW.purge_lease_owner IS NOT NULL OR NEW.purge_lease_until IS NOT NULL THEN');
    expect(sql0002).toContain(
      'IF NEW.purge_attempts <> 0 OR NEW.last_purge_error IS NOT NULL OR NEW.purged_at IS NOT NULL THEN',
    );

    // Finding 2 remediation checks in 0002: stored_files rollback invariant + SECURITY DEFINER revert function
    expect(sql0002).toContain("pg_catalog.current_setting('studexo.file_deletion_mode', true) = 'revert'");
    expect(sql0002).toContain('IF NEW.purge_attempts < OLD.purge_attempts THEN');
    expect(sql0002).toContain("IF OLD.purge_state = 'purge_failed' AND NEW.purge_state IN ('none', 'pending_purge') THEN");
    expect(sql0002).toContain(
      "IF OLD.purge_state <> 'none' AND NEW.purge_state = 'none' AND NOT v_in_file_deletion_revert THEN",
    );
    expect(sql0002).toContain("IF NEW.purge_state = 'none' THEN");
    expect(sql0002).toContain('OR NEW.deleted_by_user_id IS NOT NULL');

    const revertFnSection = sql0002.slice(
      sql0002.indexOf('CREATE OR REPLACE FUNCTION studexo.revert_stored_file_deletion_request('),
    );
    expect(revertFnSection).toContain('SECURITY DEFINER');
    expect(revertFnSection).toContain('SET search_path = pg_catalog, studexo');
    expect(revertFnSection).toContain('FOR UPDATE');
    expect(revertFnSection).toContain("v_file.purge_state <> 'pending_purge'");
    expect(revertFnSection).toContain("pg_catalog.set_config('studexo.file_deletion_mode', 'revert', true)");
    expect(revertFnSection).toContain('SET deleted_by_user_id = NULL,');
    expect(revertFnSection).toContain("purge_state = 'none',");
    expect(revertFnSection).toContain('purge_requested_at = NULL');
    expect(revertFnSection).toContain(
      'REVOKE ALL ON FUNCTION studexo.revert_stored_file_deletion_request(uuid, uuid) FROM PUBLIC;',
    );
    expect(revertFnSection).not.toContain('GRANT EXECUTE ON FUNCTION studexo.revert_stored_file_deletion_request');

    const executableSql0002 = sql0002.replace(/--.*$/gm, '');
    expect(executableSql0002).not.toMatch(/\bCREATE ROLE\b/i);
    expect(executableSql0002).not.toMatch(/\bALTER FUNCTION\b[\s\S]*\bOWNER TO\b/i);

    const sql0003 = fs.readFileSync(migration0003Path, 'utf8');
    const fn0003Matches = [
      ...sql0003.matchAll(/CREATE OR REPLACE FUNCTION studexo\.([a-z0-9_]+)\(/g),
    ].map((m) => m[1]);
    expect(fn0003Matches.sort()).toEqual([
      'guard_users_lifecycle',
      'is_auth_user_pending_purge',
    ]);
    const totalCatalogFunctions = new Set([...uniqueCatalogFunctions, ...fn0003Matches]);
    expect(totalCatalogFunctions.size).toBe(19);
    expect(sql0003).not.toContain(legacyQualifiedCurrentUser);

    expect(sql0003).toContain('CREATE OR REPLACE FUNCTION studexo.is_auth_user_pending_purge(');
    expect(sql0003).toContain('SECURITY DEFINER');
    expect(sql0003).toContain('SET search_path = pg_catalog, studexo');
    expect(sql0003).toContain('FROM studexo.external_identity_purge_outbox o');
    expect(sql0003).toContain("AND o.status <> 'purged'");
    expect(sql0003).toContain("AND u.status = 'pending_deletion'");
    expect(sql0003).toContain('REVOKE ALL ON FUNCTION studexo.is_auth_user_pending_purge(uuid) FROM PUBLIC;');
    expect(sql0003).toContain('studexo.is_auth_user_pending_purge(NEW.supabase_auth_user_id)');

    expect(sql0003).toContain('REVOKE ALL ON SCHEMA studexo FROM PUBLIC;');
    expect(sql0003).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA studexo FROM PUBLIC;');
    expect(sql0003).toContain('REVOKE ALL ON ALL SEQUENCES IN SCHEMA studexo FROM PUBLIC;');
    expect(sql0003).toContain("ARRAY['anon', 'authenticated', 'service_role']");
    expect(sql0003).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE');

    const executableSql0003 = sql0003.replace(/--.*$/gm, '');
    expect(executableSql0003).not.toMatch(/\bCREATE ROLE\b/i);
    expect(executableSql0003).not.toMatch(/\bALTER FUNCTION\b[\s\S]*\bOWNER TO\b/i);
  });

  it('documents tightened least-privilege PostgreSQL grants and append-only policy across DATABASE.md and DATABASE_ROLES.md', () => {
    const rolesDoc = fs.readFileSync(path.resolve(process.cwd(), 'docs', 'DATABASE_ROLES.md'), 'utf8');
    const dbDoc = fs.readFileSync(path.resolve(process.cwd(), 'docs', 'DATABASE.md'), 'utf8');

    const legacyQualifiedCurrentUser = ['pg_catalog', 'current_user'].join('.');
    expect(rolesDoc).not.toContain(legacyQualifiedCurrentUser);
    expect(dbDoc).not.toContain(legacyQualifiedCurrentUser);
    expect(rolesDoc).not.toContain('unlink_programme_intake_refs');
    expect(dbDoc).not.toContain('unlink_programme_intake_refs');

    expect(rolesDoc).toContain('CREATE ROLE studexo_catalog_admin NOLOGIN NOINHERIT;');
    expect(rolesDoc).toContain('CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION studexo_migrator;');
    expect(rolesDoc).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE studexo_migrator IN SCHEMA drizzle REVOKE ALL ON TABLES FROM PUBLIC;');
    expect(rolesDoc).toContain('bun run db:migrate');
    const step4Section = rolesDoc.slice(
      rolesDoc.indexOf('### Step 4'),
      rolesDoc.indexOf('### Step 5'),
    );
    expect(step4Section).toContain('GRANT EXECUTE ON FUNCTION studexo.execute_account_purge(uuid) TO studexo_purge_worker;');
    expect(step4Section).toContain('REVOKE studexo_purge_owner FROM %I');
    expect(step4Section).not.toContain('REVOKE studexo_migrator FROM %I');
    const step8Section = rolesDoc.slice(
      rolesDoc.indexOf('### Step 8'),
      rolesDoc.indexOf('### Step 9'),
    );
    expect(step8Section).toContain('REVOKE studexo_migrator FROM %I');
    expect(rolesDoc).toContain('strictly as `studexo_migrator` (table owner) or authorised operations administrator (`postgres`');
    expect(rolesDoc).toContain('exclude `studexo`, `extensions`, and `drizzle`');
    expect(rolesDoc).toContain('CREATE SCHEMA IF NOT EXISTS extensions;');
    expect(rolesDoc).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;');
    expect(rolesDoc.indexOf('CREATE SCHEMA IF NOT EXISTS extensions;')).toBeLessThan(
      rolesDoc.indexOf('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;'),
    );

    const step5Section = rolesDoc.slice(
      rolesDoc.indexOf('### Step 5'),
      rolesDoc.indexOf('### Step 6'),
    );
    expect(step5Section).toContain('GRANT SELECT, UPDATE (deleted_by_user_id), DELETE ON studexo.stored_files TO studexo_purge_owner;');
    expect(step5Section).toContain('GRANT SELECT, UPDATE (verified_by_user_id) ON studexo.verification_claims TO studexo_purge_owner;');

    const step6Section = rolesDoc.slice(
      rolesDoc.indexOf('### Step 6'),
      rolesDoc.indexOf('### Step 7'),
    );
    // studexo_app must never write to purge_state on users/stored_files, delete stored_files, or mutate catalog/governance/verification tables
    expect(step6Section).toContain('REVOKE ALL ON studexo.external_identity_purge_outbox FROM studexo_app;');
    expect(step6Section).toContain('GRANT SELECT, INSERT ON\n  studexo.user_consents,\n  studexo.application_status_history\nTO studexo_app;');
    for (const protectedTable of [
      'ai_permissions',
      'ai_prompt_versions',
      'verification_claims',
      'verification_evidence',
      'sources',
      'institutions',
      'programmes',
      'scholarships',
    ]) {
      expect(step6Section).not.toMatch(
        new RegExp(`GRANT[^\\n;]*(INSERT|UPDATE|DELETE)[^\\n;]*studexo\\.${protectedTable}`, 's'),
      );
    }
    expect(step6Section).not.toMatch(/GRANT[^\n;]*DELETE[^\n;]*studexo\.stored_files/s);
    expect(step6Section).not.toMatch(
      /GRANT UPDATE\s*\([^)]*purge_state[^)]*\)\s*ON studexo\.users TO studexo_app/s,
    );
    expect(step6Section).not.toMatch(
      /GRANT UPDATE\s*\([^)]*purge_state[^)]*\)\s*ON studexo\.stored_files TO studexo_app/s,
    );
    expect(step6Section).toContain('REVOKE INSERT ON studexo.users FROM studexo_app;');
    expect(step6Section).toContain('GRANT SELECT ON studexo.users TO studexo_app;');
    expect(step6Section).toContain(
      'GRANT INSERT (\n  id,\n  supabase_auth_user_id,\n  primary_email,\n  display_name\n) ON studexo.users TO studexo_app;',
    );
    expect(step6Section).not.toMatch(/GRANT SELECT,\s*INSERT ON studexo\.users TO studexo_app/s);
    expect(step6Section).not.toMatch(/GRANT INSERT ON studexo\.users TO studexo_app/s);
    expect(step6Section).toContain(
      'GRANT EXECUTE ON FUNCTION studexo.request_stored_file_deletion(uuid, uuid) TO studexo_app;',
    );
    expect(step6Section).toContain(
      'GRANT EXECUTE ON FUNCTION studexo.is_auth_user_pending_purge(uuid) TO studexo_app;',
    );
    expect(step6Section).not.toContain('revert_stored_file_deletion_request');
    expect(step6Section).not.toMatch(
      /GRANT UPDATE\s*\([^)]*deleted_by_user_id[^)]*\)\s*ON studexo\.stored_files TO studexo_app/s,
    );

    const step7Section = rolesDoc.slice(
      rolesDoc.indexOf('### Step 7'),
      rolesDoc.indexOf('### Step 8'),
    );
    // studexo_purge_worker must not INSERT/DELETE outbox, DELETE users/stored_files, or mutate deleted_by_user_id
    expect(step7Section).not.toMatch(/GRANT[^\n;]*(INSERT|DELETE)[^\n;]*studexo\.external_identity_purge_outbox/s);
    expect(step7Section).not.toMatch(/GRANT[^\n;]*DELETE[^\n;]*studexo\.stored_files/s);
    expect(step7Section).not.toMatch(/GRANT[^\n;]*DELETE[^\n;]*studexo\.users/s);
    expect(step7Section).not.toMatch(/GRANT SELECT,\s*UPDATE ON studexo\.stored_files TO studexo_purge_worker/s);
    expect(step7Section).not.toMatch(
      /GRANT UPDATE\s*\([^)]*deleted_by_user_id[^)]*\)\s*ON studexo\.stored_files TO studexo_purge_worker/s,
    );
    expect(step7Section).not.toContain('request_stored_file_deletion');
    expect(step7Section).toContain(
      'GRANT EXECUTE ON FUNCTION studexo.revert_stored_file_deletion_request(uuid, uuid) TO studexo_purge_worker;',
    );
    expect(step7Section).toContain('purge_lease_owner');
    expect(step7Section).toContain('purge_lease_until');
    expect(step7Section).toMatch(
      /GRANT SELECT\s*\([^)]*last_purge_error[^)]*\)\s*ON studexo\.users TO studexo_purge_worker/s,
    );
    expect(step7Section).toContain('ON studexo.document_versions TO studexo_purge_worker');

    // Append-only policy, PostgREST exclusion & Phase 8B.3B docs alignment
    expect(dbDoc).toContain('0002_studexo_user_insert_and_file_rollback_guards.sql');
    expect(dbDoc).toContain('0003_studexo_schema_lockout_and_outbox_guard.sql');
    expect(dbDoc).toContain('19 custom PostgreSQL functions');
    expect(dbDoc).toContain('WORKER_DATABASE_URL');
    expect(dbDoc).toContain('CATALOG_ADMIN_DATABASE_URL');
    expect(dbDoc).toContain('trg_verification_evidence_immutable');
    expect(dbDoc).toContain('privilege-based `SELECT, INSERT` append-only enforcement for `studexo_app`');
    expect(dbDoc).toContain('126 indexes');
    expect(rolesDoc).toContain('trg_verification_evidence_immutable');
    expect(rolesDoc).toContain('Privilege-based append-only `SELECT, INSERT` on `user_consents` and `application_status_history`');
    expect(rolesDoc).toContain('Exposed schemas');
  });

  it('reports non-connecting status accurately, isolates API and worker DB clients, and never leaks credentials', async () => {
    const unconfiguredEnv = parseEnv({ NODE_ENV: 'test' });
    expect(getDatabaseConfigStatus(unconfiguredEnv)).toEqual({
      configured: false,
      connected: false,
      poolMax: 5,
      idleTimeoutSeconds: 20,
      connectTimeoutSeconds: 10,
    });
    expect(
      'migrationsUrlConfigured' in
        (getDatabaseConfigStatus(unconfiguredEnv) as unknown as Record<string, unknown>),
    ).toBe(false);

    expect(() => getDb(unconfiguredEnv)).toThrow(DatabaseNotConfiguredError);
    expect(() => createRuntimeDbClient(unconfiguredEnv)).toThrow(DatabaseNotConfiguredError);
    expect(() =>
      getMigrationConnectionConfig({
        runtime: { NODE_ENV: 'test', logLevel: 'silent' },
        database: {
          DIRECT_DATABASE_URL: '',
          DB_IDLE_TIMEOUT_SECONDS: 20,
          DB_CONNECT_TIMEOUT_SECONDS: 10,
        },
      }),
    ).toThrow(DatabaseNotConfiguredError);
    expect(hasActiveDbClient()).toBe(false);
    expect(hasActiveWorkerDbClient()).toBe(false);

    const secretPassword = 'super-secret-db-password-never-expose';
    const workerPassword = 'super-secret-worker-password-never-expose';
    const configuredEnv = parseEnv({
      NODE_ENV: 'test',
      DATABASE_URL: `postgresql://studexo_app:${secretPassword}@127.0.0.1:6543/postgres`,
    });
    expect('DIRECT_DATABASE_URL' in configuredEnv.database).toBe(false);

    const migrationEnvForConfig = parseMigrationEnv({
      NODE_ENV: 'test',
      DIRECT_DATABASE_URL: `postgresql://studexo_migrator:${secretPassword}@127.0.0.1:5432/postgres`,
    });
    const migrationCfg = getMigrationConnectionConfig(migrationEnvForConfig);
    expect(JSON.stringify(migrationCfg)).not.toContain(secretPassword);
    expect(migrationCfg.migrationsSchema).toBe('drizzle');
    expect(migrationCfg.migrationsTable).toBe('__drizzle_migrations');
    expect(getDb(configuredEnv)).toBeDefined();
    expect(hasActiveDbClient()).toBe(true);
    // Initializing API DB pool must never instantiate worker DB pool
    expect(hasActiveWorkerDbClient()).toBe(false);

    const workerEnv = parseWorkerEnv({
      NODE_ENV: 'test',
      WORKER_DATABASE_URL: `postgresql://studexo_purge_worker:${workerPassword}@127.0.0.1:6543/postgres`,
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'worker-test-service-role-key',
    });
    expect(getWorkerDb(workerEnv)).toBeDefined();
    expect(hasActiveWorkerDbClient()).toBe(true);

    await closeDb();
    expect(hasActiveDbClient()).toBe(false);
    expect(hasActiveWorkerDbClient()).toBe(true);

    await closeAllDbs();
    expect(hasActiveWorkerDbClient()).toBe(false);
  });

  it('keeps client build and lint boundaries isolated from server database modules', () => {
    const clientTsconfig = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'tsconfig.client.json'), 'utf8'),
    ) as { exclude?: string[] };
    expect(clientTsconfig.exclude).toContain('src/server');

    const eslintSource = fs.readFileSync(
      path.resolve(process.cwd(), 'eslint.config.mjs'),
      'utf8',
    );
    expect(eslintSource).toContain("name: 'postgres'");
    expect(eslintSource).toContain("name: 'drizzle-orm'");
    expect(eslintSource).toContain("name: 'drizzle-kit'");
  });

  it('enforces dedicated drizzle tracking schema ownership without CREATE SCHEMA and validates migration identifiers', async () => {
    expect(DEFAULT_MIGRATIONS_FOLDER).toBe('./drizzle');
    expect(DEFAULT_MIGRATIONS_SCHEMA).toBe('drizzle');
    expect(DEFAULT_MIGRATIONS_TABLE).toBe('__drizzle_migrations');

    const migrationEnv = parseMigrationEnv({
      NODE_ENV: 'test',
      DIRECT_DATABASE_URL: 'postgresql://studexo_migrator:secret@127.0.0.1:5432/postgres',
    });
    await expect(
      runMigrations(migrationEnv, { trackingSchema: 'drizzle; DROP SCHEMA studexo' }),
    ).rejects.toThrow(/Invalid PostgreSQL identifier/);

    const missingSchemaSql = (async () => [
      { schemaOwner: null, currentUser: 'studexo_migrator', hasMigratorRole: true },
    ]) as unknown as Parameters<typeof ensureTrackingSchemaReady>[0];
    await expect(ensureTrackingSchemaReady(missingSchemaSql, 'drizzle')).rejects.toThrow(
      /does not exist/,
    );

    const wrongOwnerSql = (async () => [
      { schemaOwner: 'postgres', currentUser: 'studexo_migrator', hasMigratorRole: true },
    ]) as unknown as Parameters<typeof ensureTrackingSchemaReady>[0];
    await expect(ensureTrackingSchemaReady(wrongOwnerSql, 'drizzle')).rejects.toThrow(
      /owned by "postgres" instead of required owner "studexo_migrator"/,
    );

    const validOwnerSql = (async () => [
      { schemaOwner: 'studexo_migrator', currentUser: 'studexo_migrator', hasMigratorRole: true },
    ]) as unknown as Parameters<typeof ensureTrackingSchemaReady>[0];
    await expect(ensureTrackingSchemaReady(validOwnerSql, 'drizzle')).resolves.toBeUndefined();
  });

  // Intentionally skipped offline placeholder for live PostgreSQL 15+ verification gates.
  it.skip('executes triggers, RLS/roles, and supersession concurrency against live PostgreSQL', () => {
    // Requires live PostgreSQL execution (docs/DATABASE_ROLES.md Step 11).
  });
});
