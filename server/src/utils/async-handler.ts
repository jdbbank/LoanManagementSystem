import { NextFunction, Request, RequestHandler, Response } from 'express';

/** Express 4 does not forward async errors — this wrapper does. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
