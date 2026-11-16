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
import { institutionTypeEnum, studexoSchema, verificationStatusEnum } from './enums';

export const institutions = studexoSchema.table(
  'institutions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: varchar('slug', { length: 160 }).notNull(),
    name: varchar('name', { length: 240 }).notNull(),
    countryCode: varchar('country_code', { length: 2 }).notNull(),
    city: varchar('city', { length: 120 }),
    institutionType: institutionTypeEnum('institution_type').notNull().default('public'),
    officialWebsite: text('official_website'),
    qsWorldRank: integer('qs_world_rank'),
    verificationStatus: verificationStatusEnum('verification_status')
      .notNull()
      .default('unverified'),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true, mode: 'date' }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('institutions_slug_uidx').on(table.slug),
    index('institutions_country_active_idx').on(table.countryCode, table.isActive),
    index('institutions_verification_status_idx').on(table.verificationStatus),
    check('institutions_qs_rank_pos_chk', sql`qs_world_rank IS NULL OR qs_world_rank >= 1`),
  ],
);

export const institutionAliases = studexoSchema.table(
  'institution_aliases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    aliasName: varchar('alias_name', { length: 240 }).notNull(),
    aliasType: varchar('alias_type', { length: 32 }).notNull().default('common'),
    locale: varchar('locale', { length: 16 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('institution_aliases_inst_alias_uidx').on(table.institutionId, table.aliasName),
    index('institution_aliases_alias_name_idx').on(table.aliasName),
    check(
      'institution_aliases_type_chk',
      sql`alias_type IN ('acronym', 'local_name', 'former_name', 'common', 'translation')`,
    ),
  ],
);
