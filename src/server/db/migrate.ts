import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres, { type Sql } from 'postgres';
import { parseMigrationEnv, type MigrationEnv } from '../config/env';
import { buildPostgresClientOptions } from './client';

export const DEFAULT_MIGRATIONS_FOLDER = './drizzle';
export const DEFAULT_MIGRATIONS_SCHEMA = 'drizzle';
export const DEFAULT_MIGRATIONS_TABLE = '__drizzle_migrations';

export interface RunMigrationsOptions {
  migrationsFolder?: string;
  trackingSchema?: string;
  trackingTable?: string;
}

export interface RunMigrationsResult {
  trackingSchema: string;
  trackingTable: string;
  appliedTags: string[];
  skippedTags: string[];
}

function quotePgIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid PostgreSQL identifier: "${identifier}"`);
  }
  return `"${identifier}"`;
}

/**
 * Verifies that the dedicated migration tracking schema already exists and is
 * owned by `studexo_migrator` (or CURRENT_USER in role-free vanilla tests).
 *
 * Intentionally avoids `CREATE SCHEMA IF NOT EXISTS` because PostgreSQL 15+
 * checks `CREATE ON DATABASE` privileges before evaluating `IF NOT EXISTS`,
 * which would fail with SQLSTATE 42501 for least-privilege `studexo_migrator`.
 */
export async function ensureTrackingSchemaReady(
  sqlClient: Sql,
  trackingSchema: string = DEFAULT_MIGRATIONS_SCHEMA,
): Promise<void> {
  const rows = await sqlClient<Array<{ schemaOwner: string | null; currentUser: string; hasMigratorRole: boolean }>>`
    SELECT
      (
        SELECT pg_catalog.pg_get_userbyid(n.nspowner)::text
          FROM pg_catalog.pg_namespace n
         WHERE n.nspname = ${trackingSchema}
      ) AS "schemaOwner",
      CURRENT_USER::text AS "currentUser",
      EXISTS (
        SELECT 1
          FROM pg_catalog.pg_roles r
         WHERE r.rolname = 'studexo_migrator'
      ) AS "hasMigratorRole"
  `;

  const row = rows[0];
  if (!row || !row.schemaOwner) {
    throw new Error(
      `Migration tracking schema "${trackingSchema}" does not exist. Because studexo_migrator intentionally lacks CREATE ON DATABASE privilege, an operations administrator must run docs/DATABASE_ROLES.md Step 1 to pre-create "${trackingSchema}" AUTHORIZATION studexo_migrator before running migrations.`,
    );
  }

  const expectedOwner = row.hasMigratorRole ? 'studexo_migrator' : row.currentUser;
  if (row.schemaOwner !== expectedOwner) {
    throw new Error(
      `Migration tracking schema "${trackingSchema}" is owned by "${row.schemaOwner}" instead of required owner "${expectedOwner}".`,
    );
  }
}

/**
 * Executes unapplied Drizzle SQL migrations strictly via `DIRECT_DATABASE_URL`
 * with verified TLS (`resolvePostgresTlsConfig` + optional `DB_SSL_ROOT_CERT`),
 * `prepare: false`, `max: 1`, and dedicated `drizzle.__drizzle_migrations` tracking.
 */
export async function runMigrations(
  migrationEnv: MigrationEnv,
  options: RunMigrationsOptions = {},
): Promise<RunMigrationsResult> {
  const migrationsFolder = path.resolve(
    process.cwd(),
    options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER,
  );
  const trackingSchema = options.trackingSchema ?? DEFAULT_MIGRATIONS_SCHEMA;
  const trackingTable = options.trackingTable ?? DEFAULT_MIGRATIONS_TABLE;

  const quotedSchema = quotePgIdentifier(trackingSchema);
  const quotedTable = quotePgIdentifier(trackingTable);

  const clientOptions = buildPostgresClientOptions({
    connectionString: migrationEnv.database.DIRECT_DATABASE_URL,
    envVarName: 'DIRECT_DATABASE_URL',
    isProduction: migrationEnv.runtime.NODE_ENV === 'production',
    max: 1,
    idleTimeoutSeconds: migrationEnv.database.DB_IDLE_TIMEOUT_SECONDS,
    connectTimeoutSeconds: migrationEnv.database.DB_CONNECT_TIMEOUT_SECONDS,
    sslRootCert: migrationEnv.database.DB_SSL_ROOT_CERT,
  });

  const sqlClient = postgres(migrationEnv.database.DIRECT_DATABASE_URL, clientOptions);

  try {
    await ensureTrackingSchemaReady(sqlClient, trackingSchema);

    await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS ${quotedSchema}.${quotedTable} (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);

    const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const migrations = readMigrationFiles({
      migrationsFolder,
      migrationsSchema: trackingSchema,
      migrationsTable: trackingTable,
    });

    const appliedRows = await sqlClient.unsafe<Array<{ created_at: string | number | null }>>(
      `SELECT id, hash, created_at FROM ${quotedSchema}.${quotedTable} ORDER BY created_at DESC LIMIT 1`,
    );
    const lastCreatedAt = appliedRows[0]?.created_at != null ? Number(appliedRows[0].created_at) : null;

    const appliedTags: string[] = [];
    const skippedTags: string[] = [];

    await sqlClient.begin(async (tx) => {
      for (let i = 0; i < migrations.length; i += 1) {
        const migration = migrations[i]!;
        const tag = journal.entries[i]?.tag ?? `${migration.folderMillis}`;

        if (lastCreatedAt !== null && lastCreatedAt >= migration.folderMillis) {
          skippedTags.push(tag);
          continue;
        }

        for (const statement of migration.sql) {
          if (statement.trim().length === 0) continue;
          await tx.unsafe(statement);
        }

        await tx.unsafe(
          `INSERT INTO ${quotedSchema}.${quotedTable} ("hash", "created_at") VALUES ($1, $2)`,
          [migration.hash, migration.folderMillis],
        );
        appliedTags.push(tag);
      }
    });

    return {
      trackingSchema,
      trackingTable,
      appliedTags,
      skippedTags,
    };
  } finally {
    await sqlClient.end({ timeout: 5 });
  }
}

function isDirectCliExecution(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return fs.realpathSync(argvPath) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function runCli(): Promise<void> {
  await import('dotenv/config');
  const migrationEnv = parseMigrationEnv(process.env);
  const result = await runMigrations(migrationEnv);
  console.log(
    `Studexo migrations complete (${result.trackingSchema}.${result.trackingTable}): applied=[${result.appliedTags.join(', ')}], skipped=[${result.skippedTags.join(', ')}]`,
  );
}

if (isDirectCliExecution()) {
  runCli().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Studexo migration runner failed: ${message}`);
    process.exit(1);
  });
}
