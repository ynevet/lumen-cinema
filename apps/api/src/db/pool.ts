import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

const { Pool, types } = pg;

// `pg` hands back BIGINT/NUMERIC as strings to avoid precision loss. We only use
// INTEGER identity columns, and COUNT(*) results we genuinely want as numbers.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'cinema-api',
});

pool.on('error', (error) => {
  // Errors on *idle* clients would otherwise crash the process.
  logger.error({ err: error }, 'Unexpected error on idle Postgres client');
});

export type DbClient = pg.PoolClient;

/**
 * Minimal structural surface shared by `Pool` and `PoolClient`, so a query helper can
 * accept either "just run this" or "run this inside my transaction" without the caller
 * having to care.
 */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on any throw.
 * The client is always returned to the pool.
 */
export async function withTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error({ err: rollbackError }, 'Rollback failed');
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Block until Postgres accepts connections. Containers start out of order. */
export async function waitForDatabase(attempts = 30, delayMs = 1000): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const client = await pool.connect();
      client.release();
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      logger.warn({ attempt, attempts }, 'Database not ready yet, retrying');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
