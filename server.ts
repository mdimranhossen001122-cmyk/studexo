import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './src/server/app';
import { parseEnv } from './src/server/config/env';
import { closeDb } from './src/server/db/index';
import { createLogger } from './src/server/lib/logger';

function resolveDistClientDir(): string {
  const fromCwd = path.resolve(process.cwd(), 'dist', 'client');
  if (fs.existsSync(path.join(fromCwd, 'index.html'))) {
    return fromCwd;
  }

  const fromModule = path.resolve(import.meta.dirname, 'client');
  if (fs.existsSync(path.join(fromModule, 'index.html'))) {
    return fromModule;
  }

  return fromCwd;
}

async function bootstrap(): Promise<void> {
  const env = parseEnv(process.env);
  const logger = createLogger(env.runtime.logLevel);
  const isProduction = env.runtime.NODE_ENV === 'production';

  const { app, clientRouter } = createApp({ env, logger });
  let viteServer: { close: () => Promise<void> } | undefined;

  if (isProduction) {
    const clientDir = resolveDistClientDir();
    if (!fs.existsSync(path.join(clientDir, 'index.html'))) {
      logger.warn(
        { clientDir },
        'Production client build not found; API routes remain active.',
      );
    } else {
      clientRouter.use(express.static(clientDir, { index: false }));
      clientRouter.get('*', (_req, res, next) => {
        res.sendFile(path.join(clientDir, 'index.html'), (err) => {
          if (err) next(err);
        });
      });
    }
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      appType: 'spa',
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
        watch: process.env.DISABLE_HMR === 'true' ? null : {},
      },
    });
    viteServer = vite;
    clientRouter.use(vite.middlewares);
  }

  const server = app.listen(env.runtime.PORT, '0.0.0.0', () => {
    logger.info(
      {
        port: env.runtime.PORT,
        environment: env.runtime.NODE_ENV,
        allowedOriginsCount: env.runtime.allowedOrigins.length,
      },
      'Studexo server listening',
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Received shutdown signal, closing HTTP server');

    const forceExitTimer = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 10_000);
    forceExitTimer.unref();

    server.close(async (closeErr) => {
      if (closeErr) {
        logger.error({ err: closeErr }, 'Error closing HTTP server');
      }

      if (viteServer) {
        try {
          await viteServer.close();
        } catch (viteErr) {
          logger.error({ err: viteErr }, 'Error closing Vite dev server');
        }
      }

      try {
        await closeDb();
      } catch (dbErr) {
        logger.error({ err: dbErr }, 'Error closing database connection pool');
      }

      logger.info('Studexo server shut down cleanly');
      process.exit(closeErr ? 1 : 0);
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('Fatal server startup failure:', err);
  process.exit(1);
});
