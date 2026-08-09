import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { closePool, waitForDatabase } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { runSeed } from './db/seed.js';
import { startExpirySweeper } from './jobs/expirySweeper.js';

async function main(): Promise<void> {
  logger.info({ env: config.NODE_ENV }, 'Starting cinema API');

  await waitForDatabase();
  if (config.RUN_MIGRATIONS) await runMigrations();
  if (config.RUN_SEED) await runSeed();

  const stopSweeper = startExpirySweeper();
  const server = createApp().listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'API listening');
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Shutting down');
    stopSweeper();
    server.close(() => {
      void closePool().finally(() => process.exit(0));
    });
    // Do not let a stuck connection block the container forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Fatal startup error');
  process.exit(1);
});
