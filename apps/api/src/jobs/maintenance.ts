import { config } from '../config.js';
import { logger } from '../logger.js';
import { ensureUpcomingScreenings } from '../db/seed.js';
import { releaseExpiredHolds } from '../services/reservationService.js';

/**
 * Periodic upkeep. Two jobs, both cheap and both no-ops most of the time.
 *
 * 1. Retire holds that have run out. Reads already ignore an expired hold, so this is not
 *    what makes expiry correct - it clears dead rows out of the partial unique index so
 *    the seats become insertable again.
 *
 * 2. Keep the programme stocked. Showtimes go stale with the wall clock, so a container
 *    left running past its last screening would otherwise end up with nothing to sell.
 *    This is demo-data upkeep, not something a real cinema would want, so it is gated
 *    behind RUN_SEED.
 *
 * `unref()` keeps the timer from holding the process open during shutdown.
 */
export function startMaintenance(): () => void {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return; // never overlap runs
    running = true;
    try {
      const released = await releaseExpiredHolds();
      if (released > 0) logger.info({ released }, 'Released expired holds');

      if (config.RUN_SEED) {
        const scheduled = await ensureUpcomingScreenings();
        if (scheduled > 0) logger.info({ scheduled }, 'Topped up the screening programme');
      }
    } catch (error) {
      logger.error({ err: error }, 'Maintenance tick failed');
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), config.EXPIRY_SWEEP_MS);
  timer.unref();

  logger.info({ intervalMs: config.EXPIRY_SWEEP_MS }, 'Maintenance job started');
  return () => clearInterval(timer);
}
