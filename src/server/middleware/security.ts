import cors from 'cors';
import type { Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import type { ApiErrorPayload } from '../../shared/types/api';
import type { AppEnv } from '../config/env';
import { AppError } from './errorHandler';

export function configureProxyTrust(app: Express, trustProxyHops: number): void {
  if (trustProxyHops > 0) {
    // Trust only the configured immediate reverse proxy hop count (e.g. Nginx / Cloud Run LB),
    // never `true`, to prevent client X-Forwarded-For spoofing.
    app.set('trust proxy', trustProxyHops);
  } else {
    app.set('trust proxy', false);
  }
}

export function createHelmetMiddleware(appEnv: AppEnv) {
  const isProduction = appEnv.runtime.NODE_ENV === 'production';
  const frameAncestors = appEnv.runtime.cspFrameAncestors;
  const hasExplicitFrameAncestors = frameAncestors.length > 0;
  const isHttpsAppUrl = Boolean(appEnv.runtime.APP_URL?.startsWith('https://'));

  return helmet({
    contentSecurityPolicy: isProduction
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            scriptSrcAttr: ["'none'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            fontSrc: ["'self'", 'data:', 'https:'],
            connectSrc: ["'self'", 'https:'],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: hasExplicitFrameAncestors ? frameAncestors : ["'none'"],
            // Only emit upgrade-insecure-requests when hosted on HTTPS so local HTTP
            // production smoke tests are not broken by forced HTTPS upgrades.
            upgradeInsecureRequests: isHttpsAppUrl ? [] : null,
          },
        }
      : false,
    crossOriginEmbedderPolicy: false,
    frameguard: isProduction
      ? hasExplicitFrameAncestors
        ? false
        : { action: 'deny' }
      : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
}

export function createCorsMiddleware(allowedOrigins: string[]) {
  const originSet = new Set(allowedOrigins);

  return cors({
    origin(origin, callback) {
      // Allow same-origin / server-to-server / curl requests without an Origin header.
      if (!origin) {
        callback(null, true);
        return;
      }

      if (originSet.has(origin)) {
        callback(null, true);
        return;
      }

      callback(
        new AppError(403, 'CORS_ORIGIN_DENIED', 'Origin is not permitted by CORS policy'),
      );
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    credentials: true,
    maxAge: 86400,
  });
}

export function createApiRateLimiter(appEnv: AppEnv, maxLimit?: number) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: maxLimit ?? (appEnv.runtime.NODE_ENV === 'test' ? 1000 : 120),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => req.path === '/health',
    handler: (_req, res) => {
      const requestId = res.locals.requestId as string | undefined;
      const payload: ApiErrorPayload = {
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests, please try again later.',
          ...(requestId ? { requestId } : {}),
        },
      };
      res.status(429).json(payload);
    },
  });
}
