import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  accountStatusEnum,
  authProviderEnum,
  consentTypeEnum,
  purgeStateEnum,
  studexoSchema,
  userRoleEnum,
} from './enums';

export const users = studexoSchema.table(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Nullable link to Supabase auth.users.id for external auth purge handoff; no cross-schema FK.
    supabaseAuthUserId: uuid('supabase_auth_user_id'),
    // Contact email metadata only; external identity resolution must always go through auth_identities.
    primaryEmail: varchar('primary_email', { length: 320 }).notNull(),
    displayName: varchar('display_name', { length: 160 }),
    role: userRoleEnum('role').notNull().default('student'),
    status: accountStatusEnum('status').notNull().default('active'),
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true, mode: 'date' }),
    deletionScheduledFor: timestamp('deletion_scheduled_for', { withTimezone: true, mode: 'date' }),
    purgeState: purgeStateEnum('purge_state').notNull().default('none'),
    purgeLeaseOwner: varchar('purge_lease_owner', { length: 120 }),
    purgeLeaseUntil: timestamp('purge_lease_until', { withTimezone: true, mode: 'date' }),
    purgeAttempts: integer('purge_attempts').notNull().default(0),
    lastPurgeError: text('last_purge_error'),
    purgedAt: timestamp('purged_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('users_supabase_auth_user_id_uidx')
      .on(table.supabaseAuthUserId)
      .where(sql`supabase_auth_user_id IS NOT NULL`),
    index('users_primary_email_idx').on(table.primaryEmail),
    index('users_role_status_idx').on(table.role, table.status),
    index('users_purge_schedule_idx').on(table.purgeState, table.deletionScheduledFor),
    index('users_purge_lease_idx').on(table.purgeState, table.purgeLeaseUntil),
    check('users_purge_attempts_nonneg_chk', sql`purge_attempts >= 0`),
    check(
      'users_purge_lease_state_chk',
      sql`(purge_state = 'purging' AND purge_lease_owner IS NOT NULL AND purge_lease_until IS NOT NULL) OR (purge_state <> 'purging' AND purge_lease_owner IS NULL AND purge_lease_until IS NULL)`,
    ),
    check(
      'users_deletion_window_chk',
      sql`(deletion_scheduled_for IS NULL AND deletion_requested_at IS NULL) OR (deletion_requested_at IS NOT NULL AND (deletion_scheduled_for IS NULL OR deletion_scheduled_for >= deletion_requested_at))`,
    ),
    check(
      'users_pending_deletion_consistency_chk',
      sql`status <> 'pending_deletion' OR (deletion_requested_at IS NOT NULL AND purge_state <> 'none')`,
    ),
    check(
      'users_purged_at_consistency_chk',
      sql`(purge_state = 'purged' AND purged_at IS NOT NULL) OR (purge_state <> 'purged' AND purged_at IS NULL)`,
    ),
  ],
);

export const authIdentities = studexoSchema.table(
  'auth_identities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: authProviderEnum('provider').notNull(),
    providerSubject: varchar('provider_subject', { length: 255 }).notNull(),
    emailAtProvider: varchar('email_at_provider', { length: 320 }),
    emailVerified: boolean('email_verified').notNull().default(false),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('auth_identities_provider_subject_uidx').on(
      table.provider,
      table.providerSubject,
    ),
    index('auth_identities_user_id_idx').on(table.userId),
  ],
);

export const accountSettings = studexoSchema.table(
  'account_settings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    preferredLocale: varchar('preferred_locale', { length: 16 }).notNull().default('en'),
    preferredCurrency: varchar('preferred_currency', { length: 3 }).notNull().default('USD'),
    timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Dhaka'),
    marketingOptIn: boolean('marketing_opt_in').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex('account_settings_user_id_uidx').on(table.userId)],
);

export const userConsents = studexoSchema.table(
  'user_consents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    consentType: consentTypeEnum('consent_type').notNull(),
    policyVersion: varchar('policy_version', { length: 64 }).notNull(),
    action: varchar('action', { length: 16 }).notNull(),
    requirementLevel: varchar('requirement_level', { length: 16 }).notNull(),
    sourceSurface: varchar('source_surface', { length: 64 }).notNull(),
    ipHash: varchar('ip_hash', { length: 128 }),
    userAgentSummary: varchar('user_agent_summary', { length: 255 }),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('user_consents_user_type_recorded_idx').on(
      table.userId,
      table.consentType,
      table.recordedAt,
    ),
    check('user_consents_action_chk', sql`action IN ('accepted', 'withdrawn')`),
    check(
      'user_consents_requirement_level_chk',
      sql`requirement_level IN ('required', 'optional', 'conditional')`,
    ),
  ],
);
