import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Resolves identically from `src/db` (tsx) and `dist/db` (compiled).
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../db/migrations',
);

/**
 * Apply every pending migration in `db/migrations`.
 *
 * node-pg-migrate handles the parts that are easy to get subtly wrong: a ledger table, one
 * transaction per migration, ordering checks, and an advisory lock so two API replicas
 * starting at once cannot migrate concurrently. The migrations themselves stay as plain
 * `.sql` files, which is what makes the schema readable as a deliverable.
 */
export async function runMigrations(): Promise<void> {
  const applied = await runner({
    databaseUrl: config.DATABASE_URL,
    dir: MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations',
    direction: 'up',
    // node-pg-migrate logs plain strings; bridge them onto the structured logger.
    logger: {
      debug: (message: string) => logger.debug(message),
      info: (message: string) => logger.info(message),
      warn: (message: string) => logger.warn(message),
      error: (message: string) => logger.error(message),
    },
  });

  logger.info(
    { applied: applied.map((migration) => migration.name) },
    applied.length === 0 ? 'Schema already up to date' : 'Migrations applied',
  );
}
