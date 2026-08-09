import { config } from '../config.js';
import { logger } from '../logger.js';
import { releaseExpiredHolds } from '../services/reservationService.js';

/**
 * Periodically retires holds that have run out.
 *
 * Reads never see an expired hold to begin with, so this job is housekeeping rather
 * than the mechanism users depend on: it clears dead rows out of the partial unique
 * index so the seats are insertable again. `unref()` keeps it from holding the process
 * open during shutdown.
 */
export function startExpirySweeper(): () => void {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return; // never overlap runs
    running = true;
    try {
      const released = await releaseExpiredHolds();
      if (released > 0) {
        logger.info({ released }, 'Released expired holds');
      }
    } catch (error) {
      logger.error({ err: error }, 'Expiry sweep failed');
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), config.EXPIRY_SWEEP_MS);
  timer.unref();

  logger.info({ intervalMs: config.EXPIRY_SWEEP_MS }, 'Expiry sweeper started');
  return () => clearInterval(timer);
}
