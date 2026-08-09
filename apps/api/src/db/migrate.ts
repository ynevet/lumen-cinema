import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import { pool, withTransaction } from './pool.js';

// Resolves identically from `src/db` (tsx) and `dist/db` (compiled).
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

/** Arbitrary but fixed key, so two API replicas cannot migrate at the same time. */
const MIGRATION_LOCK_KEY = 4_815_162_342;

async function ensureLedger(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT        PRIMARY KEY,
      checksum    TEXT        NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function checksum(contents: string): string {
  return createHash('sha256').update(contents).digest('hex').slice(0, 32);
}

/**
 * Apply every `.sql` file in `db/migrations` that has not been applied yet, in
 * lexical order, each in its own transaction. Already-applied files are verified
 * against their recorded checksum so an edited migration is caught rather than
 * silently ignored.
 */
export async function runMigrations(): Promise<void> {
  await ensureLedger();

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((file) => file.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));

    const { rows } = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const applied = new Map(rows.map((row) => [row.filename, row.checksum]));

    let appliedCount = 0;
    for (const filename of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
      const hash = checksum(sql);
      const previous = applied.get(filename);

      if (previous !== undefined) {
        if (previous !== hash) {
          throw new Error(
            `Migration ${filename} was modified after it was applied. ` +
              'Create a new migration instead of editing an applied one.',
          );
        }
        continue;
      }

      logger.info({ filename }, 'Applying migration');
      await withTransaction(async (tx) => {
        await tx.query(sql);
        await tx.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          filename,
          hash,
        ]);
      });
      appliedCount += 1;
    }

    logger.info(
      { applied: appliedCount, total: files.length },
      appliedCount === 0 ? 'Schema already up to date' : 'Migrations applied',
    );
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
