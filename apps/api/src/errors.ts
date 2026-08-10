/**
 * Every failure that reaches the client is an AppError. Anything else that escapes a
 * handler is logged with a stack trace and reported as a bare 500, so internal detail
 * never leaks into a response body.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static unauthorized(message = 'Authentication required.', code = 'UNAUTHENTICATED'): AppError {
    return new AppError(401, code, message);
  }

  static notFound(code: string, message: string): AppError {
    return new AppError(404, code, message);
  }

  static conflict(code: string, message: string, details?: unknown): AppError {
    return new AppError(409, code, message, details);
  }

  /** Syntactically fine, but the domain rules say no. */
  static unprocessable(code: string, message: string, details?: unknown): AppError {
    return new AppError(422, code, message, details);
  }
}

/** Postgres unique-violation. Our signal that another transaction won the race. */
export const PG_UNIQUE_VIOLATION = '23505';

export function isPgError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
