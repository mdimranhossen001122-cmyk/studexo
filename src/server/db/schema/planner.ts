import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { scholarshipApplications, universityApplications } from './applications';
import {
  notificationChannelEnum,
  notificationStatusEnum,
  plannerEventTypeEnum,
  studexoSchema,
  taskPriorityEnum,
  taskStatusEnum,
} from './enums';
import { users } from './identity';

export const plannerTasks = studexoSchema.table(
  'planner_tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    universityApplicationId: uuid('university_application_id'),
    scholarshipApplicationId: uuid('scholarship_application_id'),
    title: varchar('title', { length: 240 }).notNull(),
    description: text('description'),
    status: taskStatusEnum('status').notNull().default('todo'),
    priority: taskPriorityEnum('priority').notNull().default('medium'),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'planner_tasks_uni_app_user_fk',
      columns: [table.universityApplicationId, table.userId],
      foreignColumns: [universityApplications.id, universityApplications.userId],
    }).onDelete('no action'),
    foreignKey({
      name: 'planner_tasks_sch_app_user_fk',
      columns: [table.scholarshipApplicationId, table.userId],
      foreignColumns: [scholarshipApplications.id, scholarshipApplications.userId],
    }).onDelete('no action'),
    unique('planner_tasks_id_user_uq').on(table.id, table.userId),
    index('planner_tasks_user_status_due_idx').on(table.userId, table.status, table.dueAt),
    index('planner_tasks_uni_app_id_idx').on(table.universityApplicationId),
    index('planner_tasks_sch_app_id_idx').on(table.scholarshipApplicationId),
    check(
      'planner_tasks_at_most_one_target_chk',
      sql`((CASE WHEN university_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_application_id IS NOT NULL THEN 1 ELSE 0 END)) <= 1`,
    ),
  ],
);

export const plannerEvents = studexoSchema.table(
  'planner_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    universityApplicationId: uuid('university_application_id'),
    scholarshipApplicationId: uuid('scholarship_application_id'),
    eventType: plannerEventTypeEnum('event_type').notNull(),
    title: varchar('title', { length: 240 }).notNull(),
    notes: text('notes'),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }),
    isAllDay: boolean('is_all_day').notNull().default(false),
    timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Dhaka'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'planner_events_uni_app_user_fk',
      columns: [table.universityApplicationId, table.userId],
      foreignColumns: [universityApplications.id, universityApplications.userId],
    }).onDelete('no action'),
    foreignKey({
      name: 'planner_events_sch_app_user_fk',
      columns: [table.scholarshipApplicationId, table.userId],
      foreignColumns: [scholarshipApplications.id, scholarshipApplications.userId],
    }).onDelete('no action'),
    unique('planner_events_id_user_uq').on(table.id, table.userId),
    index('planner_events_user_starts_at_idx').on(table.userId, table.startsAt),
    index('planner_events_uni_app_id_idx').on(table.universityApplicationId),
    index('planner_events_sch_app_id_idx').on(table.scholarshipApplicationId),
    check('planner_events_time_order_chk', sql`ends_at IS NULL OR ends_at >= starts_at`),
    check(
      'planner_events_at_most_one_target_chk',
      sql`((CASE WHEN university_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_application_id IS NOT NULL THEN 1 ELSE 0 END)) <= 1`,
    ),
  ],
);

export const notificationPreferences = studexoSchema.table(
  'notification_preferences',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emailRemindersEnabled: boolean('email_reminders_enabled').notNull().default(true),
    inAppRemindersEnabled: boolean('in_app_reminders_enabled').notNull().default(true),
    deadlineLeadDays: integer('deadline_lead_days').notNull().default(7),
    weeklyDigestEnabled: boolean('weekly_digest_enabled').notNull().default(true),
    quietHoursStart: varchar('quiet_hours_start', { length: 5 }),
    quietHoursEnd: varchar('quiet_hours_end', { length: 5 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('notification_preferences_user_id_uidx').on(table.userId),
    check('notification_preferences_lead_days_nonneg_chk', sql`deadline_lead_days >= 0`),
  ],
);

export const notificationDeliveries = studexoSchema.table(
  'notification_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: notificationChannelEnum('channel').notNull(),
    notificationType: varchar('notification_type', { length: 64 }).notNull(),
    dedupeKey: varchar('dedupe_key', { length: 160 }).notNull(),
    status: notificationStatusEnum('status').notNull().default('queued'),
    title: varchar('title', { length: 240 }).notNull(),
    body: text('body').notNull(),
    universityApplicationId: uuid('university_application_id'),
    scholarshipApplicationId: uuid('scholarship_application_id'),
    plannerTaskId: uuid('planner_task_id'),
    plannerEventId: uuid('planner_event_id'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'date' }),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'notification_deliveries_uni_app_user_fk',
      columns: [table.universityApplicationId, table.userId],
      foreignColumns: [universityApplications.id, universityApplications.userId],
    }).onDelete('no action'),
    foreignKey({
      name: 'notification_deliveries_sch_app_user_fk',
      columns: [table.scholarshipApplicationId, table.userId],
      foreignColumns: [scholarshipApplications.id, scholarshipApplications.userId],
    }).onDelete('no action'),
    foreignKey({
      name: 'notification_deliveries_task_user_fk',
      columns: [table.plannerTaskId, table.userId],
      foreignColumns: [plannerTasks.id, plannerTasks.userId],
    }).onDelete('no action'),
    foreignKey({
      name: 'notification_deliveries_event_user_fk',
      columns: [table.plannerEventId, table.userId],
      foreignColumns: [plannerEvents.id, plannerEvents.userId],
    }).onDelete('no action'),
    uniqueIndex('notification_deliveries_user_dedupe_uidx').on(table.userId, table.dedupeKey),
    index('notification_deliveries_user_status_sched_idx').on(
      table.userId,
      table.status,
      table.scheduledFor,
    ),
    check('notification_deliveries_attempts_nonneg_chk', sql`attempt_count >= 0`),
    check(
      'notification_deliveries_read_at_invariant_chk',
      sql`read_at IS NULL OR (channel = 'in_app' AND status = 'sent')`,
    ),
    check('notification_deliveries_sent_at_chk', sql`status <> 'sent' OR sent_at IS NOT NULL`),
    check(
      'notification_deliveries_at_most_one_target_chk',
      sql`((CASE WHEN university_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_application_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN planner_task_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN planner_event_id IS NOT NULL THEN 1 ELSE 0 END)) <= 1`,
    ),
  ],
);
