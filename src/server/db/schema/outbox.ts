import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { purgeStateEnum, studexoSchema } from './enums';

/**
 * Decoupled outbox for asynchronous deletion of Supabase auth.users records
 * after local Studexo account purge completes. Intentionally holds NO foreign key
 * to studexo.users so rows survive user deletion.
 */
export const externalIdentityPurgeOutbox = studexoSchema.table(
  'external_identity_purge_outbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    formerUserId: uuid('former_user_id').notNull(),
    supabaseAuthUserId: uuid('supabase_auth_user_id').notNull(),
    status: purgeStateEnum('status').notNull().default('pending_purge'),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(10),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    leaseOwner: varchar('lease_owner', { length: 120 }),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    lastErrorMessage: text('last_error_message'),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('external_identity_purge_outbox_auth_uidx').on(table.supabaseAuthUserId),
    index('external_identity_purge_outbox_poll_idx').on(
      table.status,
      table.nextAttemptAt,
      table.lockedUntil,
    ),
    index('external_identity_purge_outbox_former_user_idx').on(table.formerUserId),
    check(
      'external_identity_purge_outbox_status_domain_chk',
      sql`status IN ('pending_purge', 'purging', 'purge_failed', 'purged')`,
    ),
    check(
      'external_identity_purge_outbox_completed_at_chk',
      sql`(status = 'purged' AND completed_at IS NOT NULL) OR (status <> 'purged' AND completed_at IS NULL)`,
    ),
    check(
      'external_identity_purge_outbox_attempts_chk',
      sql`attempt_count >= 0 AND max_attempts >= 1 AND attempt_count <= max_attempts`,
    ),
  ],
);
