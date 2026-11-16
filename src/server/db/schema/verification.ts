import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  sourceReliabilityEnum,
  sourceTypeEnum,
  studexoSchema,
  verificationStatusEnum,
} from './enums';
import { users } from './identity';
import { institutions } from './institutions';
import { programmes } from './programmes';
import { scholarships } from './scholarships';

export const sources = studexoSchema.table(
  'sources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 200 }).notNull(),
    sourceType: sourceTypeEnum('source_type').notNull(),
    baseUrl: text('base_url').notNull(),
    reliabilityTier: sourceReliabilityEnum('reliability_tier')
      .notNull()
      .default('tier_1_official'),
    countryCode: varchar('country_code', { length: 2 }),
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('sources_base_url_uidx').on(table.baseUrl),
    index('sources_type_tier_idx').on(table.sourceType, table.reliabilityTier),
  ],
);

export const verificationClaims = studexoSchema.table(
  'verification_claims',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // RESTRICT prevents accidental deletion of catalog targets while provenance claims exist.
    institutionId: uuid('institution_id').references(() => institutions.id, {
      onDelete: 'restrict',
    }),
    programmeId: uuid('programme_id').references(() => programmes.id, {
      onDelete: 'restrict',
    }),
    scholarshipId: uuid('scholarship_id').references(() => scholarships.id, {
      onDelete: 'restrict',
    }),
    fieldPath: varchar('field_path', { length: 120 }).notNull(),
    claimedValue: jsonb('claimed_value').$type<unknown>(),
    status: verificationStatusEnum('status').notNull().default('pending_review'),
    verifiedByUserId: uuid('verified_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    supersededByClaimId: uuid('superseded_by_claim_id').references(
      (): AnyPgColumn => verificationClaims.id,
      { onDelete: 'restrict' },
    ),
    supersededAt: timestamp('superseded_at', { withTimezone: true, mode: 'date' }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('verification_claims_institution_id_idx').on(table.institutionId),
    index('verification_claims_programme_id_idx').on(table.programmeId),
    index('verification_claims_scholarship_id_idx').on(table.scholarshipId),
    index('verification_claims_status_idx').on(table.status),
    index('verification_claims_field_status_idx').on(table.fieldPath, table.status),
    uniqueIndex('verification_claims_superseded_by_uidx')
      .on(table.supersededByClaimId)
      .where(sql`superseded_by_claim_id IS NOT NULL`),
    check(
      'verification_claims_single_target_chk',
      sql`((CASE WHEN institution_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN programme_id IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN scholarship_id IS NOT NULL THEN 1 ELSE 0 END)) = 1`,
    ),
    check(
      'verification_claims_not_self_superseded_chk',
      sql`superseded_by_claim_id IS NULL OR superseded_by_claim_id <> id`,
    ),
    check(
      'verification_claims_supersession_state_chk',
      sql`(status <> 'superseded' AND superseded_by_claim_id IS NULL AND superseded_at IS NULL) OR (status = 'superseded' AND superseded_by_claim_id IS NOT NULL AND superseded_at IS NOT NULL)`,
    ),
  ],
);

export const verificationEvidence = studexoSchema.table(
  'verification_evidence',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => verificationClaims.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'restrict' }),
    evidenceUrl: text('evidence_url').notNull(),
    excerpt: text('excerpt'),
    httpStatus: integer('http_status'),
    contentHash: varchar('content_hash', { length: 128 }),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('verification_evidence_claim_id_idx').on(table.claimId),
    index('verification_evidence_source_id_idx').on(table.sourceId),
    check(
      'verification_evidence_http_status_chk',
      sql`http_status IS NULL OR (http_status >= 100 AND http_status <= 599)`,
    ),
  ],
);
