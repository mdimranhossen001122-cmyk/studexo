import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';

export function getSafePath(req: Request): string {
  const raw = req.originalUrl || req.url || req.path || '/';
  const queryIndex = raw.indexOf('?');
  const pathOnly = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  return pathOnly || '/';
}

export function assignRequestId(req: Request, res: Response, next: NextFunction): void {
  const incomingId = req.header('x-request-id');
  const requestId =
    incomingId && /^[a-zA-Z0-9_-]{8,64}$/.test(incomingId)
      ? incomingId
      : crypto.randomUUID();

  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

export function createRequestCompletionLogger(logger: Logger) {
  return function requestCompletionLogger(req: Request, res: Response, next: NextFunction): void {
    const startNs = process.hrtime.bigint();

    res.on('finish', () => {
      const requestId = res.locals.requestId as string | undefined;
      const safePath = getSafePath(req);
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      const logPayload = {
        requestId,
        req: {
          method: req.method,
          path: safePath,
          ip: req.ip,
          userAgent: req.header('user-agent'),
        },
        res: {
          statusCode: res.statusCode,
        },
        durationMs: Math.round(durationMs * 100) / 100,
      };

      if (safePath === '/api/ready' && res.statusCode === 503) {
        logger.warn(logPayload, 'Readiness check returned degraded status');
      } else if (res.statusCode >= 500) {
        logger.error(logPayload, 'HTTP request failed');
      } else if (res.statusCode >= 400) {
        logger.warn(logPayload, 'HTTP request completed with client error');
      } else if (safePath === '/api' || safePath.startsWith('/api/')) {
        logger.info(logPayload, 'HTTP request completed');
      } else {
        logger.debug(logPayload, 'Static/asset request completed');
      }
    });

    next();
  };
}
