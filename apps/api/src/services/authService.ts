import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { AuthResponse, PublicUser } from '@lumen/shared';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { AppError, PG_UNIQUE_VIOLATION, isPgError } from '../errors.js';

interface UserRow {
  id: number;
  email: string;
  display_name: string;
  password_hash: string;
}

export interface JwtPayload {
  sub: string;
  email: string;
  name: string;
}

const BCRYPT_ROUNDS = 10;

/**
 * Constant-ish time dummy hash. Comparing against this when the email is unknown
 * keeps login timing from revealing which addresses are registered.
 */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

function toPublicUser(row: UserRow): PublicUser {
  return { id: row.id, email: row.email, displayName: row.display_name };
}

function issueToken(user: PublicUser): AuthResponse {
  const expiresInSeconds = config.JWT_TTL_MINUTES * 60;
  const payload: JwtPayload = {
    sub: String(user.id),
    email: user.email,
    name: user.displayName,
  };
  const token = jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: expiresInSeconds,
    issuer: 'cinema-api',
  });
  return { token, expiresAt: Date.now() + expiresInSeconds * 1000, user };
}

export function verifyToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, config.JWT_SECRET, { issuer: 'cinema-api' }) as JwtPayload;
  } catch (error) {
    const expired = error instanceof jwt.TokenExpiredError;
    throw AppError.unauthorized(
      expired ? 'Your session has expired, please sign in again.' : 'Invalid session token.',
      expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
    );
  }
}

export async function register(input: {
  email: string;
  password: string;
  displayName: string;
}): Promise<AuthResponse> {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  try {
    const { rows } = await pool.query<UserRow>(
      `INSERT INTO users (email, display_name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name, password_hash`,
      [input.email.trim(), input.displayName.trim(), passwordHash],
    );
    return issueToken(toPublicUser(rows[0]!));
  } catch (error) {
    if (isPgError(error, PG_UNIQUE_VIOLATION)) {
      throw AppError.conflict('EMAIL_TAKEN', 'That email address is already registered.');
    }
    throw error;
  }
}

export async function login(input: { email: string; password: string }): Promise<AuthResponse> {
  const { rows } = await pool.query<UserRow>(
    `SELECT id, email, display_name, password_hash FROM users WHERE lower(email) = lower($1)`,
    [input.email.trim()],
  );

  const user = rows[0];
  const matches = await bcrypt.compare(input.password, user?.password_hash ?? DUMMY_HASH);

  if (!user || !matches) {
    throw AppError.unauthorized('Incorrect email or password.', 'INVALID_CREDENTIALS');
  }

  return issueToken(toPublicUser(user));
}

export async function findUserById(id: number): Promise<PublicUser | null> {
  const { rows } = await pool.query<UserRow>(
    `SELECT id, email, display_name, password_hash FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] ? toPublicUser(rows[0]) : null;
}
