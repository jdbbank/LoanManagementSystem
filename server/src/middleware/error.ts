import { NextFunction, Request, Response } from 'express';
import { ZodError, ZodSchema } from 'zod';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

export function validateBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new AppError(400, 'Validation failed', result.error.flatten()));
      return;
    }
    req.body = result.data;
    next();
  };
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { message: 'Not found' } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { message: 'Validation failed', details: err.flatten() } });
    return;
  }
  // A unique index can still be hit after the pre-check (concurrent writes, soft-deleted rows).
  const duplicate = err as { code?: string; driverError?: { code?: string } };
  if (duplicate?.code === 'ER_DUP_ENTRY' || duplicate?.driverError?.code === 'ER_DUP_ENTRY') {
    res.status(409).json({ error: { message: 'That record already exists' } });
    return;
  }
  logger.error(`[unhandled error] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: { message: 'Internal server error' } });
}
