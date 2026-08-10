import { rateLimit } from 'express-rate-limit';
import type { Request, Response } from 'express';
import type { ApiErrorBody } from '@lumen/shared';
import { logger } from '../logger.js';

/** Rate-limit rejections use the same envelope as every other error. */
function tooManyRequests(code: string, message: string) {
  return (req: Request, res: Response): void => {
    logger.warn({ ip: req.ip, path: req.path }, 'Rate limit exceeded');
    const body: ApiErrorBody = { error: { code, message } };
    res.status(429).json(body);
  };
}

/**
 * Credential stuffing guard.
 *
 * `skipSuccessfulRequests` means only *failed* attempts count, so someone signing in
 * normally is never locked out - the budget is spent solely on wrong passwords.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: tooManyRequests(
    'TOO_MANY_ATTEMPTS',
    'Too many failed sign-in attempts. Try again in a few minutes.',
  ),
});

/**
 * Backstop for the rest of the API. Deliberately generous: the seat map is polled every
 * four seconds per open tab, so this should only ever catch genuine abuse.
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1500,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: tooManyRequests('TOO_MANY_REQUESTS', 'Too many requests. Please slow down.'),
});
