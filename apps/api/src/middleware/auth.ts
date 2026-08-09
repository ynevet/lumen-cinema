import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors.js';
import { verifyToken } from '../services/authService.js';

export interface AuthenticatedUser {
  id: number;
  email: string;
  displayName: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/** Rejects the request unless it carries a valid `Authorization: Bearer <jwt>` header. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    next(AppError.unauthorized('Sign in to continue.'));
    return;
  }

  try {
    const payload = verifyToken(header.slice('Bearer '.length).trim());
    const id = Number(payload.sub);
    if (!Number.isInteger(id)) {
      next(AppError.unauthorized('Invalid session token.', 'INVALID_TOKEN'));
      return;
    }
    req.user = { id, email: payload.email, displayName: payload.name };
    next();
  } catch (error) {
    next(error);
  }
}

/** Narrow `req.user` for handlers mounted behind `requireAuth`. */
export function currentUser(req: Request): AuthenticatedUser {
  if (!req.user) {
    throw AppError.unauthorized();
  }
  return req.user;
}
