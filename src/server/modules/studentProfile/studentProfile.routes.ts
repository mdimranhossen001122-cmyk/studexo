import { Router } from 'express';
import {
  studentProfileResponseSchema,
  studentProfileUpdateRequestSchema,
} from '../../../shared/schemas/studentProfile.schema';
import { AuthError } from '../../../shared/types/auth';
import type { AppEnv } from '../../config/env';
import { getDb } from '../../db/index';
import {
  mapDatabaseErrorToHttpError,
  type AuthMiddlewarePipeline,
} from '../../middleware/auth';
import { createPostgresStudentProfileRepository } from './studentProfile.repository';
import {
  createStudentProfileService,
  type StudentProfileService,
} from './studentProfile.service';

export interface CreateStudentProfileRouterOptions {
  authMiddleware: AuthMiddlewarePipeline;
  env: AppEnv;
  studentProfileService?: StudentProfileService;
}

export function createStudentProfileRouter(
  options: CreateStudentProfileRouterOptions,
): Router {
  const router = Router();
  const { authMiddleware, env } = options;

  let cachedService: StudentProfileService | undefined = options.studentProfileService;
  const getService = (): StudentProfileService => {
    if (cachedService) {
      return cachedService;
    }
    const db = getDb(env);
    cachedService = createStudentProfileService(createPostgresStudentProfileRepository(db));
    return cachedService;
  };

  router.get('/profile', ...authMiddleware.requireStudent, (req, res, next) => {
    void (async () => {
      const user = req.user;
      if (!user) {
        throw new AuthError(
          'AUTH_UNAUTHENTICATED',
          'Authenticated student context is required.',
        );
      }

      let profile;
      try {
        profile = await getService().getProfile(user.id);
      } catch (err: unknown) {
        throw mapDatabaseErrorToHttpError(err);
      }

      const payload = studentProfileResponseSchema.parse(profile);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(payload);
    })().catch(next);
  });

  router.put('/profile', ...authMiddleware.requireStudent, (req, res, next) => {
    void (async () => {
      const user = req.user;
      if (!user) {
        throw new AuthError(
          'AUTH_UNAUTHENTICATED',
          'Authenticated student context is required.',
        );
      }

      const validatedBody = studentProfileUpdateRequestSchema.parse(req.body);

      let updated;
      try {
        updated = await getService().saveProfile(user.id, validatedBody);
      } catch (err: unknown) {
        throw mapDatabaseErrorToHttpError(err);
      }

      const payload = studentProfileResponseSchema.parse(updated);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(payload);
    })().catch(next);
  });

  return router;
}
