import { Router } from 'express';
import {
  healthResponseSchema,
  readyResponseSchema,
} from '../../../shared/schemas/health.schema';
import { getIntegrationReadiness, type AppEnv } from '../../config/env';
import {
  checkDatabaseReadiness,
  type DatabaseReadinessResult,
} from '../../db/index';

export type DatabaseReadinessProbe = (appEnv: AppEnv) => Promise<DatabaseReadinessResult>;

export interface CreateHealthRouterOptions {
  checkDatabaseReadiness?: DatabaseReadinessProbe;
}

export function createHealthRouter(
  appEnv: AppEnv,
  options: CreateHealthRouterOptions = {},
): Router {
  const router = Router();
  const probeDatabase =
    options.checkDatabaseReadiness ?? ((env: AppEnv) => checkDatabaseReadiness(env));

  router.get('/health', (_req, res) => {
    const payload = healthResponseSchema.parse({
      status: 'ok',
      service: 'studexo-api',
      environment: appEnv.runtime.NODE_ENV,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime() * 100) / 100,
    });

    res.status(200).json(payload);
  });

  router.get('/ready', async (_req, res) => {
    const readiness = getIntegrationReadiness(appEnv);
    let dbStatus: DatabaseReadinessResult;

    try {
      dbStatus = await probeDatabase(appEnv);
    } catch {
      dbStatus = {
        configured: readiness.databaseConfigured,
        connected: false,
      };
    }

    const isReady = readiness.runtimeConfigured && dbStatus.configured && dbStatus.connected;

    const payload = readyResponseSchema.parse({
      status: isReady ? 'ok' : 'degraded',
      runtime: {
        configured: readiness.runtimeConfigured,
        nodeVersion: process.version,
      },
      integrations: {
        database: {
          configured: dbStatus.configured,
          connected: dbStatus.connected,
        },
        supabase: {
          configured: readiness.supabaseConfigured,
          verified: false,
        },
        gemini: {
          configured: readiness.geminiConfigured,
          verified: false,
        },
      },
      timestamp: new Date().toISOString(),
    });

    res.status(isReady ? 200 : 503).json(payload);
  });

  return router;
}
