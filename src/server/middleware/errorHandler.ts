import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import type { ApiErrorPayload } from '../../shared/types/api';
import { getSafePath } from './requestLogger';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;
  public readonly details?: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options?: { isOperational?: boolean; details?: unknown },
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = options?.isOperational ?? statusCode < 500;
    this.details = options?.details;
  }
}

export function apiNotFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(
    new AppError(404, 'NOT_FOUND', `API route ${req.method} ${getSafePath(req)} was not found`),
  );
}

interface BodyParserError extends Error {
  status?: number;
  type?: string;
}

function isBodyParserError(err: unknown): err is BodyParserError {
  return err instanceof Error && typeof (err as BodyParserError).type === 'string';
}

export function createErrorHandler(options: { logger: Logger; isProduction: boolean }) {
  const { logger, isProduction } = options;

  return function errorHandler(
    err: unknown,
    req: Request,
    res: Response,
    _next: NextFunction,
  ): void {
    const requestId = res.locals.requestId as string | undefined;
    const safePath = getSafePath(req);

    if (err instanceof AppError) {
      if (err.statusCode >= 500) {
        logger.error({ err, requestId, path: safePath, code: err.code }, err.message);
      } else {
        logger.warn(
          { code: err.code, statusCode: err.statusCode, requestId, path: safePath },
          err.message,
        );
      }

      const payload: ApiErrorPayload = {
        error: {
          code: err.code,
          message: isProduction && err.statusCode >= 500 ? 'Internal server error' : err.message,
          ...(requestId ? { requestId } : {}),
          ...(!isProduction && err.details !== undefined ? { details: err.details } : {}),
        },
      };
      res.status(err.statusCode).json(payload);
      return;
    }

    if (err instanceof ZodError) {
      logger.warn({ issues: err.issues, requestId, path: safePath }, 'Validation error');
      const payload: ApiErrorPayload = {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          ...(requestId ? { requestId } : {}),
          details: err.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      };
      res.status(400).json(payload);
      return;
    }

    if (isBodyParserError(err) && err.type === 'entity.too.large') {
      const payload: ApiErrorPayload = {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request body exceeds the 100kb limit',
          ...(requestId ? { requestId } : {}),
        },
      };
      res.status(413).json(payload);
      return;
    }

    if (isBodyParserError(err) && err.type === 'entity.parse.failed') {
      const payload: ApiErrorPayload = {
        error: {
          code: 'INVALID_JSON',
          message: 'Malformed JSON request payload',
          ...(requestId ? { requestId } : {}),
        },
      };
      res.status(400).json(payload);
      return;
    }

    logger.error({ err, requestId, path: safePath, method: req.method }, 'Unhandled error');

    const payload: ApiErrorPayload = {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: isProduction
          ? 'An unexpected internal error occurred'
          : err instanceof Error
            ? err.message
            : 'Unknown error',
        ...(requestId ? { requestId } : {}),
      },
    };
    res.status(500).json(payload);
  };
}
