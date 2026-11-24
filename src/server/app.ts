import express, { type Express, type Router } from 'express';
import type { Logger } from 'pino';
import { parseEnv, type AppEnv } from './config/env';
import { createLogger } from './lib/logger';
import {
  createAppAuthMiddleware,
  type AuthMiddlewareDependencies,
  type AuthMiddlewarePipeline,
} from './middleware/auth';
import { apiNotFoundHandler, createErrorHandler } from './middleware/errorHandler';
import {
  assignRequestId,
  createRequestCompletionLogger,
} from './middleware/requestLogger';
import {
  configureProxyTrust,
  createApiRateLimiter,
  createCorsMiddleware,
  createHelmetMiddleware,
} from './middleware/security';
import { createAuthRouter } from './modules/auth/auth.routes';
import {
  createHealthRouter,
  type DatabaseReadinessProbe,
} from './modules/health/health.routes';
import { createStudentProfileRouter } from './modules/studentProfile/studentProfile.routes';
import type { StudentProfileService } from './modules/studentProfile/studentProfile.service';

export interface CreateAppOptions {
  env?: AppEnv;
  logger?: Logger;
  clientRouter?: Router;
  apiRouter?: Router;
  rateLimitMax?: number;
  checkDatabaseReadiness?: DatabaseReadinessProbe;
  authDependencies?: AuthMiddlewareDependencies;
  studentProfileService?: StudentProfileService;
}

export interface AppContext {
  app: Express;
  env: AppEnv;
  logger: Logger;
  clientRouter: Router;
  apiRouter: Router;
  authMiddleware: AuthMiddlewarePipeline;
}

export function createApp(options: CreateAppOptions = {}): AppContext {
  const env = options.env ?? parseEnv(process.env);
  const logger = options.logger ?? createLogger(env.runtime.logLevel);
  const clientRouter = options.clientRouter ?? express.Router();
  const apiRouter = options.apiRouter ?? express.Router();
  const authMiddleware = createAppAuthMiddleware(env, options.authDependencies);
  const isProduction = env.runtime.NODE_ENV === 'production';

  const app = express();
  app.disable('x-powered-by');
  configureProxyTrust(app, env.runtime.TRUST_PROXY_HOPS);

  // Assign request ID and attach completion logger before CORS or body parsers
  // so 403 CORS rejections, 413 payload limits, and 400 malformed JSON always
  // receive X-Request-Id, error.requestId, and structured completion logs.
  app.use(assignRequestId);
  app.use(createRequestCompletionLogger(logger));

  app.use(createHelmetMiddleware(env));
  app.use(createCorsMiddleware(env.runtime.allowedOrigins));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  // Initial API routes (rate limited, with public health/readiness probes above protected routes)
  app.use('/api', createApiRateLimiter(env, options.rateLimitMax));
  app.use(
    '/api',
    createHealthRouter(env, {
      checkDatabaseReadiness: options.checkDatabaseReadiness,
    }),
  );
  app.use('/api/auth', createAuthRouter({ authMiddleware }));
  app.use(
    '/api/student',
    createStudentProfileRouter({
      authMiddleware,
      env,
      studentProfileService: options.studentProfileService,
    }),
  );
  app.use('/api', apiRouter);
  app.use('/api', apiNotFoundHandler);

  // Client SPA / Vite middleware slot (populated by server.ts)
  app.use(clientRouter);

  // Centralized error serialization (always final middleware)
  app.use(createErrorHandler({ logger, isProduction }));

  return { app, env, logger, clientRouter, apiRouter, authMiddleware };
}
