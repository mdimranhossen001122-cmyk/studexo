/**
 * Studexo Authentication HTTP Routes (Phase 8B.5A Milestone 4)
 *
 * Exposes:
 * - POST `/api/auth/sync` — Tier 1B authoritative session verification + concurrency-safe provisioning / returning sync.
 * - GET `/api/auth/me`    — Tier 1A + Tier 2 DB-backed active user profile retrieval.
 *
 * Security invariants:
 * - Never trusts client-supplied roles, status, UUIDs, or metadata.
 * - Validates request inputs and sanitizes all outgoing responses via strict Zod schemas.
 * - Preserves lazy database initialization and consistent DB/provider outage mapping.
 */

import { Router } from 'express';
import {
  authMeResponseSchema,
  authSyncRequestSchema,
  authSyncResponseSchema,
} from '../../../shared/schemas/auth.schema';
import { AuthError } from '../../../shared/types/auth';
import {
  mapDatabaseErrorToHttpError,
  type AuthMiddlewarePipeline,
} from '../../middleware/auth';

export interface CreateAuthRouterOptions {
  authMiddleware: AuthMiddlewarePipeline;
}

export function createAuthRouter(options: CreateAuthRouterOptions): Router {
  const router = Router();
  const { authMiddleware } = options;

  router.post('/sync', authMiddleware.requireAuthoritativeSession, (req, res, next) => {
    void (async () => {
      const authoritativeUser = req.authoritativeUser;
      if (!authoritativeUser) {
        throw new AuthError(
          'AUTH_UNAUTHENTICATED',
          'Authoritative session verification is required before synchronization.',
        );
      }

      const rawBody = req.body === undefined ? {} : req.body;
      const preferences = authSyncRequestSchema.parse(rawBody);

      let record;
      try {
        const authService = authMiddleware.getAuthService();
        record = await authService.syncAndProvisionUser(authoritativeUser, preferences);
      } catch (err: unknown) {
        throw mapDatabaseErrorToHttpError(err);
      }

      const payload = authSyncResponseSchema.parse({
        user: {
          id: record.user.id,
          primaryEmail: record.user.primaryEmail,
          displayName: record.user.displayName,
          role: record.user.role,
          status: record.user.status,
        },
        identities: record.identities.map((ident) => ({
          provider: ident.provider,
          emailVerified: ident.emailVerified,
        })),
        settings: record.settings
          ? {
              preferredLocale: record.settings.preferredLocale,
              preferredCurrency: record.settings.preferredCurrency,
              timezone: record.settings.timezone,
              marketingOptIn: record.settings.marketingOptIn,
            }
          : null,
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(payload);
    })().catch(next);
  });

  router.get('/me', ...authMiddleware.requireAuth, (req, res, next) => {
    const user = req.user;
    if (!user) {
      next(
        new AuthError(
          'AUTH_UNAUTHENTICATED',
          'Authenticated user context is required.',
        ),
      );
      return;
    }

    const payload = authMeResponseSchema.parse({
      user: {
        id: user.id,
        primaryEmail: user.primaryEmail,
        displayName: user.displayName,
        role: user.role,
        status: user.status,
      },
    });

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(payload);
  });

  return router;
}
