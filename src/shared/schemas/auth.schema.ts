import { z } from 'zod';

function normalizeDisplayNameInput(value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeOptionalStringInput(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function normalizeOptionalCurrencyInput(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim().toUpperCase();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Strict request schema for `POST /api/auth/sync`.
 * Accepts only non-privileged initial profile preferences (`displayName`, `preferredLocale`,
 * `preferredCurrency`, `timezone`). Unknown or privileged fields (`role`, `status`,
 * `supabaseAuthUserId`, `primaryEmail`, `purgeState`, `id`) are rejected with 400 VALIDATION_ERROR.
 */
export const authSyncRequestSchema = z
  .object({
    displayName: z.preprocess(
      normalizeDisplayNameInput,
      z
        .string()
        .refine(
          (val) => Array.from(val).length <= 160,
          'Display name must be at most 160 characters',
        )
        .nullable()
        .optional(),
    ),
    preferredLocale: z.preprocess(
      normalizeOptionalStringInput,
      z
        .string()
        .min(1)
        .max(16)
        .regex(/^[A-Za-z0-9_-]+$/, 'Invalid locale format')
        .optional(),
    ),
    preferredCurrency: z.preprocess(
      normalizeOptionalCurrencyInput,
      z
        .string()
        .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code')
        .optional(),
    ),
    timezone: z.preprocess(
      normalizeOptionalStringInput,
      z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9_/+.-]+$/, 'Invalid timezone format')
        .optional(),
    ),
  })
  .strict();

export type AuthSyncRequest = z.infer<typeof authSyncRequestSchema>;

/**
 * Sanitized internal user DTO exposed by authentication endpoints.
 * Deliberately excludes `supabaseAuthUserId`, `purgeState`, `purge_*`, `deletion_*`,
 * provider subject IDs, and raw metadata.
 */
export const authPublicUserSchema = z
  .object({
    id: z.string().min(1),
    primaryEmail: z.string().email(),
    displayName: z.string().nullable(),
    role: z.enum(['student', 'counselor', 'admin']),
    status: z.enum(['active', 'suspended', 'pending_deletion']),
  })
  .strict();

export type AuthPublicUser = z.infer<typeof authPublicUserSchema>;

export const authPublicIdentitySchema = z
  .object({
    provider: z.enum(['supabase_email', 'google', 'github']),
    emailVerified: z.boolean(),
  })
  .strict();

export type AuthPublicIdentity = z.infer<typeof authPublicIdentitySchema>;

export const authAccountSettingsSchema = z
  .object({
    preferredLocale: z.string().min(1).max(16),
    preferredCurrency: z.string().min(1).max(3),
    timezone: z.string().min(1).max(64),
    marketingOptIn: z.boolean(),
  })
  .strict();

export type AuthAccountSettingsDto = z.infer<typeof authAccountSettingsSchema>;

export const authSyncResponseSchema = z
  .object({
    user: authPublicUserSchema,
    identities: z.array(authPublicIdentitySchema),
    settings: authAccountSettingsSchema.nullable(),
  })
  .strict();

export type AuthSyncResponse = z.infer<typeof authSyncResponseSchema>;

export const authMeResponseSchema = z
  .object({
    user: authPublicUserSchema,
  })
  .strict();

export type AuthMeResponse = z.infer<typeof authMeResponseSchema>;
