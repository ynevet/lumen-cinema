import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '@lumen/shared';
import { AppError } from '../errors.js';
import { logger } from '../logger.js';

export function notFoundHandler(req: Request, res: Response): void {
  const body: ApiErrorBody = {
    error: { code: 'ROUTE_NOT_FOUND', message: `Cannot ${req.method} ${req.path}` },
  };
  res.status(404).json(body);
}

/**
 * Single exit point for every failure. Express 5 forwards rejected async handlers here
 * automatically, so route code can just `throw`.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof ZodError) {
    const body: ApiErrorBody = {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'The request body is not valid.',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    };
    res.status(400).json(body);
    return;
  }

  if (error instanceof AppError) {
    // 5xx means we broke something; 4xx means the caller did. Only log the former loudly.
    const log = error.status >= 500 ? logger.error : logger.debug;
    log.call(logger, { err: error, code: error.code, path: req.path }, 'Request failed');

    const body: ApiErrorBody = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
    res.status(error.status).json(body);
    return;
  }

  logger.error({ err: error, path: req.path, method: req.method }, 'Unhandled error');
  const body: ApiErrorBody = {
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side.' },
  };
  res.status(500).json(body);
}
