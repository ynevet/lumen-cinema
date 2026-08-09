import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one database, so run files sequentially rather than
    // letting parallel workers fight over the same rows.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // Overridden by a real environment variable or the repo-root .env.
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://cinema:cinema@localhost:5432/cinema',
      JWT_SECRET: process.env.JWT_SECRET ?? 'test-only-secret-not-for-production',
      RUN_MIGRATIONS: 'false',
      RUN_SEED: 'false',
    },
  },
});
