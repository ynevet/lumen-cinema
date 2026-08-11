import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Works the same from `src/` (tsx) and `dist/` (compiled).
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A monorepo has one .env at the root; an app-local .env may override it. Real
// environment variables (Docker, CI) always win - dotenv never overwrites them.
loadDotenv({
  path: [path.join(packageRoot, '.env'), path.resolve(packageRoot, '../../.env')],
  quiet: true,
});

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_TTL_MINUTES: z.coerce.number().int().positive().default(720),

  /** How long a hold survives before it is released. The product rule is 15 minutes. */
  HOLD_MINUTES: z.coerce.number().int().positive().default(15),
  MAX_SEATS_PER_RESERVATION: z.coerce.number().int().positive().max(20).default(10),
  /** Cadence of the background sweeper that flips expired holds to `expired`. */
  EXPIRY_SWEEP_MS: z.coerce.number().int().min(1000).default(15_000),

  RUN_MIGRATIONS: booleanish.default('true'),
  RUN_SEED: booleanish.default('true'),

  /** Comma separated list, or `*` to allow any origin (dev convenience). */
  CORS_ORIGIN: z.string().default('*'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // Fail loudly and early: a half-configured server is worse than no server.
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const config = Object.freeze({
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  corsOrigins:
    parsed.data.CORS_ORIGIN === '*'
      ? ('*' as const)
      : parsed.data.CORS_ORIGIN.split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
});

export type Config = typeof config;
